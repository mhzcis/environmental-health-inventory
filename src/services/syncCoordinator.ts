import type { SyncExpectation } from '../utils/syncProtocol';
import { validateAuditedEnvelopeCapacity } from '../utils/auditedEnvelope';
import {
  assertReceiptProofPayloadSafe,
  assertReceiptV4EnvelopeCapacity,
  auditReceiptAfterPayload,
} from '../utils/receiptProtocol';
import { classifyLegacyP3AuditEnvelopeForV4 } from '../utils/legacyAuditMigration';
import type { SyncQueueStore } from './syncQueueStore';

export const SYNCABLE_COLLECTIONS = [
  'settings',
  'materials',
  'transactions',
  'audit_logs',
  'generator_logs',
] as const;

export type SyncableCollection = typeof SYNCABLE_COLLECTIONS[number];
export type SyncMutationStatus = 'pending' | 'processing' | 'retrying' | 'conflict' | 'blocked' | 'quarantined';

export interface SyncSetOperation {
  kind: 'set';
  collection: SyncableCollection;
  docId: string;
  value: Record<string, unknown>;
  expected: SyncExpectation;
}

export interface SyncDeleteOperation {
  kind: 'delete';
  collection: SyncableCollection;
  docId: string;
  expected: SyncExpectation;
}

export type SyncOperation = SyncSetOperation | SyncDeleteOperation;

export interface DurableSyncMutation {
  id: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: SyncMutationStatus;
  syncProtocolVersion?: 4;
  operations: SyncOperation[];
  label?: string;
  lastError?: string;
  quarantineReason?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
}

export interface EnqueueSyncMutation {
  operations: SyncOperation[];
  label?: string;
}

export interface EnqueueSyncOptions {
  id?: string;
  createdAt?: number;
  scheduleFlush?: boolean;
  expectedUserId?: string;
  /** Permits an already-durable pre-v4 journal to be preserved as quarantine. */
  legacyRecovery?: boolean;
  syncProtocolVersion?: 4;
}

export interface SyncMutationPreparationContext {
  mutationId: string;
  userId: string;
  createdAt: number;
}

export type SyncMutationPreparer = (
  input: EnqueueSyncMutation,
  context: SyncMutationPreparationContext,
) => EnqueueSyncMutation;

export interface SyncTransport {
  commit(
    mutation: DurableSyncMutation,
    activeUserId: string,
    originalMutation?: DurableSyncMutation,
  ): Promise<SyncTransportCommitOutcome>;
}

/**
 * Identifies the exact envelope whose writes the transport has proved were committed.
 *
 * A protocol adapter must identify the effective envelope even when it acknowledges an older
 * atomic envelope without writing the prepared delivery envelope, otherwise reconciliation could
 * seed documents that never existed remotely.
 */
export interface SyncTransportCommitOutcome {
  effectiveMutation: DurableSyncMutation;
}

export interface SyncCoordinatorSnapshot {
  activeUserId: string | null;
  online: boolean;
  flushing: boolean;
  pending: number;
  retrying: number;
  conflicts: number;
  blocked: number;
  quarantined: number;
  lastError: string | null;
}

export interface SyncCoordinatorLifecycle {
  userId: string | null;
  generation: number;
}

type SyncCoordinatorListener = (snapshot: SyncCoordinatorSnapshot) => void;

export class SyncConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncConflictError';
  }
}

export class SyncPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncPermanentError';
  }
}

export class SyncQuarantineError extends SyncPermanentError {
  constructor(message: string) {
    super(message);
    this.name = 'SyncQuarantineError';
  }
}

