import { auth, db, isFirebaseAvailable } from './firebase';
import { supabaseDb, type SupabaseTableName } from './supabase';
import { FirestoreSyncTransport } from './firestoreSyncTransport';
import {
  SyncCoordinator,
  type DurableSyncMutation,
  type EnqueueSyncMutation,
  type SyncCoordinatorLifecycle,
  type SyncCoordinatorSnapshot,
  type SyncDeleteOperation,
  type SyncOperation,
  type SyncMutationPreparer,
  type SyncableCollection,
  type SyncSetOperation,
  validateSyncMutation,
  validateSyncMutationForDurability,
} from './syncCoordinator';
import { IndexedDbSyncQueueStore } from './syncQueueStore';
import {
  expectationForDocument,
  fingerprintDocument,
  stripSyncMetadata,
  type SyncExpectation,
  type SyncStateToken,
} from '../utils/syncProtocol';
import type { ConfirmedSyncDocumentState } from '../utils/syncReconciliation';
import {
  persistSyncHandoff,
  readSyncHandoffsForUser,
  removeSyncHandoff,
  type DurableSyncHandoff,
} from '../utils/syncHandoff';
import {
  classifyLegacyP3AuditEnvelopeForV4,
  upgradeLegacyP3AuditEnvelope,
} from '../utils/legacyAuditMigration';
import { auditReceiptAfterPayload, estimateFirestoreWriteFootprint } from '../utils/receiptProtocol';
import { rebaseAuditedEnvelopeForConflict } from '../utils/auditedConflictRecovery';
import { selectLeastSafeSyncError, type SyncErrorPersistence } from './syncPersistenceState';
import { assertDomainProofPayload, assertSettingsDocumentProof } from '../utils/productSchema';

export interface AppSyncSnapshot extends SyncCoordinatorSnapshot {
  staging: number;
  enqueueError: string | null;
  /** m-RT-08: whether the work behind `enqueueError` is durably persisted locally (null/absent = no evidence). */
  enqueueErrorPersistence?: SyncErrorPersistence | null;
}

type AppSyncListener = (snapshot: AppSyncSnapshot) => void;

type AppSyncEnqueueState = 'not-persisted' | 'recovery-required';

const tagAppSyncEnqueueError = (error: unknown, state: AppSyncEnqueueState): Error & { appSyncEnqueueState: AppSyncEnqueueState } => {
  const tagged = error instanceof Error ? error : new Error(String(error));
  return Object.assign(tagged, { appSyncEnqueueState: state });
};

export const appSyncEnqueueState = (error: unknown): AppSyncEnqueueState | null => {
  if (!error || typeof error !== 'object' || !('appSyncEnqueueState' in error)) return null;
  const state = (error as { appSyncEnqueueState?: unknown }).appSyncEnqueueState;
  return state === 'not-persisted' || state === 'recovery-required' ? state : null;
};

const CONFIRMED_STATE_KEY = 'remix_sync_confirmed_docs_v2';
const listeners = new Set<AppSyncListener>();
interface StagingEntry {
  userId: string;
  generation: number;
  keys: Set<string>;
  error: string | null;
  errorPersistence?: SyncErrorPersistence;
}

export interface AppSyncIssue {
  id: string;
  status: 'conflict' | 'blocked' | 'quarantined';
  label?: string;
  lastError?: string;
  documentKeys: string[];
}

const stagingEntries = new Map<string, StagingEntry>();
const inFlightEnqueues = new Map<Promise<unknown>, string>();
let coordinator: SyncCoordinator | null = null;
let sequence = 0;
let enqueueError: string | null = null;
let enqueueErrorUserId: string | null = null;
let enqueueErrorGeneration: number | null = null;
let enqueueErrorPersistence: SyncErrorPersistence | null = null;
let latestCoordinatorSnapshot: SyncCoordinatorSnapshot = {
  activeUserId: null,
  online: typeof navigator === 'undefined' || navigator.onLine,
  flushing: false,
  pending: 0,
  retrying: 0,
  conflicts: 0,
  blocked: 0,
  quarantined: 0,
  lastError: null,
};

const prepareLegacyP3AuditInput: SyncMutationPreparer = (input, context) =>
  upgradeLegacyP3AuditEnvelope(input, context);

const emit = () => {
  const snapshot = getAppSyncSnapshot();
  for (const listener of listeners) listener(snapshot);
};

const ensureCoordinator = (): SyncCoordinator => {
  if (!isFirebaseAvailable || !db || !auth) throw new Error('SYNC_FIREBASE_UNAVAILABLE');
  if (!coordinator) {
    coordinator = new SyncCoordinator(
      new IndexedDbSyncQueueStore(),
      new FirestoreSyncTransport(db, auth),
      {
        prepareInput: prepareLegacyP3AuditInput,
        onMutationCommitted: mutation => {
          for (const operation of mutation.operations) {
            const state = operation.kind === 'delete'
              ? undefined
              : {
                  fingerprint: fingerprintDocument(operation.value),
                  revision: operation.expected.kind === 'present'
                    ? (operation.expected.stateToken?.revision ?? operation.expected.revision ?? 0) + 1
                    : 1,
                  mutationId: mutation.id,
                };
            setConfirmedSyncStateForUser(
              mutation.userId,
              operation.collection,
              operation.docId,
              state,
            );
          }
        },
      },
    );
    coordinator.subscribe(snapshot => {
      latestCoordinatorSnapshot = snapshot;
      emit();
    });
  }
  return coordinator;
};

const cleanUndefined = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  if (typeof (value as { toDate?: unknown }).toDate === 'function') return value;
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : cleanUndefined(item));
  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested !== undefined) clean[key] = cleanUndefined(nested);
  }
  return clean;
};

const persistHandoff = (handoff: DurableSyncHandoff): void => {
  persistSyncHandoff(localStorage, handoff);
};

const removeHandoff = (userId: string, id: string): void => {
  removeSyncHandoff(localStorage, userId, id);
};

const readUserHandoffs = (userId: string): DurableSyncHandoff[] => {
  return readSyncHandoffsForUser(localStorage, userId, validateSyncMutation);
};

const isAppSyncLifecycleCurrent = (
  activeCoordinator: SyncCoordinator,
  userId: string,
  generation: number,
): boolean => coordinator === activeCoordinator
  && auth?.currentUser?.uid === userId
  && activeCoordinator.isLifecycleCurrent(userId, generation);

const assertAppSyncLifecycleCurrent = (
  activeCoordinator: SyncCoordinator,
  userId: string,
  generation: number,
): void => {
  if (!isAppSyncLifecycleCurrent(activeCoordinator, userId, generation)) {
    throw new Error('SYNC_SESSION_SUPERSEDED');
  }
};

const recoverUserHandoffs = async (
  userId: string,
  activeCoordinator = ensureCoordinator(),
  generation = activeCoordinator.getLifecycle().generation,
): Promise<void> => {
  assertAppSyncLifecycleCurrent(activeCoordinator, userId, generation);
  for (const handoff of readUserHandoffs(userId)) {
    assertAppSyncLifecycleCurrent(activeCoordinator, userId, generation);
    stagingEntries.set(handoff.id, {
      userId,
      generation,
      keys: new Set(handoff.input.operations.map(operation => `${operation.collection}/${operation.docId}`)),
      error: null,
    });
    emit();
    try {
      assertAppSyncLifecycleCurrent(activeCoordinator, userId, generation);
      await activeCoordinator.enqueue(handoff.input, {
        id: handoff.id,
        createdAt: handoff.createdAt,
        scheduleFlush: false,
        expectedUserId: userId,
        // A handoff is already durable. Preserve an invalid/obsolete one as a visible quarantine
        // instead of leaving it indefinitely outside the coordinator issue model.
        legacyRecovery: true,
        syncProtocolVersion: handoff.version === 2 ? 4 : undefined,
      });
      assertAppSyncLifecycleCurrent(activeCoordinator, userId, generation);
      const recoveredIssue = await activeCoordinator.getIssue(handoff.id);
      assertAppSyncLifecycleCurrent(activeCoordinator, userId, generation);
      if (recoveredIssue?.status !== 'quarantined') {
        const preparedInput = prepareLegacyP3AuditInput(handoff.input, {
          mutationId: handoff.id,
          userId,
          createdAt: handoff.createdAt,
        });
        for (const operation of preparedInput.operations) {
          const state = operation.kind === 'delete'
            ? undefined
            : {
                fingerprint: fingerprintDocument(operation.value),
                revision: operation.expected.kind === 'present'
                  ? (operation.expected.stateToken?.revision ?? operation.expected.revision ?? 0) + 1
                  : 1,
                mutationId: handoff.id,
              };
          setConfirmedSyncStateForUser(userId, operation.collection, operation.docId, state);
        }
      }
      removeHandoff(userId, handoff.id);
      stagingEntries.delete(handoff.id);
      emit();
    } catch (error) {
      if (!isAppSyncLifecycleCurrent(activeCoordinator, userId, generation)) {
        throw new Error('SYNC_SESSION_SUPERSEDED');
      }
      const message = error instanceof Error ? error.message : String(error);
      const entry = stagingEntries.get(handoff.id);
      if (entry) { entry.error = message; entry.errorPersistence = 'persisted'; }
      enqueueError = message;
      enqueueErrorUserId = userId;
      enqueueErrorGeneration = generation;
      enqueueErrorPersistence = 'persisted'; // the idempotent handoff/outbox record is retained; only delivery failed
      emit();
      throw error;
    }
  }
};