interface CoordinatorDependencies {
  now?: () => number;
  randomId?: () => string;
  isOnline?: () => boolean;
  setTimer?: (handler: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onMutationCommitted?: (mutation: DurableSyncMutation) => void | Promise<void>;
  prepareInput?: SyncMutationPreparer;
}

const MAX_ATOMIC_OPERATIONS = 450;
const MAX_TIMER_DELAY_MS = 60_000;
const PROCESSING_LEASE_MS = 300_000;

const defaultRandomId = (): string => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const calculateRetryDelay = (attempts: number, mutationId: string): number => {
  const normalizedAttempts = Math.max(1, Math.floor(attempts));
  const exponential = Math.min(300_000, 1_000 * (2 ** Math.min(normalizedAttempts - 1, 8)));
  let seed = 0;
  for (let index = 0; index < mutationId.length; index += 1) seed = (seed * 31 + mutationId.charCodeAt(index)) >>> 0;
  const jitter = 0.8 + (seed % 401) / 1_000;
  return Math.min(300_000, Math.round(exponential * jitter));
};

export const validateSyncMutation = (input: EnqueueSyncMutation): void => {
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new Error('SYNC_OPERATIONS_REQUIRED');
  if (input.operations.length > MAX_ATOMIC_OPERATIONS) throw new Error('SYNC_ATOMIC_LIMIT_EXCEEDED');
  const keys = new Set<string>();
  for (const operation of input.operations) {
    if (!SYNCABLE_COLLECTIONS.includes(operation.collection)) throw new Error('SYNC_COLLECTION_NOT_ALLOWED');
    const documentIdPattern = operation.collection === 'audit_logs'
      ? /^[A-Za-z0-9._:-]{1,256}$/
      : /^[A-Za-z0-9._:-]{1,180}$/;
    if (!documentIdPattern.test(operation.docId)) throw new Error('SYNC_DOCUMENT_ID_INVALID');
    const key = `${operation.collection}/${operation.docId}`;
    if (keys.has(key)) throw new Error(`SYNC_DUPLICATE_DOCUMENT:${key}`);
    keys.add(key);
    if (!operation.expected) throw new Error(`SYNC_BASELINE_REQUIRED:${key}`);
    if (operation.kind === 'delete' && operation.expected.kind !== 'present') {
      throw new Error(`SYNC_DELETE_BASELINE_REQUIRED:${key}`);
    }
    if (operation.kind === 'set') {
      if (!operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value)) {
        throw new Error(`SYNC_DOCUMENT_VALUE_INVALID:${key}`);
      }
      if ('__sync' in operation.value) throw new Error(`SYNC_METADATA_RESERVED:${key}`);
      assertSerializableSyncValue(operation.value, key, new WeakSet());
      if (operation.collection !== 'audit_logs' || operation.value.schemaVersion === 3) {
        const proofPayload = operation.collection === 'audit_logs'
          ? auditReceiptAfterPayload(operation.value)
          : operation.value;
        assertReceiptProofPayloadSafe(operation.collection, proofPayload, { docId: operation.docId });
      }
    }
    if (operation.expected.kind === 'present' && operation.expected.exactLegacyPayload !== undefined) {
      if (!operation.expected.exactLegacyPayload
        || typeof operation.expected.exactLegacyPayload !== 'object'
        || Array.isArray(operation.expected.exactLegacyPayload)
        || Object.hasOwn(operation.expected.exactLegacyPayload, '__sync')) {
        throw new Error(`SYNC_LEGACY_BASELINE_INVALID:${key}`);
      }
      assertSerializableSyncValue(
        operation.expected.exactLegacyPayload,
        `${key}.expected.exactLegacyPayload`,
        new WeakSet(),
      );
      assertReceiptProofPayloadSafe(operation.collection, operation.expected.exactLegacyPayload, {
        docId: operation.docId,
        allowLegacyNestedBaseline: operation.collection === 'settings' && operation.docId === 'app_config',
      });
    }
  }
  validateAuditedEnvelopeCapacity(input.operations);
};

export const validateSyncMutationForDurability = (
  input: EnqueueSyncMutation,
  context: { mutationId: string; userId: string },
): void => {
  validateSyncMutation(input);
  // Every durable delivery must be capable of producing one complete Receipt v4. Legacy input is
  // first upgraded by the explicit classifier/preparer; an envelope that still lacks exact Audit
  // proof is quarantined rather than entering (or remaining in) a permanently undeliverable queue.
  assertReceiptV4EnvelopeCapacity({
    id: context.mutationId,
    userId: context.userId,
    operations: input.operations,
  }, context.userId);
};