const syncExpectationWithCapacityProof = (
  collection: SyncableCollection,
  docId: string,
  previousValue: unknown,
  authoritativeState?: SyncStateToken,
): SyncExpectation => {
  const expected = expectationForDocument(previousValue, authoritativeState);
  if (expected.kind !== 'present') return expected;
  const cleanBaseline = stripSyncMetadata(previousValue) as Record<string, unknown>;
  const sizedBaseline = expected.stateToken ? {
    ...cleanBaseline,
    __sync: {
      ...expected.stateToken,
      auditId: 'x'.repeat(256),
      updatedBy: 'x'.repeat(128),
      updatedAt: new Date(0),
    },
  } : cleanBaseline;
  expected.baselineRequestBytes = estimateFirestoreWriteFootprint(
    `${collection}/${docId}`,
    sizedBaseline,
  );
  return expected;
};

export const createSyncSetOperation = (
  collection: SyncableCollection,
  docId: string,
  value: Record<string, unknown>,
  previousValue: unknown,
): SyncSetOperation => {
  const confirmed = getConfirmedSyncState(collection, docId);
  const authoritativeState = confirmed?.mutationId && confirmed.revision > 0
    ? { revision: confirmed.revision, mutationId: confirmed.mutationId }
    : undefined;
  const expected = syncExpectationWithCapacityProof(collection, docId, previousValue, authoritativeState);
  const cleanValue = cleanUndefined(value) as Record<string, unknown>;
  // Common pre-journal enforcement for every P3/P6/P7 business producer. UI validation remains a
  // clearer first line, but direct service callers cannot bypass this product contract.
  if (collection === 'settings') {
    assertSettingsDocumentProof(docId, cleanValue);
  } else {
    assertDomainProofPayload(
      collection,
      collection === 'audit_logs' ? auditReceiptAfterPayload(cleanValue) : cleanValue,
    );
  }
  return {
    kind: 'set',
    collection,
    docId,
    value: cleanValue,
    expected,
  };
};

export const createSyncDeleteOperation = (
  collection: SyncableCollection,
  docId: string,
  previousValue: unknown,
): SyncDeleteOperation => {
  if (previousValue === null || previousValue === undefined) {
    throw new Error(`SYNC_DELETE_BASELINE_REQUIRED:${collection}/${docId}`);
  }
  const confirmed = getConfirmedSyncState(collection, docId);
  const authoritativeState = confirmed?.mutationId && confirmed.revision > 0
    ? { revision: confirmed.revision, mutationId: confirmed.mutationId }
    : undefined;
  const expected = syncExpectationWithCapacityProof(collection, docId, previousValue, authoritativeState);
  return {
    kind: 'delete',
    collection,
    docId,
    expected,
  };
};

export async function startAppSync(userId: string): Promise<void> {
  const firebaseUid = auth?.currentUser?.uid;
  if (!firebaseUid || firebaseUid !== userId) throw new Error('SYNC_SESSION_IDENTITY_MISMATCH');
  const activeCoordinator = ensureCoordinator();
  await activeCoordinator.start(userId, false);
  const lifecycle = activeCoordinator.getLifecycle();
  if (lifecycle.userId !== userId) throw new Error('SYNC_SESSION_SUPERSEDED');
  assertAppSyncLifecycleCurrent(activeCoordinator, userId, lifecycle.generation);
  await recoverUserHandoffs(userId);
  assertAppSyncLifecycleCurrent(activeCoordinator, userId, lifecycle.generation);
  await activeCoordinator.notifyConnectivityChanged();
  assertAppSyncLifecycleCurrent(activeCoordinator, userId, lifecycle.generation);
  const recoveredErrorEntry = [...stagingEntries.values()].find(
    entry => entry.userId === userId && entry.generation === lifecycle.generation && entry.error,
  );
  enqueueError = recoveredErrorEntry?.error || null;
  enqueueErrorUserId = enqueueError ? userId : null;
  enqueueErrorGeneration = enqueueError ? lifecycle.generation : null;
  enqueueErrorPersistence = enqueueError ? (recoveredErrorEntry?.errorPersistence ?? 'persisted') : null;
  emit();
  assertAppSyncLifecycleCurrent(activeCoordinator, userId, lifecycle.generation);
}

export function stopAppSync(): void {
  coordinator?.stop();
  enqueueError = null;
  enqueueErrorUserId = null;
  enqueueErrorGeneration = null;
  enqueueErrorPersistence = null;
  latestCoordinatorSnapshot = { ...latestCoordinatorSnapshot, activeUserId: null, flushing: false };
  emit();
}

export function subscribeAppSync(listener: AppSyncListener): () => void {
  listeners.add(listener);
  listener(getAppSyncSnapshot());
  return () => listeners.delete(listener);
}

export function getAppSyncSnapshot(): AppSyncSnapshot {
  const coordinatorSnapshot = coordinator?.getSnapshot() ?? latestCoordinatorSnapshot;
  const activeUserId = coordinatorSnapshot.activeUserId;
  const activeGeneration = coordinator?.getLifecycle().generation ?? null;
  const activeStaging = activeUserId
    ? [...stagingEntries.values()].filter(
        entry => entry.userId === activeUserId && (activeGeneration === null || entry.generation === activeGeneration),
      )
    : [];
  const enqueueFailure = selectLeastSafeSyncError([
    ...activeStaging
      .filter((entry): entry is StagingEntry & { error: string } => typeof entry.error === 'string' && entry.error.length > 0)
      .map(entry => ({ error: entry.error, persistence: entry.errorPersistence ?? 'persisted' })),
    ...(enqueueErrorUserId === activeUserId
      && (activeGeneration === null || enqueueErrorGeneration === activeGeneration)
      && enqueueError
      ? [{ error: enqueueError, persistence: enqueueErrorPersistence ?? 'unknown' as SyncErrorPersistence }]
      : []),
  ]);
  return {
    ...coordinatorSnapshot,
    staging: activeStaging.length,
    enqueueError: enqueueFailure?.error ?? null,
    enqueueErrorPersistence: enqueueFailure?.persistence ?? null,
  };
}

export function getAppSyncLifecycle(): SyncCoordinatorLifecycle {
  return coordinator?.getLifecycle() ?? { userId: null, generation: 0 };
}

export function isAppSyncLifecycleTokenCurrent(lifecycle: SyncCoordinatorLifecycle): boolean {
  return !!lifecycle.userId
    && !!coordinator
    && isAppSyncLifecycleCurrent(coordinator, lifecycle.userId, lifecycle.generation);
}