const assertSerializableSyncValue = (value: unknown, path: string, seen: WeakSet<object>): void => {
  if (value === undefined) throw new Error(`SYNC_UNDEFINED_VALUE:${path}`);
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`SYNC_UNSUPPORTED_VALUE:${path}`);
  }
  if (!value || typeof value !== 'object' || value instanceof Date) return;
  if (seen.has(value)) throw new Error(`SYNC_VALUE_CYCLIC:${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertSerializableSyncValue(item, `${path}[${index}]`, seen));
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      assertSerializableSyncValue(nested, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class SyncCoordinator {
  private activeUserId: string | null = null;
  private lifecycleGeneration = 0;
  private readonly flushingGenerations = new Set<number>();
  private readonly drainingGenerations = new Set<number>();
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<SyncCoordinatorListener>();
  private snapshot: SyncCoordinatorSnapshot = {
    activeUserId: null,
    online: true,
    flushing: false,
    pending: 0,
    retrying: 0,
    conflicts: 0,
    blocked: 0,
    quarantined: 0,
    lastError: null,
  };
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly isOnline: () => boolean;
  private readonly setTimer: (handler: () => void, delay: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly coordinatorId: string;
  private readonly onMutationCommitted?: (mutation: DurableSyncMutation) => void | Promise<void>;
  private readonly prepareInput: SyncMutationPreparer;
  private readonly idleWaiters = new Map<number, Set<() => void>>();
  private readonly connectivityHandler = () => { void this.notifyConnectivityChanged(); };

  constructor(
    private readonly store: SyncQueueStore,
    private readonly transport: SyncTransport,
    dependencies: CoordinatorDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.randomId = dependencies.randomId ?? defaultRandomId;
    this.isOnline = dependencies.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine);
    this.setTimer = dependencies.setTimer ?? ((handler, delay) => setTimeout(handler, delay));
    this.clearTimer = dependencies.clearTimer ?? (timer => clearTimeout(timer));
    this.onMutationCommitted = dependencies.onMutationCommitted;
    this.prepareInput = dependencies.prepareInput ?? (input => input);
    this.coordinatorId = `coordinator-${this.randomId()}`;
  }

  subscribe(listener: SyncCoordinatorListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SyncCoordinatorSnapshot {
    if (this.snapshot.activeUserId !== this.activeUserId) {
      return {
        activeUserId: this.activeUserId,
        online: this.isOnline(),
        flushing: false,
        pending: 0,
        retrying: 0,
        conflicts: 0,
        blocked: 0,
        quarantined: 0,
        lastError: null,
      };
    }
    return {
      ...this.snapshot,
      activeUserId: this.activeUserId,
      flushing: !this.stopped && this.flushingGenerations.has(this.lifecycleGeneration),
    };
  }

  getLifecycle(): SyncCoordinatorLifecycle {
    return { userId: this.activeUserId, generation: this.lifecycleGeneration };
  }

  isLifecycleCurrent(userId: string, generation: number): boolean {
    return !this.stopped
      && this.activeUserId === userId
      && this.lifecycleGeneration === generation;
  }

  async start(userId: string, autoFlush = true): Promise<void> {
    const normalized = userId.trim();
    if (!normalized) throw new Error('SYNC_USER_REQUIRED');
    this.stop();
    this.activeUserId = normalized;
    this.stopped = false;
    const generation = ++this.lifecycleGeneration;
    this.snapshot = {
      activeUserId: normalized,
      online: this.isOnline(),
      flushing: false,
      pending: 0,
      retrying: 0,
      conflicts: 0,
      blocked: 0,
      quarantined: 0,
      lastError: null,
    };
    this.emit();
    this.assertLifecycleCurrent(normalized, generation);
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('online', this.connectivityHandler);
      globalThis.addEventListener('offline', this.connectivityHandler);
    }
    if (!await this.refreshSnapshot(normalized, generation)) throw new Error('SYNC_SESSION_SUPERSEDED');
    if (autoFlush) this.schedule(0, normalized, generation);
  }

  stop(): void {
    this.lifecycleGeneration += 1;
    this.stopped = true;
    this.activeUserId = null;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('online', this.connectivityHandler);
      globalThis.removeEventListener('offline', this.connectivityHandler);
    }
    this.snapshot = {
      activeUserId: null,
      online: this.isOnline(),
      flushing: false,
      pending: 0,
      retrying: 0,
      conflicts: 0,
      blocked: 0,
      quarantined: 0,
      lastError: null,
    };
    this.emit();
  }

  async enqueue(input: EnqueueSyncMutation, options: EnqueueSyncOptions = {}): Promise<string> {
    if (this.stopped || !this.activeUserId) throw new Error('SYNC_COORDINATOR_NOT_STARTED');
    if (options.expectedUserId !== undefined && options.expectedUserId !== this.activeUserId) {
      throw new Error('SYNC_SESSION_IDENTITY_MISMATCH');
    }
    const userId = this.activeUserId;
    const generation = this.lifecycleGeneration;
    const id = options.id || this.randomId();
    if (!id || id.includes('/')) throw new Error('SYNC_MUTATION_ID_INVALID');
    const timestamp = options.createdAt ?? this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('SYNC_CREATED_AT_INVALID');
    const preparationContext = { mutationId: id, userId, createdAt: timestamp };
    let classification = classifyLegacyP3AuditEnvelopeForV4({
      id,
      userId,
      createdAt: timestamp,
      operations: input.operations,
      label: input.label,
    });
    const preparedInput = this.prepareInput(input, preparationContext);
    if (classification?.kind !== 'QUARANTINED') {
      try {
        validateSyncMutationForDurability(preparedInput, { mutationId: id, userId });
      } catch (error) {
        if (!options.legacyRecovery) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        classification = { kind: 'QUARANTINED', reason: `SYNC_LEGACY_QUARANTINED:${reason}` };
      }
    }
    const existingQueue = await this.store.listForUser(userId);
    this.assertLifecycleCurrent(userId, generation);
    const requestedKeys = new Set(input.operations.map(operation => `${operation.collection}/${operation.docId}`));
    const fence = existingQueue.find(candidate => candidate.id !== id
      && candidate.status === 'quarantined'
      && candidate.operations.some(operation => requestedKeys.has(`${operation.collection}/${operation.docId}`)));
    if (fence) throw new Error(`SYNC_QUARANTINE_FENCE:${fence.id}`);
    const mutation: DurableSyncMutation = {
      id,
      userId,
      createdAt: timestamp,
      updatedAt: timestamp,
      attempts: 0,
      nextAttemptAt: timestamp,
      status: classification?.kind === 'QUARANTINED' ? 'quarantined' : 'pending',
      ...(options.syncProtocolVersion === 4 ? { syncProtocolVersion: 4 } : {}),
      operations: input.operations,
      label: input.label,
      ...(classification?.kind === 'QUARANTINED' ? {
        lastError: classification.reason,
        quarantineReason: classification.reason,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
      } : {}),
    };
    const inserted = await this.store.insert(mutation);
    this.assertLifecycleCurrent(userId, generation);
    if (!inserted) {
      const existing = await this.store.get(id);
      this.assertLifecycleCurrent(userId, generation);
      const existingInput = existing && this.prepareInput(
        { operations: existing.operations, label: existing.label },
        { mutationId: existing.id, userId: existing.userId, createdAt: existing.createdAt },
      );
      if (!existing || existing.userId !== mutation.userId
        || JSON.stringify(existingInput?.operations) !== JSON.stringify(preparedInput.operations)
        || existingInput?.label !== preparedInput.label) {
        throw new Error('SYNC_MUTATION_ID_COLLISION');
      }
    }
    try {
      if (!await this.refreshSnapshot(userId, generation)) throw new Error('SYNC_SESSION_SUPERSEDED');
    } catch (error) {
      // Once insert/exact-idempotent recovery succeeds, an observer refresh failure must not turn
      // a durable enqueue into an ambiguous rejection. A lifecycle replacement is different: its
      // original UID journal remains the recovery authority and must not be rolled back here.
      if (!this.isLifecycleCurrent(userId, generation)) throw error;
      this.snapshot = { ...this.snapshot, lastError: errorMessage(error) };
      this.emit();
    }
    if (options.scheduleFlush !== false) {
      try {
        this.schedule(0, userId, generation);
      } catch (error) {
        // The durable queue will be scheduled on the next lifecycle/connectivity notification.
        this.snapshot = { ...this.snapshot, lastError: errorMessage(error) };
        this.emit();
      }
    }
    return mutation.id;
  }

  async listIssues(): Promise<DurableSyncMutation[]> {
    const lifecycle = this.captureLifecycle();
    if (!lifecycle) return [];
    const queued = await this.store.listForUser(lifecycle.userId);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    return queued
      .filter(mutation => mutation.status === 'conflict'
        || mutation.status === 'blocked'
        || mutation.status === 'quarantined');
  }

  async getIssue(id: string): Promise<DurableSyncMutation | undefined> {
    const lifecycle = this.captureLifecycle();
    if (!lifecycle) return undefined;
    const mutation = await this.store.get(id);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    if (!mutation || mutation.userId !== lifecycle.userId
      || (mutation.status !== 'conflict'
        && mutation.status !== 'blocked'
        && mutation.status !== 'quarantined')) return undefined;
    return mutation;
  }

  /** Any-status durable queue entry for the active user (pending through quarantined). */
  async hasQueuedMutation(id: string): Promise<boolean> {
    const lifecycle = this.captureLifecycle();
    if (!lifecycle) return false;
    const mutation = await this.store.get(id);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    return !!mutation && mutation.userId === lifecycle.userId;
  }

  /** Any-status durable queue mutation for the active user (for exact-envelope proof inspection). */
  async getQueuedMutation(id: string): Promise<DurableSyncMutation | undefined> {
    const lifecycle = this.captureLifecycle();
    if (!lifecycle) return undefined;
    const mutation = await this.store.get(id);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    if (!mutation || mutation.userId !== lifecycle.userId) return undefined;
    return mutation;
  }

  async retryIssue(id: string, rebasedOperations?: SyncOperation[]): Promise<void> {
    const lifecycle = this.requireLifecycle();
    const mutation = await this.store.get(id);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    if (mutation?.userId !== lifecycle.userId
      || (mutation.status !== 'conflict' && mutation.status !== 'blocked')) {
      throw new Error('SYNC_ISSUE_NOT_FOUND');
    }
    if (mutation.status === 'conflict' && !rebasedOperations) throw new Error('SYNC_CONFLICT_REBASE_REQUIRED');
    const operations = rebasedOperations || mutation.operations;
    const preparedInput = this.prepareInput(
      { operations, label: mutation.label },
      { mutationId: mutation.id, userId: mutation.userId, createdAt: mutation.createdAt },
    );
    validateSyncMutationForDurability(
      preparedInput,
      { mutationId: mutation.id, userId: mutation.userId },
    );
    const timestamp = this.now();
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    await this.store.put({
      ...mutation,
      operations,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      updatedAt: timestamp,
      lastError: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    this.snapshot = { ...this.snapshot, lastError: null };
    if (!await this.refreshSnapshot(lifecycle.userId, lifecycle.generation)) {
      throw new Error('SYNC_SESSION_SUPERSEDED');
    }
    this.schedule(0, lifecycle.userId, lifecycle.generation);
  }

  async quarantineIssue(id: string, reason: string): Promise<void> {
    const lifecycle = this.requireLifecycle();
    const mutation = await this.store.get(id);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    if (!mutation || mutation.userId !== lifecycle.userId || mutation.status !== 'conflict') {
      throw new Error('SYNC_CONFLICT_NOT_FOUND');
    }
    const timestamp = this.now();
    await this.store.put({
      ...mutation,
      status: 'quarantined',
      updatedAt: timestamp,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      lastError: reason,
      quarantineReason: reason,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    this.snapshot = { ...this.snapshot, lastError: reason };
    if (!await this.refreshSnapshot(lifecycle.userId, lifecycle.generation)) {
      throw new Error('SYNC_SESSION_SUPERSEDED');
    }
  }

  async discardIssue(id: string): Promise<DurableSyncMutation> {
    const lifecycle = this.requireLifecycle();
    const mutation = await this.store.get(id);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    if (!mutation || mutation.userId !== lifecycle.userId
      || (mutation.status !== 'conflict' && mutation.status !== 'blocked')) {
      throw new Error('SYNC_ISSUE_NOT_FOUND');
    }
    await this.store.delete(id);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    this.snapshot = { ...this.snapshot, lastError: null };
    if (!await this.refreshSnapshot(lifecycle.userId, lifecycle.generation)) {
      throw new Error('SYNC_SESSION_SUPERSEDED');
    }
    return mutation;
  }

  async flush(): Promise<void> {
    const lifecycle = this.captureLifecycle();
    if (!lifecycle) return;
    const { userId, generation } = lifecycle;
    if (this.flushingGenerations.has(generation) || !this.isOnline()) {
      await this.refreshSnapshot(userId, generation);
      return;
    }
    this.flushingGenerations.add(generation);
    try {
      if (!await this.refreshSnapshot(userId, generation)) return;
      while (this.isLifecycleCurrent(userId, generation) && this.isOnline()) {
        const mutation = await this.store.claimNext(userId, this.now(), this.coordinatorId, PROCESSING_LEASE_MS);
        if (!this.isLifecycleCurrent(userId, generation)) break;
        if (!mutation) break;
        try {
          const legacyClassification = classifyLegacyP3AuditEnvelopeForV4(mutation);
          if (legacyClassification?.kind === 'QUARANTINED') {
            throw new SyncQuarantineError(legacyClassification.reason);
          }
          const preparedInput = this.prepareInput(
            { operations: mutation.operations, label: mutation.label },
            { mutationId: mutation.id, userId: mutation.userId, createdAt: mutation.createdAt },
          );
          try {
            validateSyncMutationForDurability(preparedInput, { mutationId: mutation.id, userId: mutation.userId });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new SyncQuarantineError(`SYNC_DURABLE_ENVELOPE_QUARANTINED:${reason}`);
          }
          const deliveryMutation = preparedInput.operations === mutation.operations
            && preparedInput.label === mutation.label
            ? mutation
            : { ...mutation, operations: preparedInput.operations, label: preparedInput.label };
          const fences = await this.store.listForUser(userId);
          this.assertLifecycleCurrent(userId, generation);
          const deliveryKeys = new Set(deliveryMutation.operations.map(operation => `${operation.collection}/${operation.docId}`));
          const fence = fences.find(candidate => candidate.id !== mutation.id
            && candidate.status === 'quarantined'
            && candidate.operations.some(operation => deliveryKeys.has(`${operation.collection}/${operation.docId}`)));
          if (fence) throw new SyncPermanentError(`SYNC_QUARANTINE_FENCE:${fence.id}`);
          // Keep the exact durable record available to transports that must recognize a commit
          // made by an older protocol before applying the current deterministic preparation.
          const commitOutcome = await this.transport.commit(deliveryMutation, userId, mutation);
          const effectiveMutation = commitOutcome.effectiveMutation;
          if (effectiveMutation.id !== mutation.id
            || effectiveMutation.userId !== mutation.userId
            || effectiveMutation.createdAt !== mutation.createdAt) {
            throw new SyncPermanentError('SYNC_COMMIT_OUTCOME_IDENTITY_MISMATCH');
          }
          if (!this.isLifecycleCurrent(userId, generation)) {
            if (this.drainingGenerations.has(generation)) {
              await this.store.deleteClaimed(mutation.id, this.coordinatorId);
              try {
                await this.onMutationCommitted?.(effectiveMutation);
              } catch (_) {
                // The stopped session is being explicitly drained before its queue is cleared.
              }
            }
            break;
          }
          await this.store.deleteClaimed(mutation.id, this.coordinatorId);
          if (!this.isLifecycleCurrent(userId, generation)) break;
          try {
            await this.onMutationCommitted?.(effectiveMutation);
          } catch (_) {
            // The cloud commit and durable dequeue already succeeded. Replaying because a local
            // baseline write failed would be unsafe; reconciliation stays fail-closed without it.
          }
          if (!this.isLifecycleCurrent(userId, generation)) break;
          this.snapshot = { ...this.snapshot, lastError: null };
        } catch (error) {
          if (!this.isLifecycleCurrent(userId, generation)) break;
          mutation.updatedAt = this.now();
          mutation.lastError = errorMessage(error);
          mutation.leaseOwner = undefined;
          mutation.leaseExpiresAt = undefined;
          if (error instanceof SyncConflictError) {
            mutation.status = 'conflict';
            mutation.nextAttemptAt = Number.MAX_SAFE_INTEGER;
          } else if (error instanceof SyncQuarantineError) {
            mutation.status = 'quarantined';
            mutation.quarantineReason = error.message;
            mutation.nextAttemptAt = Number.MAX_SAFE_INTEGER;
          } else if (error instanceof SyncPermanentError) {
            mutation.status = 'blocked';
            mutation.nextAttemptAt = Number.MAX_SAFE_INTEGER;
          } else {
            mutation.attempts += 1;
            mutation.status = 'retrying';
            mutation.nextAttemptAt = this.now() + calculateRetryDelay(mutation.attempts, mutation.id);
          }
          await this.store.updateClaimed(mutation, this.coordinatorId);
          if (!this.isLifecycleCurrent(userId, generation)) break;
          this.snapshot = { ...this.snapshot, lastError: mutation.lastError };
        }
        await this.refreshSnapshot(userId, generation);
      }
    } finally {
      this.flushingGenerations.delete(generation);
      for (const resolve of this.idleWaiters.get(generation) ?? []) resolve();
      this.idleWaiters.delete(generation);
      if (this.isLifecycleCurrent(userId, generation)) {
        await this.refreshSnapshot(userId, generation);
        await this.scheduleNextAttempt(userId, generation);
      }
    }
  }

  async flushAndRequireCommitted(id: string): Promise<void> {
    const lifecycle = this.requireLifecycle();
    const queued = await this.store.get(id);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    if (!queued || queued.userId !== lifecycle.userId) throw new Error('SYNC_REMOTE_ACK_MUTATION_NOT_FOUND');
    if (!this.isOnline()) throw new Error('SYNC_REMOTE_ACK_OFFLINE');

    if (this.flushingGenerations.has(lifecycle.generation)) {
      await new Promise<void>(resolve => {
        const waiters = this.idleWaiters.get(lifecycle.generation) ?? new Set<() => void>();
        waiters.add(resolve);
        this.idleWaiters.set(lifecycle.generation, waiters);
      });
    } else {
      await this.flush();
    }

    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    const remaining = await this.store.get(id);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    if (remaining) {
      throw new Error(`SYNC_REMOTE_ACK_NOT_CONFIRMED:${remaining.status}:${remaining.lastError || 'unknown'}`);
    }
  }

  async hasPendingDocument(collection: SyncableCollection, docId: string): Promise<boolean> {
    const lifecycle = this.captureLifecycle();
    if (!lifecycle) return false;
    const mutations = await this.store.listForUser(lifecycle.userId);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    return mutations.some(mutation =>
      mutation.status !== 'blocked'
      && mutation.status !== 'conflict'
      && mutation.status !== 'quarantined'
      && mutation.operations.some(operation => operation.collection === collection && operation.docId === docId)
    );
  }

  async getUnresolvedDocumentKeys(): Promise<Set<string>> {
    const lifecycle = this.captureLifecycle();
    if (!lifecycle) return new Set();
    const mutations = await this.store.listForUser(lifecycle.userId);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    return new Set(mutations.flatMap(mutation =>
      mutation.operations.map(operation => `${operation.collection}/${operation.docId}`)
    ));
  }

  async clearActiveUserQueue(): Promise<number> {
    const lifecycle = this.captureLifecycle();
    if (!lifecycle) return 0;
    const deleted = await this.store.clearForUser(lifecycle.userId);
    this.assertLifecycleCurrent(lifecycle.userId, lifecycle.generation);
    await this.refreshSnapshot(lifecycle.userId, lifecycle.generation);
    return deleted;
  }

  async stopAndClearActiveUserQueue(): Promise<number> {
    const userId = this.activeUserId;
    if (!userId) return 0;
    const generation = this.lifecycleGeneration;
    if (this.flushingGenerations.has(generation)) this.drainingGenerations.add(generation);
    this.stop();
    if (this.flushingGenerations.has(generation)) {
      await new Promise<void>(resolve => {
        const waiters = this.idleWaiters.get(generation) ?? new Set<() => void>();
        waiters.add(resolve);
        this.idleWaiters.set(generation, waiters);
      });
    }
    this.drainingGenerations.delete(generation);
    const deleted = await this.store.clearForUser(userId);
    return deleted;
  }

  async notifyConnectivityChanged(): Promise<void> {
    const lifecycle = this.captureLifecycle();
    if (!lifecycle) return;
    if (!await this.refreshSnapshot(lifecycle.userId, lifecycle.generation)) return;
    if (this.isOnline()) this.schedule(0, lifecycle.userId, lifecycle.generation);
  }

  private schedule(delay: number, userId: string, generation: number): void {
    if (!this.isLifecycleCurrent(userId, generation)) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      if (!this.isLifecycleCurrent(userId, generation)) return;
      this.timer = null;
      void this.flush();
    }, Math.max(0, Math.min(delay, MAX_TIMER_DELAY_MS)));
  }

  private async scheduleNextAttempt(userId: string, generation: number): Promise<void> {
    if (!this.isLifecycleCurrent(userId, generation) || !this.isOnline()) return;
    const queued = await this.store.listForUser(userId);
    if (!this.isLifecycleCurrent(userId, generation)) return;
    const next = queued
      .filter(mutation => mutation.status === 'pending' || mutation.status === 'retrying' || mutation.status === 'processing')[0];
    if (next) {
      const dueAt = next.status === 'processing'
        ? next.leaseExpiresAt ?? this.now()
        : next.nextAttemptAt;
      this.schedule(dueAt - this.now(), userId, generation);
    }
  }

  private async refreshSnapshot(userId: string, generation: number): Promise<boolean> {
    const queued = await this.store.listForUser(userId);
    if (!this.isLifecycleCurrent(userId, generation)) return false;
    this.snapshot = {
      ...this.snapshot,
      activeUserId: userId,
      online: this.isOnline(),
      flushing: this.flushingGenerations.has(generation),
      pending: queued.filter(item => item.status === 'pending' || item.status === 'processing').length,
      retrying: queued.filter(item => item.status === 'retrying').length,
      conflicts: queued.filter(item => item.status === 'conflict').length,
      blocked: queued.filter(item => item.status === 'blocked').length,
      quarantined: queued.filter(item => item.status === 'quarantined').length,
    };
    this.emit();
    return this.isLifecycleCurrent(userId, generation);
  }

  private captureLifecycle(): { userId: string; generation: number } | null {
    if (this.stopped || !this.activeUserId) return null;
    return { userId: this.activeUserId, generation: this.lifecycleGeneration };
  }

  private requireLifecycle(): { userId: string; generation: number } {
    const lifecycle = this.captureLifecycle();
    if (!lifecycle) throw new Error('SYNC_COORDINATOR_NOT_STARTED');
    return lifecycle;
  }

  private assertLifecycleCurrent(userId: string, generation: number): void {
    if (!this.isLifecycleCurrent(userId, generation)) throw new Error('SYNC_SESSION_SUPERSEDED');
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