export function queueAppSyncMutation(
  input: EnqueueSyncMutation,
  options: {
    id?: string;
    createdAt?: number;
    expectedUserId?: string;
    scheduleFlush?: boolean;
    legacyRecovery?: boolean;
    syncProtocolVersion?: 4;
  } = {},
): Promise<string> {
  const activeCoordinator = ensureCoordinator();
  const lifecycle = activeCoordinator.getLifecycle();
  const activeUserId = lifecycle.userId;
  if (!activeUserId) return Promise.reject(new Error('SYNC_COORDINATOR_NOT_STARTED'));
  if (options.expectedUserId !== undefined && options.expectedUserId !== activeUserId) {
    return Promise.reject(new Error('SYNC_SESSION_IDENTITY_MISMATCH'));
  }
  try {
    assertAppSyncLifecycleCurrent(activeCoordinator, activeUserId, lifecycle.generation);
  } catch (error) {
    return Promise.reject(tagAppSyncEnqueueError(error, 'not-persisted'));
  }
  const createdAt = options.createdAt ?? Date.now();
  const stagingId = options.id ?? (typeof globalThis.crypto?.randomUUID === 'function'
    ? `handoff-${globalThis.crypto.randomUUID()}`
    : `handoff-${createdAt}-${++sequence}`);
  const preparationContext = {
    mutationId: stagingId,
    userId: activeUserId,
    createdAt,
  };
  const syncProtocolVersion = options.syncProtocolVersion
    ?? (options.legacyRecovery ? undefined : 4);
  let classification = classifyLegacyP3AuditEnvelopeForV4({
    id: stagingId,
    userId: activeUserId,
    createdAt,
    operations: input.operations,
    label: input.label,
  });
  const preparedInput = prepareLegacyP3AuditInput(input, preparationContext);
  try {
    if (classification?.kind !== 'QUARANTINED') {
      try {
        validateSyncMutationForDurability(preparedInput, { mutationId: stagingId, userId: activeUserId });
      } catch (error) {
        if (!options.legacyRecovery) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        classification = { kind: 'QUARANTINED', reason: `SYNC_LEGACY_QUARANTINED:${reason}` };
      }
    }
    // Preserve the exact original envelope. Legacy preparation is deterministic delivery state,
    // never a replacement for the durable recovery authority.
    persistHandoff({
      version: syncProtocolVersion === 4 ? 2 : 1,
      id: stagingId,
      userId: activeUserId,
      createdAt,
      input,
    });
  } catch (error) {
    return Promise.reject(tagAppSyncEnqueueError(error, 'not-persisted'));
  }
  stagingEntries.set(stagingId, {
    userId: activeUserId,
    generation: lifecycle.generation,
    keys: new Set(input.operations.map(operation => `${operation.collection}/${operation.docId}`)),
    error: null,
  });
  emit();
  try {
    assertAppSyncLifecycleCurrent(activeCoordinator, activeUserId, lifecycle.generation);
  } catch (error) {
    stagingEntries.delete(stagingId);
    return Promise.reject(error);
  }
  const enqueuePromise = activeCoordinator.enqueue(input, {
    id: stagingId,
    createdAt,
    expectedUserId: activeUserId,
    scheduleFlush: options.scheduleFlush,
    legacyRecovery: options.legacyRecovery,
    syncProtocolVersion,
  }).then(async id => {
    assertAppSyncLifecycleCurrent(activeCoordinator, activeUserId, lifecycle.generation);
    const durableIssue = await activeCoordinator.getIssue(id);
    assertAppSyncLifecycleCurrent(activeCoordinator, activeUserId, lifecycle.generation);
    if (classification?.kind !== 'QUARANTINED' && durableIssue?.status !== 'quarantined') {
      for (const operation of preparedInput.operations) {
        const state = operation.kind === 'delete'
          ? undefined
          : {
              fingerprint: fingerprintDocument(operation.value),
              revision: operation.expected.kind === 'present'
                ? (operation.expected.stateToken?.revision ?? operation.expected.revision ?? 0) + 1
                : 1,
              mutationId: id,
            };
        setConfirmedSyncStateForUser(activeUserId, operation.collection, operation.docId, state);
      }
    }
    let handoffRemoved = false;
    try {
      removeHandoff(activeUserId, stagingId);
      handoffRemoved = true;
    } catch (error) {
      // The IndexedDB outbox is already durable. Retaining the idempotent handoff is recoverable;
      // rejecting now would falsely tell the caller that no enqueue exists and invite rollback.
      enqueueError = error instanceof Error ? error.message : String(error);
      enqueueErrorUserId = activeUserId;
      enqueueErrorGeneration = lifecycle.generation;
      enqueueErrorPersistence = 'persisted';
      const entry = stagingEntries.get(stagingId);
      if (entry) { entry.error = enqueueError; entry.errorPersistence = 'persisted'; }
    }
    if (handoffRemoved) stagingEntries.delete(stagingId);
    if (handoffRemoved && latestCoordinatorSnapshot.activeUserId === activeUserId
      && ![...stagingEntries.values()].some(
        entry => entry.userId === activeUserId && entry.generation === lifecycle.generation && entry.error,
      )) {
      enqueueError = null;
      enqueueErrorUserId = null;
      enqueueErrorGeneration = null;
      enqueueErrorPersistence = null;
    }
    return id;
  }).catch(error => {
    if (!isAppSyncLifecycleCurrent(activeCoordinator, activeUserId, lifecycle.generation)) {
      stagingEntries.delete(stagingId);
      throw tagAppSyncEnqueueError(new Error('SYNC_SESSION_SUPERSEDED'), 'recovery-required');
    }
    const message = error instanceof Error ? error.message : String(error);
    // The caller will roll back its local domain write when IndexedDB rejects the enqueue.
    // Remove the crash handoff as well so a failed/rolled-back action cannot replay later.
    try {
      removeHandoff(activeUserId, stagingId);
      stagingEntries.delete(stagingId);
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      const entry = stagingEntries.get(stagingId);
      if (entry) { entry.error = cleanupMessage; entry.errorPersistence = 'recovery-required'; }
      enqueueError = cleanupMessage;
      enqueueErrorUserId = activeUserId;
      enqueueErrorGeneration = lifecycle.generation;
      enqueueErrorPersistence = 'recovery-required';
      throw tagAppSyncEnqueueError(error, 'recovery-required');
    }
    if (isAppSyncLifecycleCurrent(activeCoordinator, activeUserId, lifecycle.generation)) {
      enqueueError = message;
      enqueueErrorUserId = activeUserId;
      enqueueErrorGeneration = lifecycle.generation;
      enqueueErrorPersistence = 'not-persisted'; // the caller rolls its local write back: nothing was saved
    }
    throw tagAppSyncEnqueueError(error, 'not-persisted');
  }).finally(() => {
    inFlightEnqueues.delete(enqueuePromise);
    if (isAppSyncLifecycleCurrent(activeCoordinator, activeUserId, lifecycle.generation)) emit();
  });
  inFlightEnqueues.set(enqueuePromise, activeUserId);
  return enqueuePromise;
}

export async function flushAppSyncMutationAndRequireRemoteCommit(
  mutationId: string,
  expectedUserId: string,
): Promise<void> {
  const activeCoordinator = ensureCoordinator();
  const lifecycle = activeCoordinator.getLifecycle();
  if (lifecycle.userId !== expectedUserId || auth?.currentUser?.uid !== expectedUserId) {
    throw new Error('SYNC_SESSION_IDENTITY_MISMATCH');
  }
  assertAppSyncLifecycleCurrent(activeCoordinator, expectedUserId, lifecycle.generation);
  await activeCoordinator.flushAndRequireCommitted(mutationId);
  assertAppSyncLifecycleCurrent(activeCoordinator, expectedUserId, lifecycle.generation);
}

/** Schedule delivery only after the caller has completed its snapshot/journal handoff. */
export async function scheduleAppSyncFlush(expectedUserId: string): Promise<void> {
  const activeCoordinator = ensureCoordinator();
  const lifecycle = activeCoordinator.getLifecycle();
  if (lifecycle.userId !== expectedUserId || auth?.currentUser?.uid !== expectedUserId) {
    throw new Error('SYNC_SESSION_IDENTITY_MISMATCH');
  }
  assertAppSyncLifecycleCurrent(activeCoordinator, expectedUserId, lifecycle.generation);
  await activeCoordinator.notifyConnectivityChanged();
  assertAppSyncLifecycleCurrent(activeCoordinator, expectedUserId, lifecycle.generation);
}

export async function getUnresolvedSyncDocumentKeys(): Promise<Set<string>> {
  const activeCoordinator = coordinator;
  const lifecycle = activeCoordinator?.getLifecycle();
  const durable = activeCoordinator ? await activeCoordinator.getUnresolvedDocumentKeys() : new Set<string>();
  if (activeCoordinator && lifecycle?.userId) {
    assertAppSyncLifecycleCurrent(activeCoordinator, lifecycle.userId, lifecycle.generation);
  }
  const activeUserId = lifecycle?.userId ?? null;
  if (!activeUserId) return durable;
  for (const entry of stagingEntries.values()) {
    if (entry.userId !== activeUserId) continue;
    for (const key of entry.keys) durable.add(key);
  }
  return durable;
}

export async function clearActiveAppSyncQueue(): Promise<number> {
  const activeCoordinator = coordinator;
  const lifecycle = activeCoordinator?.getLifecycle();
  const activeUserId = lifecycle?.userId;
  if (!activeUserId) return 0;
  const activePromises = [...inFlightEnqueues.entries()]
    .filter(([, userId]) => userId === activeUserId)
    .map(([promise]) => promise);
  await Promise.allSettled(activePromises);
  assertAppSyncLifecycleCurrent(activeCoordinator, activeUserId, lifecycle.generation);
  for (const [stagingId, entry] of stagingEntries.entries()) {
    if (entry.userId === activeUserId) {
      stagingEntries.delete(stagingId);
      removeHandoff(activeUserId, stagingId);
    }
  }
  enqueueError = null;
  enqueueErrorUserId = null;
  enqueueErrorGeneration = null;
  enqueueErrorPersistence = null;
  const deleted = await activeCoordinator.stopAndClearActiveUserQueue();
  emit();
  return deleted;
}

export async function listAppSyncIssues(): Promise<AppSyncIssue[]> {
  if (!coordinator) return [];
  return (await coordinator.listIssues()).map(mutation => ({
    id: mutation.id,
    status: mutation.status as 'conflict' | 'blocked' | 'quarantined',
    label: mutation.label,
    lastError: mutation.lastError,
    documentKeys: mutation.operations.map(operation => `${operation.collection}/${operation.docId}`),
  }));
}

export async function retryBlockedAppSyncIssue(id: string): Promise<void> {
  if (!coordinator) throw new Error('SYNC_COORDINATOR_NOT_STARTED');
  const activeCoordinator = coordinator;
  const lifecycle = activeCoordinator.getLifecycle();
  if (!lifecycle.userId) throw new Error('SYNC_COORDINATOR_NOT_STARTED');
  const issue = await activeCoordinator.getIssue(id);
  assertAppSyncLifecycleCurrent(activeCoordinator, lifecycle.userId, lifecycle.generation);
  if (!issue || issue.status !== 'blocked') throw new Error('SYNC_BLOCKED_ISSUE_NOT_FOUND');
  await activeCoordinator.retryIssue(id);
}

export async function resolveConflictUsingLocal(id: string): Promise<void> {
  if (!coordinator || !db) throw new Error('SYNC_COORDINATOR_NOT_STARTED');
  const activeCoordinator = coordinator;
  const lifecycle = activeCoordinator.getLifecycle();
  if (!lifecycle.userId) throw new Error('SYNC_COORDINATOR_NOT_STARTED');
  const issue = await activeCoordinator.getIssue(id);
  if (!issue || issue.status !== 'conflict') throw new Error('SYNC_CONFLICT_NOT_FOUND');
  const prepared = prepareLegacyP3AuditInput(
    { operations: issue.operations, label: issue.label },
    { mutationId: issue.id, userId: issue.userId, createdAt: issue.createdAt },
  );
  const businessOperations = prepared.operations.filter(operation => operation.collection !== 'audit_logs');
  let remoteValues: Array<Record<string, unknown> | undefined>;
  try {
    remoteValues = await Promise.all(businessOperations.map(async operation => {
      const row = await supabaseDb.getDoc<Record<string, unknown>>(operation.collection as SupabaseTableName, operation.docId);
      return row ?? undefined;
    }));
  } catch (error) {
    const code = String((error as { code?: unknown })?.code || '').replace(/^firestore\//, '');
    if (code === 'permission-denied') {
      await activeCoordinator.quarantineIssue(id, 'RECOVERY_REQUIRES_TARGET_READ');
      return;
    }
    throw error;
  }
  assertAppSyncLifecycleCurrent(activeCoordinator, lifecycle.userId, lifecycle.generation);
  const actorRow = await supabaseDb.getDoc<Record<string, unknown>>('users', lifecycle.userId);
  assertAppSyncLifecycleCurrent(activeCoordinator, lifecycle.userId, lifecycle.generation);
  const permissions = new Set(
    actorRow && Array.isArray(actorRow.permissions)
      ? actorRow.permissions.filter((value: unknown): value is string => typeof value === 'string')
      : [],
  );
  const requiredPermission = (operation: SyncOperation, exists: boolean): string => {
    const effective = operation.kind === 'delete' ? 'delete' : exists ? 'update' : 'create';
    if (operation.collection === 'materials') return `materials_${effective === 'update' ? 'edit' : effective}`;
    if (operation.collection === 'transactions') return effective === 'delete' ? 'transactions_delete' : 'transactions_create';
    if (operation.collection === 'settings') return 'settings_edit';
    if (operation.collection === 'generator_logs') return 'generator_log';
    throw new Error(`SYNC_CONFLICT_UNSUPPORTED_COLLECTION:${operation.collection}`);
  };
  for (let index = 0; index < businessOperations.length; index += 1) {
    const operation = businessOperations[index];
    if (operation.kind === 'delete' && remoteValues[index] === undefined) continue;
    const permission = requiredPermission(operation, remoteValues[index] !== undefined);
    if (!permissions.has(permission)) {
      await activeCoordinator.quarantineIssue(id, `RECOVERY_PERMISSION_REQUIRED:${permission}`);
      return;
    }
  }
  let rebased: SyncOperation[];
  try {
    rebased = rebaseAuditedEnvelopeForConflict(
      prepared.operations,
      remoteValues,
      (operation, remoteValue) => syncExpectationWithCapacityProof(
        operation.collection,
        operation.docId,
        remoteValue,
      ),
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'SYNC_CONFLICT_ATOMIC_REBASE_UNSAFE') {
      await activeCoordinator.quarantineIssue(id, error.message);
      return;
    }
    throw error;
  }
  if (rebased.length === 0) {
    await activeCoordinator.discardIssue(id);
    return;
  }
  await activeCoordinator.retryIssue(id, rebased);
}

export async function discardAppSyncIssue(id: string): Promise<string[]> {
  if (!coordinator) throw new Error('SYNC_COORDINATOR_NOT_STARTED');
  const discarded = await coordinator.discardIssue(id);
  return discarded.operations.map(operation => `${operation.collection}/${operation.docId}`);
}

type ConfirmedStateRoot = Record<string, Record<string, ConfirmedSyncDocumentState>>;

const readConfirmedRoot = (): ConfirmedStateRoot => {
  try {
    const raw = localStorage.getItem(CONFIRMED_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
};

const isConfirmedState = (value: unknown): value is ConfirmedSyncDocumentState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ConfirmedSyncDocumentState>;
  return typeof candidate.fingerprint === 'string'
    && Number.isSafeInteger(candidate.revision)
    && (candidate.revision ?? -1) >= 0
    && (candidate.mutationId === undefined || typeof candidate.mutationId === 'string');
};

const writeConfirmedRoot = (root: ConfirmedStateRoot): void => {
  localStorage.setItem(CONFIRMED_STATE_KEY, JSON.stringify(root));
};

const activeStateKey = (collection: SyncableCollection, docId: string): string => `${collection}/${docId}`;

export function getConfirmedSyncState(collection: SyncableCollection, docId: string): ConfirmedSyncDocumentState | undefined {
  const userId = latestCoordinatorSnapshot.activeUserId;
  const state = userId ? readConfirmedRoot()[userId]?.[activeStateKey(collection, docId)] : undefined;
  return isConfirmedState(state) ? state : undefined;
}

/** Owner-bound confirmed OCC lookup — works even when AppSync activeUserId is not yet set (boot recovery). */
export function getConfirmedSyncStateForUser(
  userId: string,
  collection: SyncableCollection,
  docId: string,
): ConfirmedSyncDocumentState | undefined {
  const normalized = userId.trim();
  if (!normalized) return undefined;
  const state = readConfirmedRoot()[normalized]?.[activeStateKey(collection, docId)];
  return isConfirmedState(state) ? state : undefined;
}

/** Safe owner-bound list of durable AppSync handoffs (for restore-audit delivery proof). */
export function listSyncHandoffsForUser(userId: string): DurableSyncHandoff[] {
  const normalized = userId.trim();
  if (!normalized) return [];
  return readSyncHandoffsForUser(localStorage, normalized, validateSyncMutation);
}

/**
 * True when the active coordinator has any durable queue entry for this mutation id
 * (pending/retrying/conflict/blocked/quarantined) owned by the active user, or a staging handoff.
 */
export async function hasAppSyncDurableQueueEntry(mutationId: string): Promise<boolean> {
  const id = mutationId.trim();
  if (!id) return false;
  if (coordinator) {
    const lifecycle = coordinator.getLifecycle();
    if (lifecycle.userId) {
      assertAppSyncLifecycleCurrent(coordinator, lifecycle.userId, lifecycle.generation);
      if (await coordinator.hasQueuedMutation(id)) return true;
    }
  }
  const staging = stagingEntries.get(id);
  const activeUserId = latestCoordinatorSnapshot.activeUserId;
  if (staging && activeUserId && staging.userId === activeUserId) return true;
  return false;
}

/**
 * FV-P8-10: return the full owner-bound durable outbox mutation (id/userId/createdAt/label/operations)
 * for restore-audit whole-envelope proof. Staging-only presence is NOT sufficient.
 * Returns null when no exact outbox mutation is available to inspect.
 * Callers MUST validate via isExactRestoreAuditDeliveryEnvelope after adapting to envelope shape —
 * do not discard identity/lifecycle fields before proof.
 */
export async function getAppSyncDurableQueueMutation(
  mutationId: string,
): Promise<DurableSyncMutation | null> {
  const id = mutationId.trim();
  if (!id || !coordinator) return null;
  const lifecycle = coordinator.getLifecycle();
  if (!lifecycle.userId) return null;
  assertAppSyncLifecycleCurrent(coordinator, lifecycle.userId, lifecycle.generation);
  const mutation = await coordinator.getQueuedMutation(id);
  if (!mutation || mutation.userId !== lifecycle.userId) return null;
  return mutation;
}

/**
 * FV-P8-08: return operations for an any-status durable outbox entry owned by the active user.
 * Staging-only presence is NOT sufficient (ops live in the durable handoff until enqueue lands).
 * Returns null when no exact outbox mutation is available to inspect.
 * Prefer getAppSyncDurableQueueMutation for restore-audit proof (FV-P8-10) — ops-only discards
 * identity/lifecycle fields required by whole-envelope validation.
 */
export async function getAppSyncDurableQueueMutationOperations(
  mutationId: string,
): Promise<unknown[] | null> {
  const mutation = await getAppSyncDurableQueueMutation(mutationId);
  if (!mutation) return null;
  return Array.isArray(mutation.operations) ? mutation.operations : null;
}

export function setConfirmedSyncState(
  collection: SyncableCollection,
  docId: string,
  state: ConfirmedSyncDocumentState | undefined,
): void {
  const userId = latestCoordinatorSnapshot.activeUserId;
  if (!userId) return;
  setConfirmedSyncStateForUser(userId, collection, docId, state);
}

/** Seed/update confirmed OCC baselines for a specific user (e.g. bootstrap before startAppSync). */
export const setConfirmedSyncStateForUser = (
  userId: string,
  collection: SyncableCollection,
  docId: string,
  state: ConfirmedSyncDocumentState | undefined,
): void => {
  const root = readConfirmedRoot();
  const userStates = { ...(root[userId] || {}) };
  const key = activeStateKey(collection, docId);
  if (state) userStates[key] = state;
  else delete userStates[key];
  root[userId] = userStates;
  writeConfirmedRoot(root);
};

export function getConfirmedCollectionDocumentIds(collection: SyncableCollection): string[] {
  const userId = latestCoordinatorSnapshot.activeUserId;
  if (!userId) return [];
  const prefix = `${collection}/`;
  return Object.keys(readConfirmedRoot()[userId] || {})
    .filter(key => key.startsWith(prefix))
    .map(key => key.slice(prefix.length));
}

export type { SyncOperation };
