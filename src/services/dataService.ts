import { composeSupabaseAppSettings } from './supabaseSettings';
import { Material, InventoryTransaction, AuditLog, AppSettings, SystemUser, GeneratorLogEntry, GeneratorLogSimulationResult, type AuditEventContext } from '../types';
import { db, auth } from './firebase';
import {
  getCurrentAuthUser,
  isSupabaseConfigured,
  supabaseAuthSignIn,
  supabaseAuthSignOut,
  supabaseDb,
  type SupabaseTableName,
} from './supabase';
import { applyBackupLocally } from './backupService';
import { ensureCanonicalCurrentUserProfile } from './legacyUserMigration';
import {
  beginCrashSafeLocalRestore,
  clearRestoreRecoveryRecord,
  clearRestoreRecoveryQuarantineAfterControlledRebootstrap,
  finalizeCrashSafeLocalRestoreAfterAudit,
  hasAuthoritativeRestoreAuditDeliveryProof,
  hasRestoreRecoveryQuarantine,
  markRestoreRecoveryAuditCommitted,
  persistRestoreRecoveryRecord,
  readRestoreRecoveryRecord,
  recoverInterruptedLocalRestore,
  type RestoreRecoveryRecord,
  resolveRestoreAuditOperationId,
  resolveRestoreAuditTimestamp,
  resolveRestoreDeliveryMutationId,
  resolveRestoreOwnerUserId,
  validateBackup,
} from './backupService';
import {
  createManagedFirebaseUser,
  fetchManagedFirebaseUsers,
  sendManagedUserPasswordReset,
  setManagedFirebaseUserActive,
  updateManagedFirebaseUserProfile,
  validateCanonicalManagedUser,
} from './managedUserService';
import {
  assertManagedSessionAllowed,
  assertManagedSessionOwnerCurrent,
  captureManagedSessionOwner,
  isManagedSessionChangedError,
  type ManagedSessionOwner,
} from './managedSessionOwner';
import { getStorehouseByReference, getStorehouseEntities, resolveWarehouseScope } from '../utils/warehouseDomain';
import { migrateWarehouseModel } from '../utils/warehouseMigration';
import { addOrReactivateWarehouse, canonicalizeWarehouseSettings, renameWarehouseEntity, reorderWarehouseEntity, setWarehouseEntityActive } from '../utils/warehouseSettings';
import {
  buildSettingsCloudMutationPlan,
  composeAppSettingsFromNormalized,
  extractTypedSettingsChildren,
  hasNestedLegacySettingsKeys,
  listSettingsChildDocIdsFromRoot,
  openingAttachmentDocId,
  openingAttachmentCloudPayload,
  openingAttachmentTombstonePayload,
  settingsChildSyncProjection,
  settingsRootSyncProjection,
  stageSettingsCloudMutationPlan,
  toSlimSettingsRoot,
  type TypedSettingsChildren,
} from '../utils/settingsNormalization';
import {
  assertComposedSettingsViewModel,
  productLimitMessage,
  withSettingsAttachmentManifest,
} from '../utils/productSchema';
import {
  MAX_ATOMIC_FIRESTORE_WRITES,
  getInventoryTransactionDirection,
  getTransferCompanion,
  validateAtomicWriteCount,
  validateInventoryDataset,
  type IntegrityTransaction,
} from '../utils/inventoryIntegrity';
import {
  clearActiveAppSyncQueue,
  createSyncDeleteOperation,
  createSyncSetOperation,
  getAppSyncSnapshot,
  getAppSyncLifecycle,
  getConfirmedCollectionDocumentIds,
  getConfirmedSyncState,
  getUnresolvedSyncDocumentKeys,
  listAppSyncIssues,
  isAppSyncLifecycleTokenCurrent,
  flushAppSyncMutationAndRequireRemoteCommit,
  appSyncEnqueueState,
  queueAppSyncMutation,
  scheduleAppSyncFlush,
  discardAppSyncIssue,
  resolveConflictUsingLocal,
  retryBlockedAppSyncIssue,
  setConfirmedSyncState,
  setConfirmedSyncStateForUser,
  startAppSync,
  stopAppSync,
  subscribeAppSync,
  type SyncOperation,
  type AppSyncIssue,
} from './appSyncService';
import {
  deriveMonitoringHealth,
  resolveExpectedMonitoringCollections,
  type MonitoringHealth,
  type MonitoringOutboxCounts,
  type MonitoringReadySnapshot,
} from './monitoringHealth';
import { isStorageQuotaError, type SyncErrorPersistence } from './syncPersistenceState';
import {
  blockProtectedCloudEnqueue,
  clearProtectedCloudEnqueueBlock,
  getProtectedCloudEnqueueBlockReason,
  type ProtectedEnqueueBlockReason,
} from '../security/p10AuthorityContract';
import { assertProtectedCloudMutationAllowed } from '../security/pol4CloudMutationGate';
import { fingerprintDocument, shouldAcceptAuthoritativeSnapshot, stripSyncMetadata } from '../utils/syncProtocol';
import { confirmedStateForAppliedValue, confirmedStateForRemote, decideRemoteDocument } from '../utils/syncReconciliation';
import {
  addRemoteResolutionKeys,
  readRemoteResolutionKeys,
  removeRemoteResolutionKey,
} from '../utils/syncResolutionStore';
import {
  clearOfflineDomainProjection,
  clearActiveOfflineMutationJournals,
  commitActiveOfflineMutation,
  deactivateOfflineDomainForUser,
  deleteActiveOfflineMutationJournal,
  getActiveOfflineDomainUserId,
  getActiveOfflineMutationJournalCount,
  listValidatedActiveOfflineMutationJournals,
  OFFLINE_DOMAIN_STORAGE_KEYS,
  OFFLINE_LEGACY_MIGRATION_KEY,
  OFFLINE_PROJECTION_OWNER_KEY,
  offlineProjectionStorage,
  persistActiveOfflineDomainState,
  persistSessionOwnedOfflineDomainProjection,
  readActiveOfflineDomainSnapshot,
  rollbackActiveOfflineMutationJournal,
  OfflineDomainSessionChangedError,
  OfflineDomainJournalRecoveryRequiredError,
  OfflineDomainProjectionRecoveryRequiredError,
} from './offlineDomainStore';
import { validateSyncMutationForDurability } from './syncCoordinator';
import {
  assertLogoutAuditOwnership,
  executeFailSafeLogout,
  LogoutSingleFlight,
  type LogoutResult,
} from './logoutCoordinator';
import { firebaseAuthUserFingerprint, type FirebaseAuthUserLike } from './authLifecycleGuard';
import {
  clearAuthTermination,
  createAuthTerminationRecord,
  isAuthTerminationRemembered,
  persistAuthTermination,
  readAuthTermination,
  rememberAuthTerminationInMemory,
  type AuthTerminationRecord,
} from './authTerminationStore';
import {
  buildAuditLog,
  normalizeAuditLog,
} from '../utils/auditPolicy';
import { bindDiagnosticsSession, classifyError, recordDiagnostic } from './operationalDiagnostics';
import { safeErrorDetail, safeResultMessage } from './safeUserMessage';
import { clearUnattributedRuntimeAlert } from './unattributedRuntimeAlert';

const localStorage = offlineProjectionStorage;

// Safety constant to control Firebase migration approval state
export const CLOUD_WRITES_ENABLED = true;
export const CLOUD_LISTENERS_ENABLED = true;
export const CLOUD_MONITORING_ENABLED = true;

export type {
  MonitoringHealth,
  MonitoringPhase,
  MonitoringOutboxCounts,
  MonitoringReadySnapshot,
} from './monitoringHealth';
export {
  monitoringPhaseArabicLabel,
  monitoringPhaseColor,
  pendingDeliveryCount,
  actionRequiredCount,
  deriveMonitoringHealth,
} from './monitoringHealth';

type DataChangeListener = () => void;
const changeListeners = new Set<DataChangeListener>();
let sessionTerminationVersion = 0;
const logoutSingleFlight = new LogoutSingleFlight();
let firebaseAuthSessionGeneration = 0;
const firebaseUserSessionIdentity = firebaseAuthUserFingerprint;

type FirebaseLifecycleCapture = Readonly<{
  user: FirebaseAuthUserLike;
  uid: string;
  fingerprint: string;
  generation: number;
}>;

const captureCurrentFirebaseLifecycle = (): FirebaseLifecycleCapture | null => {
  const user = auth?.currentUser;
  if (!user?.uid) return null;
  return Object.freeze({
    user,
    uid: user.uid,
    fingerprint: firebaseUserSessionIdentity(user),
    generation: firebaseAuthSessionGeneration,
  });
};

const isFirebaseLifecycleCurrent = (captured: FirebaseLifecycleCapture): boolean => {
  const current = auth?.currentUser;
  return !!current
    && current === captured.user
    && current.uid === captured.uid
    && firebaseAuthSessionGeneration === captured.generation
    && firebaseUserSessionIdentity(current) === captured.fingerprint;
};

const assertFirebaseLifecycleCurrent = (captured: FirebaseLifecycleCapture): void => {
  if (!isFirebaseLifecycleCurrent(captured)) throw new OfflineDomainSessionChangedError(captured.uid);
};

type SessionContinuationCapture = Readonly<{
  firebaseLifecycle: FirebaseLifecycleCapture | null;
  domainUserId: string | null;
}>;

const captureSessionContinuation = (): SessionContinuationCapture => Object.freeze({
  firebaseLifecycle: captureCurrentFirebaseLifecycle(),
  domainUserId: getActiveOfflineDomainUserId(),
});

const isSessionContinuationCurrent = (captured: SessionContinuationCapture): boolean => {
  const firebaseCurrent = captured.firebaseLifecycle
    ? isFirebaseLifecycleCurrent(captured.firebaseLifecycle)
    : !auth?.currentUser;
  return firebaseCurrent && getActiveOfflineDomainUserId() === captured.domainUserId;
};

const assertSessionContinuationCurrent = (captured: SessionContinuationCapture): void => {
  if (!isSessionContinuationCurrent(captured)) {
    throw new OfflineDomainSessionChangedError(
      captured.firebaseLifecycle?.uid || captured.domainUserId || 'unknown',
    );
  }
};

let pendingLogoutGeneration: number | null = null;
const MAX_TERMINATION_ATTEMPT_STATES = 64;
const terminationAttemptStateByGeneration = new Map<number, {
  durable: boolean;
  marker: AuthTerminationRecord;
}>();

const setTerminationAttemptState = (
  generation: number,
  state: { durable: boolean; marker: AuthTerminationRecord },
): void => {
  terminationAttemptStateByGeneration.delete(generation);
  terminationAttemptStateByGeneration.set(generation, state);
  for (const candidate of terminationAttemptStateByGeneration.keys()) {
    if (terminationAttemptStateByGeneration.size <= MAX_TERMINATION_ATTEMPT_STATES) break;
    // The mounted generation and a still-running logout are live synchronization state. Older
    // entries may be evicted because their durable marker remains in IndexedDB and retry closures
    // retain their own exact marker.
    if (candidate === firebaseAuthSessionGeneration || candidate === pendingLogoutGeneration) continue;
    terminationAttemptStateByGeneration.delete(candidate);
  }
};

let settingsUnsubscribe: (() => void) | null = null;
let materialsUnsubscribe: (() => void) | null = null;
let transactionsUnsubscribe: (() => void) | null = null;
let auditLogsUnsubscribe: (() => void) | null = null;
let usersUnsubscribe: (() => void) | null = null;
let generatorLogsUnsubscribe: (() => void) | null = null;
let appSyncUnsubscribe: (() => void) | null = null;
let cloudSyncGeneration = 0;
let cloudSyncOwnerUid: string | null = null;
export interface MonitoringDifference {
  collection: string;
  missingLocallyCount: number;
  missingCloudCount: number;
  contentMismatchCount: number;
  duplicateIdsCount: number;
  orphanCount?: number;
  warehouseBalanceDiff?: number;
  details: string;
}
let monitoringDifferences: MonitoringDifference[] = [];
let monitoringError: string | null = null;
const monitoringErrors: Record<string, string> = {};
const setMonitoringError = (collection: string, error: string | null) => {
  if (error) {
    monitoringErrors[collection] = error;
  } else {
    delete monitoringErrors[collection];
  }
  const errors = Object.values(monitoringErrors);
  monitoringError = errors.length > 0 ? errors.join(' | ') : null;
};
const monitoringReadyCollections: Set<string> = new Set();
let listenerMigrationCache: {
  key: string;
  keys: Set<string>;
  result: ReturnType<typeof migrateWarehouseModel>;
} | null = null;
let listenerMigrationCacheHits = 0;
let listenerMigrationCacheMisses = 0;
let pendingCloudWritesCount = 0;
let lastCloudWriteError: string | null = null;
/** m-RT-08: whether the work behind `lastCloudWriteError` is durably saved locally (drives the banner wording; never claims more than known). */
let lastCloudWriteErrorPersistence: SyncErrorPersistence = 'unknown';
let syncIssues: AppSyncIssue[] = [];
let syncIssueRefreshGeneration = 0;

const requestRemoteResolution = (userId: string, documentKeys: string[]): void => {
  addRemoteResolutionKeys(localStorage, userId, documentKeys);
};

const hasRemoteResolutionRequest = (userId: string, documentKey: string): boolean =>
  readRemoteResolutionKeys(localStorage, userId).has(documentKey);

const completeRemoteResolution = (userId: string, documentKey: string): void => {
  removeRemoteResolutionKey(localStorage, userId, documentKey);
};
const classifyWriteErrorPersistence = (err: unknown): SyncErrorPersistence => {
  const tag = appSyncEnqueueState(err);
  if (tag) return tag;
  return isStorageQuotaError(err) ? 'not-persisted' : 'unknown';
};
const handleCloudWriteError = (err: any, persistence?: SyncErrorPersistence) => {
  lastCloudWriteError = err ? safeResultMessage(err, 'sync') : 'خطأ غير معروف في السحابة';
  // An explicit call-site fact wins, except that a not-persisted/recovery tag on the error itself is never overridden by an optimistic claim.
  const fromError = classifyWriteErrorPersistence(err);
  lastCloudWriteErrorPersistence = fromError !== 'unknown' ? fromError : (persistence ?? 'unknown');
  dataService.notify();
};

const shouldRestoreLocalProjection = (error: unknown): boolean =>
  !(error instanceof OfflineDomainSessionChangedError
    || error instanceof OfflineDomainJournalRecoveryRequiredError
    || error instanceof OfflineDomainProjectionRecoveryRequiredError);

/** Captured at Firestore subscribe time — closed over by every monitoring-producing callback. */
type MonitoringSessionCapture = {
  generation: number;
  firebaseUid: string;
  firebaseLifecycle: FirebaseLifecycleCapture;
};

/**
 * Canonical P9 monitoring session guard (FV-P9-01).
 * An event may mutate monitoring mirrors ONLY when generation + auth uid + Offline Domain
 * owner + AppSync active user/lifecycle still match the session that created the listener.
 * Stale callbacks must be ignored (not clear or set current-session health).
 */
const isMonitoringSessionCurrent = (captured: MonitoringSessionCapture): boolean =>
  cloudSyncGeneration === captured.generation
  && isFirebaseLifecycleCurrent(captured.firebaseLifecycle)
  && getActiveOfflineDomainUserId() === captured.firebaseUid
  && getAppSyncSnapshot().activeUserId === captured.firebaseUid
  && getAppSyncLifecycle().userId === captured.firebaseUid;

const assertMonitoringSessionCurrent = (captured: MonitoringSessionCapture): void => {
  if (!isMonitoringSessionCurrent(captured)) throw new OfflineDomainSessionChangedError(captured.firebaseUid);
};

const assertMonitoringLifecycleOwnerCurrent = (captured: MonitoringSessionCapture): void => {
  assertFirebaseLifecycleCurrent(captured.firebaseLifecycle);
  if (getActiveOfflineDomainUserId() !== captured.firebaseUid) {
    throw new OfflineDomainSessionChangedError(captured.firebaseUid);
  }
};

const handleCloudListenerError = (
  err: unknown,
  collectionName: string,
  session: MonitoringSessionCapture,
): void => {
  if (!isMonitoringSessionCurrent(session)) return;
  const code = err && typeof err === 'object' && 'code' in err
    ? String((err as { code?: unknown }).code || 'unknown')
    : 'unknown';
  const message = `تعذر استمرار مزامنة ${collectionName} (${code}).`;
  // FV-P9-03: listener/reconciliation errors stay in monitoringErrors only.
  // Do not duplicate into lastCloudWriteError (write/enqueue/AppSync channel).
  setMonitoringError(collectionName, message);
  dataService.notify();
};

/**
 * FV-P9-02: After persist failure, restore/clear ONLY if captured monitoring session still
 * owns the Offline Domain. Stale reconciliation must never restore onto or clear the new
 * session's projection. Emergency clear uses owner-bound deactivateOfflineDomainForUser —
 * never unqualified clearOfflineDomainProjection().
 */
const createAuditId = (prefix = 'al'): string => {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${suffix}`;
};

const resolveAuditActor = (): { actorUserId: string; actorDisplayName: string } => {
  const currentUser = dataService.getCurrentUser();
  return {
    actorUserId: getActiveOfflineDomainUserId() || auth?.currentUser?.uid || currentUser?.authUid || currentUser?.id || 'system',
    actorDisplayName: currentUser?.fullName || 'مستخدم النظام',
  };
};

const operationTypeFor = (operations: SyncOperation[]): AuditEventContext['operationType'] => {
  const kinds = new Set(operations.map((operation) => {
    if (operation.kind === 'delete') return 'delete';
    return operation.expected.kind === 'missing' ? 'create' : 'update';
  }));
  return kinds.size === 1 && operations.length === 1
    ? ([...kinds][0] as AuditEventContext['operationType'])
    : 'batch';
};

const itemTypeFor = (operations: SyncOperation[]): string => {
  const collections = new Set(operations.map((operation) => operation.collection));
  if (collections.size !== 1) return 'إعدادات';
  if (collections.has('materials')) return 'مادة';
  if (collections.has('transactions')) return 'حركة';
  if (collections.has('generator_logs')) return 'مولد';
  return 'إعدادات';
};

const ATOMIC_AUDIT_STORAGE_KEY = 'remix_audit_logs_v1';

const parseAuditStorage = (raw: string | null): AuditLog[] => {
  const parsed = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(parsed)) throw new Error('AUDIT_LOG_STORAGE_INVALID');
  return parsed as AuditLog[];
};

const mergeAtomicAuditLogs = (raw: string | null, logs: AuditLog[]): string => {
  const parsed = parseAuditStorage(raw);
  const stagedIds = new Set(logs.map(log => log.id));
  return JSON.stringify([
    ...logs,
    ...parsed.filter((candidate: AuditLog) => !candidate || !stagedIds.has(candidate.id)),
  ]);
};

const prepareAtomicMutationAudits = (
  label: string,
  operations: SyncOperation[],
  mutationId: string,
): AuditLog[] => {
  // Validate the existing Audit projection before producing staged evidence, but do not publish it.
  parseAuditStorage(localStorage.getItem(ATOMIC_AUDIT_STORAGE_KEY));
  const actor = resolveAuditActor();
  return operations.map(operation => buildAuditLog({
    id: `${mutationId}--${operation.collection}--${operation.docId}`,
    timestamp: new Date().toISOString(),
    actorUserId: actor.actorUserId,
    actorDisplayName: actor.actorDisplayName,
    action: 'تثبيت عملية محلية ذرية',
    details: label,
    itemType: itemTypeFor([operation]),
    context: {
      operationType: operationTypeFor([operation]),
      affectedEntities: [`${operation.collection}/${operation.docId}`],
      templateId: 'domain_mutation',
    },
  }));
};

const publishAtomicMutationAudits = (logs: AuditLog[]): { previousRaw: string | null; nextRaw: string } => {
  const previousRaw = localStorage.getItem(ATOMIC_AUDIT_STORAGE_KEY);
  const nextRaw = mergeAtomicAuditLogs(previousRaw, logs);
  localStorage.setItem(ATOMIC_AUDIT_STORAGE_KEY, nextRaw);
  return { previousRaw, nextRaw };
};

/**
 * R2-P10-01: present staged Audit bytes only to the mutation's atomic OfflineDomain snapshot.
 * The shared live projection remains unchanged until commitActiveOfflineMutation succeeds, so an
 * unrelated persistence cannot capture success evidence for work that a later POL-4 fence refuses.
 */
const stagedAtomicAuditStorage = (
  logs: AuditLog[],
): { storage: Storage; stagedAuditRaw: () => string | null } => {
  let capturedAuditRaw: string | null = null;
  const storage: Storage = {
    get length() { return localStorage.length; },
    clear: () => localStorage.clear(),
    key: (index: number) => localStorage.key(index),
    getItem: (key: string) => {
      if (key !== ATOMIC_AUDIT_STORAGE_KEY) return localStorage.getItem(key);
      capturedAuditRaw = mergeAtomicAuditLogs(localStorage.getItem(key), logs);
      return capturedAuditRaw;
    },
    removeItem: (key: string) => localStorage.removeItem(key),
    setItem: (key: string, value: string) => localStorage.setItem(key, value),
  };
  return { storage, stagedAuditRaw: () => capturedAuditRaw };
};


const slimSettingsCloudValue = (settings: AppSettings): Record<string, unknown> =>
  toSlimSettingsRoot(withSettingsAttachmentManifest(canonicalizeWarehouseSettings({ ...settings })) as AppSettings);

const settingsRootSyncOp = (next: AppSettings, previous: AppSettings | undefined) =>
  createSyncSetOperation(
    'settings',
    'app_config',
    slimSettingsCloudValue(next),
    previous ? slimSettingsCloudValue(previous) : undefined,
  );

const assertProtectedCloudEnqueueAllowed = (): void => {
  const blocked = getProtectedCloudEnqueueBlockReason();
  if (blocked) {
    throw new Error(`PROTECTED_ENQUEUE_REFUSED:${blocked}`);
  }
};

const queueCloudMutation = async (
  operations: SyncOperation[],
  label: string,
  options: {
    requireRemoteCommit?: boolean;
    scheduleFlush?: boolean;
    clientMutationId?: string;
    createdAt?: number;
  } = {},
): Promise<void> => {
  const settings = dataService.getSettings();
  const stableMutationId = typeof options.clientMutationId === 'string'
    ? options.clientMutationId.trim()
    : '';
  const mutationId = stableMutationId || createAuditId('domain');
  const atomicAuditLogs = label === 'append-audit-log' || operations.length === 0
    ? null
    : prepareAtomicMutationAudits(label, operations, mutationId);
  if (atomicAuditLogs) {
    publishAtomicMutationAudits(atomicAuditLogs);
  }
  const durableOperations: SyncOperation[] = atomicAuditLogs
    ? [
        ...operations,
        ...atomicAuditLogs.map(log => createSyncSetOperation(
          'audit_logs',
          log.id,
          log as unknown as Record<string, unknown>,
          undefined,
        )),
      ]
    : operations;

  if (!isSupabaseConfigured() || !CLOUD_WRITES_ENABLED || !settings.cloudSyncEnabled || durableOperations.length === 0) {
    return;
  }

  assertProtectedCloudEnqueueAllowed();
  pendingCloudWritesCount += 1;
  dataService.notify();
  try {
    const upsertsByTable = new Map<SupabaseTableName, Array<{ id: string; payload: Record<string, unknown> }>>();
    const deletesByTable = new Map<SupabaseTableName, string[]>();

    for (const op of durableOperations) {
      const table = op.collection as SupabaseTableName;
      if (op.kind === 'delete') {
        const list = deletesByTable.get(table) || [];
        list.push(op.docId);
        deletesByTable.set(table, list);
      } else if (op.value) {
        const list = upsertsByTable.get(table) || [];
        const payload = table === "settings" && op.docId === "app_config"
          ? { ...(dataService.getSettings() as unknown as Record<string, unknown>), id: op.docId }
          : { ...op.value, id: op.docId };
        list.push({ id: op.docId, payload });
        upsertsByTable.set(table, list);
      }
    }

    for (const [table, entries] of upsertsByTable.entries()) {
      await supabaseDb.upsertDocs(table, entries);
    }
    for (const [table, ids] of deletesByTable.entries()) {
      await supabaseDb.deleteDocs(table, ids);
    }
    lastCloudWriteError = null;
    lastCloudWriteErrorPersistence = 'unknown';
  } catch (error) {
    handleCloudWriteError(error, 'persisted');
    if (options.requireRemoteCommit) throw error;
  } finally {
    pendingCloudWritesCount = Math.max(0, pendingCloudWritesCount - 1);
    dataService.notify();
  }
};

const commitOfflineProjectionWrite = async (
  write: (storage: Storage) => void,
  assertSessionCurrent?: () => void,
  assertLifecycleCurrent?: () => void,
): Promise<void> => {
  assertSessionCurrent?.();
  write(localStorage);
  assertLifecycleCurrent?.();
};

const getOutstandingSyncWorkCount = async (): Promise<number> => {
  return pendingCloudWritesCount;
};

const STORAGE_KEYS = {
  MATERIALS: 'remix_materials_v1',
  PESTICIDES: 'remix_pesticides_v1',
  TRANSACTIONS: 'remix_transactions_v1',
  AUDIT_LOGS: 'remix_audit_logs_v1',
  SETTINGS: 'remix_settings_v1',
  USERS: 'remix_users_v1',
  GENERATOR_LOGS: 'remix_generator_logs_v1',
  IS_LOGGED_IN: 'remix_is_logged_in',
  CURRENT_USER: 'remix_current_user_v1',
};
const LEGACY_LOCALLY_TERMINATED_FIREBASE_UID_KEY = 'remix_locally_terminated_firebase_uid_v1';
const locallyTerminatedFirebaseUidKey = (uid: string): string =>
  `${LEGACY_LOCALLY_TERMINATED_FIREBASE_UID_KEY}:${encodeURIComponent(uid)}`;
const DEFAULT_SETTINGS: AppSettings = {
  organizationName: 'مكتب صحة البيئة - خان يونس',
  departmentName: 'دائرة البنى التحتية والتخطيط والتطوير',
  expiryWarningThresholdDays: 90,
  categories: [
    { name: 'مبيدات حشرية', prefix: 'PES', startRange: 1000, endRange: 1999 },
    { name: 'معقمات ومطهرات', prefix: 'SAN', startRange: 2000, endRange: 2999 },
    { name: 'أدوات ومعدات رش', prefix: 'EQP', startRange: 3000, endRange: 3999 },
    { name: 'مصائد قوارض', prefix: 'TRP', startRange: 4000, endRange: 4999 },
    { name: 'كلور ومواد كيميائية', prefix: 'CHM', startRange: 5000, endRange: 5999 }
  ],
  units: ['لتر', 'كجم', 'قطعة', 'علبة', 'جالون'],
  storehouses: ['المخزن الرئيسي', 'مستودع السموم والمبيدات', 'مستودع الأجهزة والمعدات', 'مستودع طعوم القوارض', 'مخزن أدوات السلامة', 'مخزن ب'],
  cloudSyncEnabled: true,
  storekeeperName: '',
  systemManagerName: '',
  healthDirectorName: '',
  showStorekeeperSignature: true,
  showSystemManagerSignature: true,
  showHealthDirectorSignature: true,
  transactionCounters: { inbound: 0, outbound: 0, consumed: 0 },
  partners: []
};

const P5_SCOPE_V2_KEY = 'inventory_app_storehouse_scope_v2';
const P5_SCOPE_LEGACY_KEY = 'inventory_app_storehouse_filter';
let warehouseMigrationRunning = false;

const getPersistedWarehouseScopeReference = (): string =>
  localStorage.getItem(P5_SCOPE_V2_KEY) ||
  globalThis.localStorage?.getItem(P5_SCOPE_V2_KEY) ||
  localStorage.getItem(P5_SCOPE_LEGACY_KEY) ||
  globalThis.localStorage?.getItem(P5_SCOPE_LEGACY_KEY) ||
  'all';

function ensureWarehouseLocalMigration(): void {
  if (warehouseMigrationRunning) return;
  const rawSettings = localStorage.getItem(STORAGE_KEYS.SETTINGS);
  const rawMaterials = localStorage.getItem(STORAGE_KEYS.MATERIALS);
  const rawTransactions = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
  if (!rawSettings || (!rawMaterials && !rawTransactions)) return;

  warehouseMigrationRunning = true;
  try {
    const settings = JSON.parse(rawSettings) as AppSettings;
    const materials = rawMaterials ? JSON.parse(rawMaterials) as Material[] : [];
    const transactions = rawTransactions ? JSON.parse(rawTransactions) as InventoryTransaction[] : [];
    const result = migrateWarehouseModel({
      settings,
      materials,
      transactions,
      selectedStorehouse: getPersistedWarehouseScopeReference(),
    });
    if (result.errors.length > 0) {
      throw new Error(`WAREHOUSE_MIGRATION_BLOCKED: ${result.errors.join(' | ')}`);
    }
    if (result.changed) {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(result.settings));
      if (rawMaterials) localStorage.setItem(STORAGE_KEYS.MATERIALS, JSON.stringify(result.materials));
      if (rawTransactions) localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(result.transactions));
    }
    localStorage.setItem(P5_SCOPE_V2_KEY, result.selectedStorehouseId);
    if (result.selectedStorehouseId === 'all') {
      localStorage.setItem(P5_SCOPE_LEGACY_KEY, 'all');
    } else {
      const selected = result.settings.storehouseEntities?.find((item) => item.id === result.selectedStorehouseId);
      localStorage.setItem(P5_SCOPE_LEGACY_KEY, selected?.name || 'all');
    }
  } finally {
    warehouseMigrationRunning = false;
  }
}

const INITIAL_USERS: SystemUser[] = [];

// Initial realistic seed data if localStorage is empty
const INITIAL_MATERIALS: Material[] = [];


const INITIAL_TRANSACTIONS: InventoryTransaction[] = [];

const INITIAL_AUDIT_LOGS: AuditLog[] = [];

let firebaseOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    firebaseOnline = true;
    dataService.notify();
  });
  window.addEventListener('offline', () => {
    firebaseOnline = false;
    dataService.notify();
  });
}

const ensureCloudSettingsSeeded = async (
  baseSettings?: AppSettings,
  _options: { includeRoot?: boolean } = {},
): Promise<void> => {
  if (!isSupabaseConfigured() || !CLOUD_WRITES_ENABLED) return;
  const currentSettings = canonicalizeWarehouseSettings(baseSettings ?? dataService.getSettings());
  if (!currentSettings.cloudSyncEnabled) return;
  if (!getCurrentAuthUser()) return;
  try {
    const existing = await supabaseDb.getDoc('settings', 'app_config');
    if (existing) return;
    const { openingStockAttachment: _singularQuarantined, ...withoutSingular } = currentSettings as AppSettings & {
      openingStockAttachment?: string;
    };
    const settingsToSave = withSettingsAttachmentManifest({
      ...withoutSingular,
      cloudSyncEnabled: true,
      firebaseInitialized: true,
    }) as AppSettings;
    await supabaseDb.upsertDoc('settings', 'app_config', settingsToSave as unknown as Record<string, unknown>);
  } catch {
    // Best-effort initial settings seed
  }
};

export const dataService = {
  getPendingCloudWritesCount: () => pendingCloudWritesCount,
  getMonitoringDifferences: () => monitoringDifferences,
  getMonitoringError: () => monitoringError,
  getLastCloudWriteError: () => lastCloudWriteError,
  /** m-RT-08: persisted-state of the work behind the last write/enqueue error (`unknown` when there is no error or no evidence). */
  getLastCloudWriteErrorPersistence: (): SyncErrorPersistence => (lastCloudWriteError ? lastCloudWriteErrorPersistence : 'unknown'),
  /** PREPROD-D: read-only count of durable outstanding sync work (queue + journals); never mutates. */
  getOutstandingSyncWorkCount: (): Promise<number> => getOutstandingSyncWorkCount(),
  getSyncIssues: () => syncIssues,
  getMonitoringReadyCollections: (): string[] => [...monitoringReadyCollections],
  getExpectedMonitoringCollections: (): string[] =>
    resolveExpectedMonitoringCollections((permission) => dataService.hasPermission(permission)),
  getMissingMonitoringCollections: (): string[] => {
    const expected = dataService.getExpectedMonitoringCollections();
    return expected.filter(collection => !monitoringReadyCollections.has(collection));
  },
  getMonitoringReadySnapshot: (): MonitoringReadySnapshot => {
    const expected = dataService.getExpectedMonitoringCollections();
    const ready = [...monitoringReadyCollections];
    return {
      expected,
      ready,
      missing: expected.filter(collection => !monitoringReadyCollections.has(collection)),
    };
  },
  getMonitoringOutboxCounts: (): MonitoringOutboxCounts => {
    const snapshot = getAppSyncSnapshot();
    return {
      staging: snapshot.staging,
      pending: snapshot.pending,
      retrying: snapshot.retrying,
      flushing: snapshot.flushing,
      conflicts: snapshot.conflicts,
      blocked: snapshot.blocked,
      quarantined: snapshot.quarantined,
    };
  },
  getMonitoringHealth: (): MonitoringHealth => {
    const snapshot = getAppSyncSnapshot();
    const lifecycle = getAppSyncLifecycle();
    const settings = dataService.getSettings();
    const outbox: MonitoringOutboxCounts = {
      staging: snapshot.staging,
      pending: snapshot.pending,
      retrying: snapshot.retrying,
      flushing: snapshot.flushing,
      conflicts: snapshot.conflicts,
      blocked: snapshot.blocked,
      quarantined: snapshot.quarantined,
    };
    const authUserId = getCurrentAuthUser()?.uid ?? null;
    const domainUserId = getActiveOfflineDomainUserId() ?? authUserId;
    const activeUserId = snapshot.activeUserId ?? cloudSyncOwnerUid ?? authUserId;
    return deriveMonitoringHealth({
      cloudSyncEnabled: !!settings.cloudSyncEnabled,
      firebaseAvailable: isSupabaseConfigured(),
      online: dataService.isFirebaseOnline(),
      authUserId,
      domainUserId,
      activeUserId,
      lifecycleGeneration: lifecycle.generation,
      listenersSessionActive: cloudSyncOwnerUid != null
        && cloudSyncOwnerUid === activeUserId,
      expectedCollections: resolveExpectedMonitoringCollections(
        (permission) => dataService.hasPermission(permission),
      ),
      readyCollections: [...monitoringReadyCollections],
      outbox,
      monitoringErrors: { ...monitoringErrors },
      writeOrEnqueueError: lastCloudWriteError,
      syncIssues,
      differences: monitoringDifferences,
    });
  },
  resolveSyncIssue: async (
    id: string,
    action: 'retry-blocked' | 'use-local' | 'use-remote',
  ): Promise<{ success: boolean; message: string }> => {
    const resolveContinuation = captureSessionContinuation();
    try {
      if (action === 'retry-blocked') await retryBlockedAppSyncIssue(id);
      else if (action === 'use-local') await resolveConflictUsingLocal(id);
      else {
        const firebaseUid = auth?.currentUser?.uid;
        if (!firebaseUid) throw new Error('SYNC_AUTH_REQUIRED');
        const issue = (await listAppSyncIssues()).find(candidate => candidate.id === id && candidate.status === 'conflict');
        if (!issue) throw new Error('SYNC_CONFLICT_NOT_FOUND');
        requestRemoteResolution(firebaseUid, issue.documentKeys);
        try {
          await discardAppSyncIssue(id);
        } catch (error) {
          issue.documentKeys.forEach(key => completeRemoteResolution(firebaseUid, key));
          throw error;
        }
        await initCloudSync();
      }
      const latestIssues = await listAppSyncIssues();
      if (isSessionContinuationCurrent(resolveContinuation)) {
        syncIssues = latestIssues;
        dataService.notify();
      }
      return {
        success: true,
        message: action === 'use-remote'
          ? 'تم تسجيل قرار اعتماد النسخة السحابية، وسيُطبّق بعد وصول لقطة سحابية موثوقة واجتياز فحص سلامة المخزون.'
          : action === 'use-local'
            ? 'تم تحديث خط الأساس وإعادة محاولة التغيير المحلي بأمان.'
            : 'تمت إعادة محاولة العملية المحجوبة.',
      };
    } catch (error) {
      const message = safeResultMessage(error, 'sync');
      if (isSessionContinuationCurrent(resolveContinuation)) {
        lastCloudWriteError = message;
        dataService.notify();
      }
      return { success: false, message };
    }
  },
  // DATA CHANGE SUBSCRIPTIONS
  subscribe: (listener: DataChangeListener) => {
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  },

  notify: () => {
    changeListeners.forEach((listener) => {
      try {
        listener();
      } catch (_) {

      }
    });
  },

  // SETTINGS
  getSettings: (): AppSettings => {
    const data = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!data) {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(DEFAULT_SETTINGS));
      return DEFAULT_SETTINGS;
    }
    try {
      const parsed = JSON.parse(data);
      if (!parsed.storehouses || !Array.isArray(parsed.storehouses)) {
        parsed.storehouses = DEFAULT_SETTINGS.storehouses;
      }
      // Seamless migration for category configs (if array of strings, convert to objects)
      if (parsed.categories && Array.isArray(parsed.categories)) {
        parsed.categories = parsed.categories.map((cat: any, index: number) => {
          if (typeof cat === 'string') {
            const names = ['مبيدات حشرية', 'معقمات ومطهرات', 'أدوات ومعدات رش', 'مصائد قوارض', 'كلور ومواد كيميائية'];
            const idx = names.indexOf(cat);
            const prefix = idx !== -1 ? ['PES', 'SAN', 'EQP', 'TRP', 'CHM'][idx] : 'GEN';
            const startRange = idx !== -1 ? [1000, 2000, 3000, 4000, 5000][idx] : (index + 1) * 1000;
            return {
              name: cat,
              prefix,
              startRange,
              endRange: startRange + 999
            };
          }
          return cat;
        });
      } else {
        parsed.categories = DEFAULT_SETTINGS.categories;
      }

      // Sanitize organizationName and departmentName if they contain the deleted phrases
      const forbiddenPhrases = ['سلطة المياه والبيئة والبلديات', 'بلدية خان يونس'];
      let needsSave = false;

      // Always force cloudSyncEnabled to true as requested by the user to make cloud sync mandatory
      if (parsed.cloudSyncEnabled !== true) {
        parsed.cloudSyncEnabled = true;
        needsSave = true;
      }

      if (parsed.organizationName) {
        for (const phrase of forbiddenPhrases) {
          if (parsed.organizationName.includes(phrase)) {
            parsed.organizationName = DEFAULT_SETTINGS.organizationName;
            needsSave = true;
            break;
          }
        }
      } else {
        parsed.organizationName = DEFAULT_SETTINGS.organizationName;
        needsSave = true;
      }

      if (parsed.departmentName) {
        for (const phrase of forbiddenPhrases) {
          if (parsed.departmentName.includes(phrase)) {
            parsed.departmentName = DEFAULT_SETTINGS.departmentName;
            needsSave = true;
            break;
          }
        }
      } else {
        parsed.departmentName = DEFAULT_SETTINGS.departmentName;
        needsSave = true;
      }
      
      if (!parsed.transactionCounters) {
        parsed.transactionCounters = { inbound: 0, outbound: 0, consumed: 0 };
        needsSave = true;
      }

      if (!parsed.partners || !Array.isArray(parsed.partners)) {
        parsed.partners = DEFAULT_SETTINGS.partners || [];
        needsSave = true;
      }

      const warehouseCanonical = canonicalizeWarehouseSettings(parsed as AppSettings);
      if (parsed.warehouseSchemaVersion !== 2 || !Array.isArray(parsed.storehouseEntities) || JSON.stringify(parsed.storehouses) !== JSON.stringify(warehouseCanonical.storehouses)) {
        Object.assign(parsed, warehouseCanonical);
        needsSave = true;
      }

      if (needsSave) {
        localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(parsed));
      }
      return parsed;
    } catch (e) {
      return DEFAULT_SETTINGS;
    }
  },
  saveSettings: async (settings: AppSettings): Promise<void> => {
    const previousSettings = dataService.getSettings();
    const previousRaw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    const canonicalSettings = canonicalizeWarehouseSettings(settings);
    canonicalSettings.cloudSyncEnabled = true;
    const { openingStockAttachment: _singularQuarantined, ...withoutSingular } = canonicalSettings as AppSettings & {
      openingStockAttachment?: string;
    };
    const settingsToSave = withSettingsAttachmentManifest({ ...withoutSingular }) as AppSettings;
    try {
      assertComposedSettingsViewModel(settingsToSave as unknown as Record<string, unknown>);
    } catch (error) {
      throw new Error(productLimitMessage(error));
    }

    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settingsToSave));
    try {
      await queueCloudMutation([
        settingsRootSyncOp(settingsToSave, previousSettings),
      ], 'save-settings-atomic');
    } catch (error) {
      if (previousRaw === null) localStorage.removeItem(STORAGE_KEYS.SETTINGS);
      else localStorage.setItem(STORAGE_KEYS.SETTINGS, previousRaw);
      throw error;
    }
    await dataService.logAudit('تحديث الإعدادات', 'تم تحديث الإعدادات العامة للمنظمة وحقول التنبيه والتصنيفات', 'إعدادات');
    dataService.recordLocalWrite();
    dataService.notify();
  },

  saveOpeningStockAttachment: async (key: string, data: string | null): Promise<void> => {
    const previousSettings = dataService.getSettings();
    const previousRaw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    const attachments = { ...(previousSettings.openingStockAttachments || {}) };
    if (data === null || data === undefined) delete attachments[key];
    else attachments[key] = data;
    const updated = withSettingsAttachmentManifest({
      ...previousSettings,
      openingStockAttachments: Object.keys(attachments).length > 0 ? attachments : undefined,
    }) as AppSettings;
    if (Object.keys(attachments).length === 0) {
      delete (updated as AppSettings).openingStockAttachments;
      delete (updated as AppSettings).openingStockAttachmentKeys;
    }
    try {
      assertComposedSettingsViewModel(updated as unknown as Record<string, unknown>);
    } catch (error) {
      throw new Error(productLimitMessage(error));
    }
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(updated));
    const docId = openingAttachmentDocId(key);
    try {
      await queueCloudMutation([
        settingsRootSyncOp(updated, previousSettings),
      ], `save-opening-attachment:${docId}`);
    } catch (error) {
      if (previousRaw === null) localStorage.removeItem(STORAGE_KEYS.SETTINGS);
      else localStorage.setItem(STORAGE_KEYS.SETTINGS, previousRaw);
      throw error;
    }
    dataService.recordLocalWrite();
    dataService.notify();
  },

  getStorehouses: (includeInactive = false) => {
    const entities = getStorehouseEntities(dataService.getSettings());
    return includeInactive ? entities : entities.filter((item) => item.active);
  },

  addStorehouse: async (name: string): Promise<{ success: boolean; message: string }> => {
    if (!dataService.hasPermission('settings_edit')) return { success: false, message: 'PERMISSION_DENIED: settings_edit' };
    try {
      const updated = addOrReactivateWarehouse(dataService.getSettings(), name);
      await dataService.saveSettings(updated);
      dataService.notify();
      return { success: true, message: 'تمت إضافة/إعادة تفعيل المستودع بهوية ثابتة بنجاح.' };
    } catch (error) {
      return { success: false, message: safeResultMessage(error, 'generic') };
    }
  },

  setStorehouseActive: async (reference: string, active: boolean): Promise<{ success: boolean; message: string }> => {
    if (!dataService.hasPermission('settings_edit')) return { success: false, message: 'PERMISSION_DENIED: settings_edit' };
    try {
      const updated = setWarehouseEntityActive(dataService.getSettings(), reference, active);
      await dataService.saveSettings(updated);
      dataService.notify();
      return { success: true, message: active ? 'تم تفعيل المستودع بنجاح.' : 'تم تعطيل المستودع مع الاحتفاظ ببياناته التاريخية.' };
    } catch (error) {
      return { success: false, message: safeResultMessage(error, 'generic') };
    }
  },

  renameStorehouse: async (reference: string, newName: string): Promise<{ success: boolean; message: string }> => {
    if (!dataService.hasPermission('settings_edit')) return { success: false, message: 'PERMISSION_DENIED: settings_edit' };
    try {
      const updated = renameWarehouseEntity(dataService.getSettings(), reference, newName);
      await dataService.saveSettings(updated);
      dataService.notify();
      return { success: true, message: 'تم تغيير اسم المستودع مع الحفاظ على هويته الثابتة.' };
    } catch (error) {
      return { success: false, message: safeResultMessage(error, 'generic') };
    }
  },

  reorderStorehouse: async (reference: string, direction: 'up' | 'down'): Promise<{ success: boolean; message: string }> => {
    if (!dataService.hasPermission('settings_edit')) return { success: false, message: 'PERMISSION_DENIED: settings_edit' };
    try {
      const updated = reorderWarehouseEntity(dataService.getSettings(), reference, direction);
      await dataService.saveSettings(updated);
      dataService.notify();
      return { success: true, message: 'تم تحديث ترتيب المستودعات مع الحفاظ على هوياتها الثابتة.' };
    } catch (error) {
      return { success: false, message: safeResultMessage(error, 'generic') };
    }
  },

  updateReferenceValues: async (type: 'category' | 'unit' | 'storehouse', oldValue: string, newValue: string): Promise<void> => {
    if (type === 'storehouse') {
      const result = await dataService.renameStorehouse(oldValue, newValue);
      if (!result.success) throw new Error(result.message);
      return;
    }
    const materials = dataService.getMaterials();
    for (const material of materials) {
      if (type === 'category' && material.category === oldValue) { material.category = newValue; await dataService.saveMaterial(material); }
      if (type === 'unit' && material.unit === oldValue) { material.unit = newValue; await dataService.saveMaterial(material); }
    }

    const transactions = dataService.getTransactions();
    for (const transaction of transactions) {
      if (type === 'category' && transaction.itemCategory === oldValue) { transaction.itemCategory = newValue; await dataService.saveTransaction(transaction); }
      if (type === 'unit' && transaction.unit === oldValue) { transaction.unit = newValue; await dataService.saveTransaction(transaction); }
    }
  },

  // MATERIALS
  getMaterials: (): Material[] => {
    let data = localStorage.getItem(STORAGE_KEYS.MATERIALS);
    let items: Material[] = [];
    if (!data) {
      localStorage.setItem(STORAGE_KEYS.MATERIALS, JSON.stringify(INITIAL_MATERIALS));
      items = INITIAL_MATERIALS;
    } else {
      try {
        items = JSON.parse(data);
      } catch (e) {
        items = INITIAL_MATERIALS;
      }
    }

    // SILENT DATA MIGRATION: Merge old pesticides into standard items/materials
    const pData = localStorage.getItem(STORAGE_KEYS.PESTICIDES);
    if (pData) {
      try {
        const pesticidesList = JSON.parse(pData);
        if (Array.isArray(pesticidesList) && pesticidesList.length > 0) {
          let updated = false;
          pesticidesList.forEach((pes) => {
            const alreadyExists = items.some(item => item.code === pes.code || item.name === pes.name || item.id === pes.id);
            if (!alreadyExists) {
              items.push({
                id: pes.id,
                code: pes.code,
                name: pes.name,
                category: pes.category || 'مبيدات حشرية',
                unit: pes.unit || 'لتر',
                minimumStock: pes.minimumStock || 10,
                currentStock: 0,
                storageLocation: pes.storageLocation || 'مستودع السموم والمبيدات',
                notes: pes.notes || 'مستورد ومرحل من شاشة المبيدات المستقلة السابقة',
                createdAt: pes.createdAt || new Date().toISOString(),
                updatedAt: pes.updatedAt || new Date().toISOString(),
                type: 'مادة',
              });
              updated = true;
            }
          });
          if (updated) {
            localStorage.setItem(STORAGE_KEYS.MATERIALS, JSON.stringify(items));
          }
        }
        localStorage.removeItem(STORAGE_KEYS.PESTICIDES); // Done migration, clear key!
      } catch (_) {

      }
    }

    // Calculate currentStock dynamically from canonical transaction warehouse ids.
    const transactions = dataService.getTransactions();
    const migratedItemsRaw = localStorage.getItem(STORAGE_KEYS.MATERIALS);
    if (migratedItemsRaw) {
      const reparsed = JSON.parse(migratedItemsRaw);
      if (Array.isArray(reparsed)) items = reparsed;
    }
    const warehouseProjectionSettings = dataService.getSettings();
    const warehouseEntities = getStorehouseEntities(warehouseProjectionSettings);
    const warehouseById = new Map(warehouseEntities.map((entry) => [entry.id, entry] as const));

    return items.map((item) => {
      const itemTransactions = transactions.filter((t) => t.itemId === item.id);
      const initTransactions = itemTransactions.filter((t) => t.id.startsWith('tr-init') || t.transactionType === 'افتتاحي');
      const nonInitTransactions = itemTransactions.filter((t) => !t.id.startsWith('tr-init') && t.transactionType !== 'افتتاحي');
      const defaultEntity = item.primaryStorehouseId
        ? warehouseById.get(item.primaryStorehouseId)
        : getStorehouseByReference(warehouseProjectionSettings, item.storageLocation, true);
      const defaultStorehouseId = defaultEntity?.id;
      const warehouseStocksById: Record<string, number> = {};
      const addStock = (storehouseId: string | undefined, quantity: number) => {
        if (!storehouseId || !warehouseById.has(storehouseId)) throw new Error(`WAREHOUSE_REFERENCE_UNRESOLVED:MATERIAL:${item.id}`);
        warehouseStocksById[storehouseId] = (warehouseStocksById[storehouseId] || 0) + quantity;
      };

      if (initTransactions.length > 0) {
        for (const tx of initTransactions) addStock(tx.storehouseId, tx.quantity);
      } else if (item.initialStock !== undefined && item.initialStock > 0) {
        addStock(defaultStorehouseId, item.initialStock);
      }

      for (const tx of nonInitTransactions) {
        const storehouseId = tx.storehouseId;
        if (
          tx.transactionType === 'وارد' ||
          (tx.transactionType === 'تحويل' && tx.transferType === 'in') ||
          (tx.transactionType === 'تسوية' && (tx.transferType === 'in' || tx.quantity >= 0))
        ) addStock(storehouseId, tx.quantity);
        else addStock(storehouseId, -tx.quantity);
      }

      const warehouseStocks: Record<string, number> = {};
      let currentStock = 0;
      for (const [storehouseId, stock] of Object.entries(warehouseStocksById)) {
        const entity = warehouseById.get(storehouseId);
        if (!entity) throw new Error(`WAREHOUSE_ID_UNRESOLVED:${storehouseId}`);
        if (entity.active) {
          warehouseStocks[entity.name] = stock;
          currentStock += stock;
        }
      }
      return { ...item, primaryStorehouseId: defaultStorehouseId, currentStock, warehouseStocks, warehouseStocksById };
    });
  },

  saveMaterialWithOpeningStock: async (
    material: Material,
    openingTransaction: InventoryTransaction,
  ): Promise<void> => {
    const previousMaterialsRaw = localStorage.getItem(STORAGE_KEYS.MATERIALS);
    const previousTransactionsRaw = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
    const previousSettingsRaw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    const materials = dataService.getMaterials();
    if (materials.some(existing => existing.id === material.id)) throw new Error('MATERIAL_ID_COLLISION');
    if (materials.some(existing => existing.code.toLowerCase() === material.code.toLowerCase())) {
      throw new Error('UNIQUE_CODE_COLLISION');
    }

    const settings = dataService.getSettings();
    const previousSettings = JSON.parse(JSON.stringify(settings)) as AppSettings;
    const resolvedScope = resolveWarehouseScope(settings, getPersistedWarehouseScopeReference());
    const requestedWarehouse = getStorehouseByReference(
      settings,
      material.primaryStorehouseId || material.storageLocation,
      false,
    );
    const scopedWarehouse = resolvedScope.scope === 'warehouse'
      ? getStorehouseByReference(settings, resolvedScope.selectedStorehouseId, false)
      : undefined;
    const targetWarehouse = scopedWarehouse || requestedWarehouse;
    if (!targetWarehouse) throw new Error('يجب تحديد مستودع فعال وصالح للصنف.');

    const quantity = Number(openingTransaction.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || openingTransaction.transactionType !== 'افتتاحي') {
      throw new Error('حركة الرصيد الافتتاحي غير صالحة.');
    }
    if (openingTransaction.itemId !== material.id) throw new Error('OPENING_MATERIAL_ID_MISMATCH');

    const existingTransactions = dataService.getTransactions() as IntegrityTransaction[];
    if (existingTransactions.some(transaction => transaction.id === openingTransaction.id)) {
      throw new Error('TRANSACTION_ID_COLLISION');
    }
    const existingNumbers = new Set(
      existingTransactions
        .map(transaction => transaction.transactionNumber?.trim())
        .filter((value): value is string => !!value),
    );
    const counters = {
      inbound: settings.transactionCounters?.inbound || 0,
      outbound: settings.transactionCounters?.outbound || 0,
      consumed: settings.transactionCounters?.consumed || 0,
      transfer: settings.transactionCounters?.transfer || 0,
      adjustment: settings.transactionCounters?.adjustment || 0,
      opening: settings.transactionCounters?.opening || 0,
    };
    let transactionNumber = '';
    do {
      counters.opening += 1;
      transactionNumber = `OP-${String(counters.opening).padStart(4, '0')}`;
    } while (existingNumbers.has(transactionNumber));
    settings.transactionCounters = counters;

    const now = new Date().toISOString();
    const preparedMaterial: Material = {
      ...material,
      primaryStorehouseId: targetWarehouse.id,
      storageLocation: targetWarehouse.name,
    };
    const preparedOpening: IntegrityTransaction = {
      ...openingTransaction,
      transactionNumber,
      itemId: preparedMaterial.id,
      itemCode: preparedMaterial.code,
      itemName: preparedMaterial.name,
      itemCategory: preparedMaterial.category,
      unit: preparedMaterial.unit,
      quantity,
      storehouseId: targetWarehouse.id,
      storehouse: targetWarehouse.name,
      stockBefore: 0,
      stockAfter: quantity,
      createdAt: openingTransaction.createdAt || now,
      updatedAt: now,
    };
    const nextMaterials = [...materials, preparedMaterial];
    const nextTransactions = [preparedOpening, ...existingTransactions];
    const writeLimit = validateAtomicWriteCount(3, MAX_ATOMIC_FIRESTORE_WRITES);
    if (!writeLimit.valid) throw new Error(writeLimit.errors[0].message);
    const integrity = validateInventoryDataset(nextTransactions, {
      materials: nextMaterials,
      storehouses: getStorehouseEntities(settings),
    });
    const legacyTransferIds = new Set(
      nextTransactions
        .filter(transaction => transaction.transactionType === 'تحويل' && !transaction.operationId && !transaction.pairedTransactionId)
        .map(transaction => transaction.id),
    );
    const blockingErrors = integrity.errors.filter(error =>
      !(error.code === 'TRANSFER_OPERATION_REQUIRED' && !!error.transactionId && legacyTransferIds.has(error.transactionId))
    );
    if (blockingErrors.length > 0) throw new Error(blockingErrors[0].message);

    try {
      await ensureCloudSettingsSeeded(previousSettings, { includeRoot: false });
      localStorage.setItem(STORAGE_KEYS.MATERIALS, JSON.stringify(nextMaterials));
      localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(nextTransactions));
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
      await queueCloudMutation([
        settingsRootSyncOp(settings, previousSettings),
        createSyncSetOperation('materials', preparedMaterial.id, preparedMaterial as unknown as Record<string, unknown>, undefined),
        createSyncSetOperation('transactions', preparedOpening.id, preparedOpening as unknown as Record<string, unknown>, undefined),
      ], 'create-material-with-opening-stock');
    } catch (error) {
      if (!shouldRestoreLocalProjection(error)) throw error;
      if (previousMaterialsRaw === null) localStorage.removeItem(STORAGE_KEYS.MATERIALS);
      else localStorage.setItem(STORAGE_KEYS.MATERIALS, previousMaterialsRaw);
      if (previousTransactionsRaw === null) localStorage.removeItem(STORAGE_KEYS.TRANSACTIONS);
      else localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, previousTransactionsRaw);
      if (previousSettingsRaw === null) localStorage.removeItem(STORAGE_KEYS.SETTINGS);
      else localStorage.setItem(STORAGE_KEYS.SETTINGS, previousSettingsRaw);
      throw error;
    }

    await dataService.logAudit(
      'إضافة مادة جديدة',
      `تمت إضافة المادة: ${preparedMaterial.name} (${preparedMaterial.code}) مع رصيد افتتاحي ذري بقيمة ${quantity} ${preparedMaterial.unit}`,
      'مادة',
    );
    dataService.recordLocalWrite();
    dataService.notify();
  },

  saveMaterial: async (material: Material): Promise<void> => {
    const previousRaw = localStorage.getItem(STORAGE_KEYS.MATERIALS);
    const materials = dataService.getMaterials();
    const index = materials.findIndex((m) => m.id === material.id);
    const isNew = index === -1;
    const previousMaterial = isNew ? undefined : { ...materials[index] };
    const warehouseWriteSettings = dataService.getSettings();
    const resolvedScope = resolveWarehouseScope(warehouseWriteSettings, getPersistedWarehouseScopeReference());
    const requestedWarehouse = getStorehouseByReference(warehouseWriteSettings, material.primaryStorehouseId || material.storageLocation, false);
    const scopedWarehouse = resolvedScope.scope === 'warehouse'
      ? getStorehouseByReference(warehouseWriteSettings, resolvedScope.selectedStorehouseId, false)
      : undefined;
    const targetWarehouse = isNew && scopedWarehouse ? scopedWarehouse : requestedWarehouse;
    if (!targetWarehouse) throw new Error('يجب تحديد مستودع فعال وصالح للصنف.');
    material = {
      ...material,
      primaryStorehouseId: targetWarehouse.id,
      storageLocation: targetWarehouse.name,
    };

    if (isNew) {
      if (materials.some(m => m.code.toLowerCase() === material.code.toLowerCase())) {
        throw new Error('UNIQUE_CODE_COLLISION');
      }
      materials.push(material);
    } else {
      materials[index] = material;
    }

    localStorage.setItem(STORAGE_KEYS.MATERIALS, JSON.stringify(materials));

    try {
      await ensureCloudSettingsSeeded(warehouseWriteSettings, { includeRoot: true });
      await queueCloudMutation([
        createSyncSetOperation('materials', material.id, material as unknown as Record<string, unknown>, previousMaterial),
      ], isNew ? 'create-material' : 'update-material');
    } catch (error) {
      if (!shouldRestoreLocalProjection(error)) throw error;
      if (previousRaw === null) localStorage.removeItem(STORAGE_KEYS.MATERIALS);
      else localStorage.setItem(STORAGE_KEYS.MATERIALS, previousRaw);
      throw error;
    }
    await dataService.logAudit(
      isNew ? 'إضافة مادة جديدة' : 'تعديل مادة',
      isNew ? `تمت إضافة المادة: ${material.name} (${material.code})` : `تم تعديل بيانات المادة: ${material.name} (${material.code})`,
      'مادة',
    );
    dataService.recordLocalWrite();
  },

  deleteMaterial: async (id: string, force: boolean = false): Promise<{ success: boolean; message: string }> => {
    const transactions = dataService.getTransactions();
    const hasTransactions = transactions.some((t) => t.itemId === id);
    if (hasTransactions && !force) {
      return {
        success: false,
        message: 'لا يمكن حذف المادة بسبب وجود حركات مخزنية مسجلة عليها. يرجى حذف الحركات أولاً لضمان سلامة الدفاتر المحاسبية.',
      };
    }

    const materials = dataService.getMaterials();
    const material = materials.find((m) => m.id === id);
    if (!material) return { success: false, message: 'المادة غير موجودة' };
    const toDelete = hasTransactions && force ? transactions.filter((t) => t.itemId === id) : [];
    const deleteWriteLimit = validateAtomicWriteCount(toDelete.length + 1, MAX_ATOMIC_FIRESTORE_WRITES);
    if (!deleteWriteLimit.valid) return { success: false, message: deleteWriteLimit.errors[0].message };
    const previousMaterialsRaw = localStorage.getItem(STORAGE_KEYS.MATERIALS);
    const previousTransactionsRaw = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);

    // If forcing and has transactions, delete them
    if (hasTransactions && force) {
      const remainingTransactions = transactions.filter((t) => t.itemId !== id);
      localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(remainingTransactions));
      
    }

    const filtered = materials.filter((m) => m.id !== id);
    localStorage.setItem(STORAGE_KEYS.MATERIALS, JSON.stringify(filtered));

    try {
      await queueCloudMutation([
        ...toDelete.map((transaction) => createSyncDeleteOperation('transactions', transaction.id, transaction)),
        createSyncDeleteOperation('materials', id, material),
      ], 'delete-material-with-ledger');
    } catch (error) {
      if (!shouldRestoreLocalProjection(error)) throw error;
      if (previousMaterialsRaw === null) localStorage.removeItem(STORAGE_KEYS.MATERIALS);
      else localStorage.setItem(STORAGE_KEYS.MATERIALS, previousMaterialsRaw);
      if (previousTransactionsRaw === null) localStorage.removeItem(STORAGE_KEYS.TRANSACTIONS);
      else localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, previousTransactionsRaw);
      return { success: false, message: safeResultMessage(error, 'generic') };
    }
    await dataService.logAudit('حذف مادة', `تم حذف المادة: ${material.name} (${material.code})`, 'مادة');
    dataService.recordLocalWrite();

    return { success: true, message: 'تم حذف المادة بنجاح' };
  },

  generateMaterialCode: (): string => {
    const settings = dataService.getSettings();
    const firstCat = settings.categories[0]?.name || 'معقمات ومطهرات';
    return dataService.generateItemCode(firstCat);
  },

  generateItemCode: (categoryName: string): string => {
    const settings = dataService.getSettings();
    const catConfig = settings.categories.find(c => c.name === categoryName);
    
    const prefix = catConfig?.prefix || 'GEN';
    const startRange = catConfig ? Number(catConfig.startRange) : 1000;
    const endRange = catConfig ? Number(catConfig.endRange) : 9999;

    const items = dataService.getMaterials();
    const codes = items
      .map((item) => {
        const regex = new RegExp(`^${prefix}-?(\\d+)$`, 'i');
        const match = item.code.match(regex);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => n >= startRange && n <= endRange);

    const max = codes.length > 0 ? Math.max(...codes) : (startRange - 1);
    const nextVal = max + 1;
    return `${prefix}-${nextVal}`;
  },

  // TRANSACTIONS
  getTransactions: (): InventoryTransaction[] => {
    let data = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
    if (!data) {
      localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(INITIAL_TRANSACTIONS));
      data = JSON.stringify(INITIAL_TRANSACTIONS);
    }
    // A fresh installation may seed legacy transactions before settings exist in localStorage.
    // Materialize settings first so the one-way warehouse migration can resolve those records
    // through their material warehouse instead of weakening the fail-closed read boundary.
    dataService.getSettings();
    ensureWarehouseLocalMigration();
    data = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS) || data;
    let parsed: InventoryTransaction[] = JSON.parse(data);
    let needsSave = false;
    
    // Migration for transaction numbers and suffixes
    parsed = parsed.map(tx => {
      let modified = false;
      if (tx.transactionNumber && tx.transactionNumber.includes('-صادر')) {
        tx.transactionNumber = tx.transactionNumber.replace('-صادر', '-OUT');
        modified = true;
      }
      if (tx.transactionNumber && tx.transactionNumber.includes('-وارد')) {
        tx.transactionNumber = tx.transactionNumber.replace('-وارد', '-IN');
        modified = true;
      }
      if (!tx.transactionNumber) {
        // Generate a pseudo-number if totally missing based on its ID so it has something
        let prefix = 'GEN';
        if (tx.transactionType === 'وارد') prefix = 'W';
        else if (tx.transactionType === 'صادر') prefix = 'O';
        else if (tx.transactionType === 'مستهلك') prefix = 'C';
        else if (tx.transactionType === 'تحويل') prefix = 'T';
        else if (tx.transactionType === 'تسوية') prefix = 'A';
        else if (tx.transactionType === 'افتتاحي') prefix = 'OP';
        
        tx.transactionNumber = `${prefix}-${tx.id.replace(/[^0-9]/g, '') || Math.floor(Math.random() * 1000).toString().padStart(4, '0')}`;
        if (tx.transactionType === 'تحويل') {
           if (tx.transferType === 'in') tx.transactionNumber += '-IN';
           else tx.transactionNumber += '-OUT';
        }
        modified = true;
      }
      if (modified) needsSave = true;
      return tx;
    });

    const warehouseEntities = getStorehouseEntities(dataService.getSettings());
    const warehouseById = new Map(warehouseEntities.map((item) => [item.id, item] as const));
    parsed = parsed.map((tx) => {
      const entity = tx.storehouseId ? warehouseById.get(tx.storehouseId) : getStorehouseByReference(dataService.getSettings(), tx.storehouse, true);
      if (!entity) throw new Error(`WAREHOUSE_REFERENCE_UNRESOLVED:${tx.id}:${tx.storehouse || ''}`);
      if (tx.storehouseId !== entity.id || tx.storehouse !== entity.name) {
        needsSave = true;
        return { ...tx, storehouseId: entity.id, storehouse: entity.name };
      }
      return tx;
    });

    if (needsSave) {
      localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(parsed));
    }

    return parsed.sort((a, b) => new Date(b.createdAt || b.date).getTime() - new Date(a.createdAt || a.date).getTime());
  },
  saveTransactionBatch: async (inputTransactions: InventoryTransaction[]): Promise<{ success: boolean; message: string; transactionIds?: string[] }> => {
    // Client fail-closed mirror of Rules transactions_create (create+update). Not a substitute for Rules (G-C2/POL-2).
    if (!dataService.hasPermission('transactions_create')) {
      return { success: false, message: 'PERMISSION_DENIED: transactions_create' };
    }
    if (!Array.isArray(inputTransactions) || inputTransactions.length === 0) {
      return { success: false, message: 'لا توجد حركات مخزنية للحفظ.' };
    }

    const existing = dataService.getTransactions() as IntegrityTransaction[];
    const settings = dataService.getSettings();
    const previousSettings = JSON.parse(JSON.stringify(settings)) as AppSettings;
    const warehouseEntities = getStorehouseEntities(settings);
    const materials = dataService.getMaterials();
    const materialMap = new Map(materials.map((material) => [material.id, material] as const));
    const existingById = new Map(existing.map((tx) => [tx.id, tx] as const));
    const requestedIds = new Set<string>();
    for (const raw of inputTransactions) {
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (!id) return { success: false, message: 'معرف الحركة مطلوب.' };
      if (requestedIds.has(id)) return { success: false, message: `معرف الحركة مكرر داخل الدفعة: ${id}` };
      requestedIds.add(id);
    }
    const untouchedExisting = existing.filter((tx) => !requestedIds.has(tx.id));
    const replacedExisting = existing.filter((tx) => requestedIds.has(tx.id));
    const existingNumbers = new Set(untouchedExisting.map((tx) => tx.transactionNumber?.trim()).filter((value): value is string => !!value));
    const batchNumbers = new Set<string>();
    const counters = {
      inbound: settings.transactionCounters?.inbound || 0,
      outbound: settings.transactionCounters?.outbound || 0,
      consumed: settings.transactionCounters?.consumed || 0,
      transfer: settings.transactionCounters?.transfer || 0,
      adjustment: settings.transactionCounters?.adjustment || 0,
      opening: settings.transactionCounters?.opening || 0,
    };

    const allocateNumber = (transactionType: InventoryTransaction['transactionType']): string => {
      const config = transactionType === 'وارد' ? ['inbound', 'W'] as const
        : transactionType === 'صادر' ? ['outbound', 'O'] as const
        : transactionType === 'مستهلك' ? ['consumed', 'C'] as const
        : transactionType === 'تسوية' ? ['adjustment', 'A'] as const
        : transactionType === 'افتتاحي' ? ['opening', 'OP'] as const
        : null;
      if (!config) throw new Error('حركات التحويل يجب إنشاؤها من مسار التحويل الذري المخصص.');
      const [key, prefix] = config;
      let candidate = '';
      do {
        counters[key] += 1;
        candidate = `${prefix}-${String(counters[key]).padStart(4, '0')}`;
      } while (existingNumbers.has(candidate) || batchNumbers.has(candidate));
      return candidate;
    };

    const replacedStockEffect = new Map<string, number>();
    for (const tx of replacedExisting) {
      const direction = getInventoryTransactionDirection(tx);
      const quantity = Number(tx.quantity);
      if (!direction || !Number.isFinite(quantity)) continue;
      const key = `${tx.itemId}\u0000${tx.storehouseId || ''}`;
      const effect = direction === 'in' ? quantity : -quantity;
      replacedStockEffect.set(key, (replacedStockEffect.get(key) || 0) + effect);
    }

    const projected = new Map<string, number>();
    const currentStockFor = (itemId: string, storehouseId: string): number => {
      const key = `${itemId}\u0000${storehouseId}`;
      if (!projected.has(key)) {
        const current = dataService.getItemStockByStorehouse(itemId, storehouseId);
        projected.set(key, current - (replacedStockEffect.get(key) || 0));
      }
      return projected.get(key) || 0;
    };

    const prepared: IntegrityTransaction[] = [];
    try {
      for (const raw of inputTransactions) {
        const id = typeof raw.id === 'string' ? raw.id.trim() : '';
        const existingTransaction = existingById.get(id);
        const transaction: IntegrityTransaction = { ...raw, id };

        if (transaction.transactionType === 'تحويل' && !existingTransaction) {
          return { success: false, message: 'حركات التحويل يجب إنشاؤها من مسار التحويل الذري المخصص.' };
        }

        const quantity = Number(transaction.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) return { success: false, message: 'يجب أن تكون الكمية أكبر من صفر.' };

        const material = materialMap.get(transaction.itemId);
        if (!material) return { success: false, message: `الصنف المرتبط بالحركة غير موجود: ${transaction.itemId}` };

        const resolvedWarehouse = getStorehouseByReference(
          settings,
          transaction.storehouseId || transaction.storehouse,
          !!existingTransaction,
        );
        if (!resolvedWarehouse) return { success: false, message: 'يجب تحديد مستودع فعال وصالح لإتمام الحركة.' };
        transaction.storehouseId = resolvedWarehouse.id;
        transaction.storehouse = resolvedWarehouse.name;

        if (existingTransaction) {
          const requestedNumber = transaction.transactionNumber?.trim() || existingTransaction.transactionNumber?.trim() || '';
          const changesLedgerIdentity =
            transaction.itemId !== existingTransaction.itemId
            || transaction.transactionType !== existingTransaction.transactionType
            || transaction.transferType !== existingTransaction.transferType
            || Number(transaction.quantity) !== Number(existingTransaction.quantity)
            || transaction.date !== existingTransaction.date
            || resolvedWarehouse.id !== existingTransaction.storehouseId
            || requestedNumber !== (existingTransaction.transactionNumber?.trim() || '')
            || (transaction.operationId || '') !== (existingTransaction.operationId || '')
            || (transaction.pairedTransactionId || '') !== (existingTransaction.pairedTransactionId || '');
          if (changesLedgerIdentity) {
            return {
              success: false,
              message: 'لا يمكن تعديل الحقول المؤثرة على رصيد حركة مسجلة. استخدم حركة تسوية أو احذف العملية المترابطة ثم أعد تسجيلها.',
            };
          }
        }

        let transactionNumber = transaction.transactionNumber?.trim() || existingTransaction?.transactionNumber?.trim() || '';
        if (!transactionNumber) transactionNumber = allocateNumber(transaction.transactionType);
        if (existingNumbers.has(transactionNumber) || batchNumbers.has(transactionNumber)) {
          return { success: false, message: `رقم السند مستخدم مسبقاً: ${transactionNumber}` };
        }
        batchNumbers.add(transactionNumber);

        const direction = getInventoryTransactionDirection(transaction);
        if (!direction) return { success: false, message: 'اتجاه الحركة غير صالح أو غير محدد.' };

        const projectedBefore = currentStockFor(material.id, resolvedWarehouse.id);
        const projectedAfter = projectedBefore + (direction === 'in' ? quantity : -quantity);
        projected.set(`${material.id}\u0000${resolvedWarehouse.id}`, projectedAfter);
        const before = existingTransaction && Number.isFinite(Number(existingTransaction.stockBefore))
          ? Number(existingTransaction.stockBefore)
          : projectedBefore;
        const after = existingTransaction && Number.isFinite(Number(existingTransaction.stockAfter))
          ? Number(existingTransaction.stockAfter)
          : projectedAfter;

        prepared.push({
          ...transaction,
          id,
          transactionNumber,
          itemId: material.id,
          itemCode: material.code,
          itemName: material.name,
          itemCategory: material.category,
          unit: material.unit,
          quantity,
          storehouseId: resolvedWarehouse.id,
          storehouse: resolvedWarehouse.name,
          stockBefore: before,
          stockAfter: after,
          createdAt: existingTransaction?.createdAt || transaction.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      return { success: false, message: safeResultMessage(error, 'generic', { fallback: 'تعذر تجهيز الحركات للحفظ.' }) };
    }

    const writeLimit = validateAtomicWriteCount(prepared.length + 1, MAX_ATOMIC_FIRESTORE_WRITES);
    if (!writeLimit.valid) return { success: false, message: writeLimit.errors[0].message };

    const next = [...prepared, ...untouchedExisting];
    const integrity = validateInventoryDataset(next, { materials, storehouses: warehouseEntities });
    const legacyTransferIds = new Set(next.filter((tx) => tx.transactionType === 'تحويل' && !tx.operationId && !tx.pairedTransactionId).map((tx) => tx.id));
    const blockingErrors = integrity.errors.filter((error) =>
      !(error.code === 'TRANSFER_OPERATION_REQUIRED' && !!error.transactionId && legacyTransferIds.has(error.transactionId))
    );
    if (blockingErrors.length > 0) return { success: false, message: blockingErrors[0].message };

    const previousTransactionsRaw = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
    const previousSettingsRaw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    settings.transactionCounters = counters;
    try {
      localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(next));
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    } catch (_) {
      if (previousTransactionsRaw === null) localStorage.removeItem(STORAGE_KEYS.TRANSACTIONS);
      else localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, previousTransactionsRaw);
      if (previousSettingsRaw === null) localStorage.removeItem(STORAGE_KEYS.SETTINGS);
      else localStorage.setItem(STORAGE_KEYS.SETTINGS, previousSettingsRaw);
      return { success: false, message: 'تعذر حفظ الحركة محلياً؛ لم يتم تنفيذ أي كتابة سحابية.' };
    }

    try {
      await ensureCloudSettingsSeeded(previousSettings, { includeRoot: false });
      await queueCloudMutation([
        settingsRootSyncOp(settings, previousSettings),
        ...prepared.map((tx) => createSyncSetOperation(
          'transactions',
          tx.id,
          tx as unknown as Record<string, unknown>,
          existingById.get(tx.id),
        )),
      ], 'save-transaction-batch');
    } catch (error) {
      if (!shouldRestoreLocalProjection(error)) throw error;
      if (previousTransactionsRaw === null) localStorage.removeItem(STORAGE_KEYS.TRANSACTIONS);
      else localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, previousTransactionsRaw);
      if (previousSettingsRaw === null) localStorage.removeItem(STORAGE_KEYS.SETTINGS);
      else localStorage.setItem(STORAGE_KEYS.SETTINGS, previousSettingsRaw);
      return { success: false, message: safeResultMessage(error, 'generic') };
    }

    if (prepared.length === 1) {
      const tx = prepared[0];
      const isUpdate = existingById.has(tx.id);
      await dataService.logAudit(
        isUpdate ? 'تعديل حركة مخزنية' : 'إضافة حركة مخزنية',
        isUpdate
          ? `تم تعديل الحركة (${tx.transactionType}) رقم ${tx.transactionNumber} على صنف: ${tx.itemName}. الكمية الحالية: ${tx.quantity} ${tx.unit || ''}`
          : `تم تسجيل حركة (${tx.transactionType}) رقم ${tx.transactionNumber} على صنف: ${tx.itemName} بقيمة: ${tx.quantity} ${tx.unit || ''}`,
        'حركة',
        tx.attachment,
      );
    } else {
      await dataService.logAudit('إضافة حركات مخزنية', `تم تسجيل ${prepared.length} حركة مخزنية كعملية ذرية واحدة بعد التحقق المسبق من سلامة الرصيد.`, 'حركة');
    }
    dataService.recordLocalWrite();
    dataService.notify();
    const singleWasUpdate = prepared.length === 1 && existingById.has(prepared[0].id);
    return {
      success: true,
      message: prepared.length === 1
        ? (singleWasUpdate ? 'تم تعديل الحركة المخزنية بنجاح' : 'تم إنشاء الحركة المخزنية بنجاح')
        : `تم حفظ ${prepared.length} حركة مخزنية بنجاح`,
      transactionIds: prepared.map((tx) => tx.id),
    };
  },

  saveTransaction: async (transaction: InventoryTransaction): Promise<{ success: boolean; message: string }> => {
    const result = await dataService.saveTransactionBatch([transaction]);
    return { success: result.success, message: result.message };
  },

  replaceTransactionsForAttachmentMigration: async (transactions: InventoryTransaction[]): Promise<void> => {
    const previous = dataService.getTransactions();
    const previousRaw = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
    const previousById = new Map(previous.map(transaction => [transaction.id, transaction]));
    const changed = transactions.filter(transaction => JSON.stringify(previousById.get(transaction.id)) !== JSON.stringify(transaction));
    localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(transactions));
    try {
      await queueCloudMutation(changed.map(transaction => createSyncSetOperation(
        'transactions', transaction.id, transaction as unknown as Record<string, unknown>, previousById.get(transaction.id),
      )), 'migrate-opening-attachments');
    } catch (error) {
      if (!shouldRestoreLocalProjection(error)) throw error;
      if (previousRaw === null) localStorage.removeItem(STORAGE_KEYS.TRANSACTIONS);
      else localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, previousRaw);
      throw error;
    }
  },

  // Compatibility hook retained for callers that still invoke it. Balances are now derived from the ledger
  // at read/report time; rewriting historical transaction documents is intentionally avoided.
  recalculateTransactionBalances: (_itemId: string, _storehouse: string) => {
    dataService.notify();
  },

  deleteTransactions: async (requestedIds: string[]): Promise<{ success: boolean; message: string; deletedIds?: string[] }> => {
    if (!Array.isArray(requestedIds) || requestedIds.length === 0) return { success: false, message: 'لم يتم تحديد حركات للحذف.' };
    const transactions = dataService.getTransactions() as IntegrityTransaction[];
    const byId = new Map(transactions.map((tx) => [tx.id, tx] as const));
    const deleteIds = new Set<string>();

    for (const requestedId of requestedIds) {
      const tx = byId.get(requestedId);
      if (!tx) return { success: false, message: `الحركة المخزنية غير موجودة: ${requestedId}` };
      deleteIds.add(tx.id);
      if (tx.transactionType === 'تحويل') {
        const companion = getTransferCompanion(tx, transactions);
        if (!companion) {
          return { success: false, message: `تعذر تحديد الساق المقابلة للتحويل ${tx.transactionNumber || tx.id}، وتم إيقاف الحذف حفاظاً على سلامة الدفاتر.` };
        }
        deleteIds.add(companion.id);
      }
    }

    const rawMaterialsValue = localStorage.getItem(STORAGE_KEYS.MATERIALS);
    const rawMaterials: Material[] = rawMaterialsValue ? JSON.parse(rawMaterialsValue) : [];
    const originalMaterialById = new Map(rawMaterials.map((material) => [material.id, { ...material }] as const));
    const nextTransactions = transactions.filter((tx) => !deleteIds.has(tx.id));
    const deletedTransactions = transactions.filter((tx) => deleteIds.has(tx.id));
    const openingAffectedItemIds = new Set(deletedTransactions.filter((tx) => tx.transactionType === 'افتتاحي' || tx.id.startsWith('tr-init')).map((tx) => tx.itemId));
    const materialUpdates = new Map<string, Material>();

    for (const itemId of openingAffectedItemIds) {
      const stillHasOpening = nextTransactions.some((tx) => tx.itemId === itemId && (tx.transactionType === 'افتتاحي' || tx.id.startsWith('tr-init')));
      if (!stillHasOpening) {
        const index = rawMaterials.findIndex((material) => material.id === itemId);
        if (index >= 0 && Number(rawMaterials[index].initialStock || 0) !== 0) {
          rawMaterials[index] = { ...rawMaterials[index], initialStock: 0, updatedAt: new Date().toISOString() };
          materialUpdates.set(itemId, rawMaterials[index]);
        }
      }
    }

    const warehouseEntities = getStorehouseEntities(dataService.getSettings());
    const integrity = validateInventoryDataset(nextTransactions, { materials: rawMaterials, storehouses: warehouseEntities });
    const legacyTransferIds = new Set(nextTransactions.filter((tx) => tx.transactionType === 'تحويل' && !tx.operationId && !tx.pairedTransactionId).map((tx) => tx.id));
    const blockingErrors = integrity.errors.filter((error) =>
      !(error.code === 'TRANSFER_OPERATION_REQUIRED' && !!error.transactionId && legacyTransferIds.has(error.transactionId))
    );
    if (blockingErrors.length > 0) return { success: false, message: blockingErrors[0].message };

    const writeCount = deleteIds.size + materialUpdates.size;
    const writeLimit = validateAtomicWriteCount(writeCount, MAX_ATOMIC_FIRESTORE_WRITES);
    if (!writeLimit.valid) return { success: false, message: writeLimit.errors[0].message };

    const previousTransactions = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
    const previousMaterials = localStorage.getItem(STORAGE_KEYS.MATERIALS);
    try {
      localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(nextTransactions));
      if (materialUpdates.size > 0) localStorage.setItem(STORAGE_KEYS.MATERIALS, JSON.stringify(rawMaterials));
    } catch (_) {
      if (previousTransactions === null) localStorage.removeItem(STORAGE_KEYS.TRANSACTIONS); else localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, previousTransactions);
      if (previousMaterials === null) localStorage.removeItem(STORAGE_KEYS.MATERIALS); else localStorage.setItem(STORAGE_KEYS.MATERIALS, previousMaterials);
      return { success: false, message: 'تعذر تطبيق الحذف محلياً وتمت استعادة الحالة السابقة.' };
    }

    try {
      await queueCloudMutation([
        ...deletedTransactions.map((transaction) => createSyncDeleteOperation('transactions', transaction.id, transaction)),
        ...Array.from(materialUpdates.values()).map((material) => createSyncSetOperation(
          'materials',
          material.id,
          material as unknown as Record<string, unknown>,
          originalMaterialById.get(material.id),
        )),
      ], 'delete-transaction-batch');
    } catch (error) {
      if (!shouldRestoreLocalProjection(error)) throw error;
      if (previousTransactions === null) localStorage.removeItem(STORAGE_KEYS.TRANSACTIONS); else localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, previousTransactions);
      if (previousMaterials === null) localStorage.removeItem(STORAGE_KEYS.MATERIALS); else localStorage.setItem(STORAGE_KEYS.MATERIALS, previousMaterials);
      return { success: false, message: safeResultMessage(error, 'generic') };
    }

    await dataService.logAudit('حذف حركات مخزنية', `تم حذف ${deleteIds.size} سجل حركة كعملية ذرية واحدة بعد التحقق من سلامة الرصيد.`, 'حركة');
    dataService.recordLocalWrite();
    dataService.notify();
    return { success: true, message: deleteIds.size === 1 ? 'تم حذف الحركة بنجاح' : `تم حذف ${deleteIds.size} حركة مترابطة بنجاح`, deletedIds: Array.from(deleteIds) };
  },

  deleteTransaction: async (id: string): Promise<{ success: boolean; message: string }> => {
    const result = await dataService.deleteTransactions([id]);
    return { success: result.success, message: result.message };
  },
  getStorehouseInitialStock: (itemId: string, storehouse: string | undefined): number => {
    const materials = dataService.getMaterials();
    const item = materials.find((m) => m.id === itemId);
    if (!item) return 0;
    const stockWarehouseSettings = dataService.getSettings();
    const activeIds = new Set(getStorehouseEntities(stockWarehouseSettings).filter((entry) => entry.active).map((entry) => entry.id));
    const defaultId = item.primaryStorehouseId || getStorehouseByReference(stockWarehouseSettings, item.storageLocation, true)?.id;
    const initTransactions = dataService.getTransactions().filter((t) => t.itemId === itemId && (t.id.startsWith('tr-init') || t.transactionType === 'افتتاحي'));
    const txWarehouseId = (tx: InventoryTransaction) => tx.storehouseId || getStorehouseByReference(stockWarehouseSettings, tx.storehouse, true)?.id;

    if (storehouse && storehouse !== 'all') {
      const target = getStorehouseByReference(stockWarehouseSettings, storehouse, true);
      if (!target) return 0;
      const scopedInit = initTransactions.filter((tx) => txWarehouseId(tx) === target.id);
      if (scopedInit.length > 0) return dataService.calculateStock(scopedInit);
      if (initTransactions.length === 0 && defaultId === target.id && (item.initialStock || 0) > 0) return item.initialStock || 0;
      return 0;
    }

    const activeInit = initTransactions.filter((tx) => {
      const id = txWarehouseId(tx);
      return !!id && activeIds.has(id);
    });
    if (activeInit.length > 0) return dataService.calculateStock(activeInit);
    if (initTransactions.length === 0 && defaultId && activeIds.has(defaultId)) return item.initialStock || 0;
    return 0;
  },

  getStorehouseStockExcludingTransaction: (itemId: string, storehouse: string | undefined, excludeTxId: string): number => {
    const materials = dataService.getMaterials();
    const item = materials.find((m) => m.id === itemId);
    if (!item) return 0;
    const stockWarehouseSettings = dataService.getSettings();
    const activeIds = new Set(getStorehouseEntities(stockWarehouseSettings).filter((entry) => entry.active).map((entry) => entry.id));
    const defaultId = item.primaryStorehouseId || getStorehouseByReference(stockWarehouseSettings, item.storageLocation, true)?.id;
    const allItemTxs = dataService.getTransactions().filter((t) => t.itemId === itemId);
    const excludedTx = allItemTxs.find((t) => t.id === excludeTxId);
    const isExcludedTxInit = !!excludedTx && (excludedTx.id.startsWith('tr-init') || excludedTx.transactionType === 'افتتاحي');
    const itemTxs = allItemTxs.filter((t) => t.id !== excludeTxId);
    const txWarehouseId = (tx: InventoryTransaction) => tx.storehouseId || getStorehouseByReference(stockWarehouseSettings, tx.storehouse, true)?.id;
    const targetId = storehouse && storehouse !== 'all' ? getStorehouseByReference(stockWarehouseSettings, storehouse, true)?.id : undefined;
    if (storehouse && storehouse !== 'all' && !targetId) return 0;
    const eligible = (tx: InventoryTransaction) => {
      const id = txWarehouseId(tx);
      return targetId ? id === targetId : !!id && activeIds.has(id);
    };
    const initTransactions = itemTxs.filter((t) => (t.id.startsWith('tr-init') || t.transactionType === 'افتتاحي') && eligible(t));
    const nonInitTransactions = itemTxs.filter((t) => !t.id.startsWith('tr-init') && t.transactionType !== 'افتتاحي' && eligible(t));
    let initialStock = 0;
    if (initTransactions.length > 0) initialStock = dataService.calculateStock(initTransactions);
    else {
      const defaultEligible = targetId ? defaultId === targetId : !!defaultId && activeIds.has(defaultId);
      const anyInitAnywhere = itemTxs.some((t) => t.id.startsWith('tr-init') || t.transactionType === 'افتتاحي');
      if (!anyInitAnywhere && defaultEligible && item.initialStock !== undefined && !isExcludedTxInit) initialStock = item.initialStock;
    }
    return initialStock + dataService.calculateStock(nonInitTransactions);
  },

  getItemStockExcludingTransaction: (itemId: string, _itemType: string | undefined, excludeTxId: string): number => {
    return dataService.getStorehouseStockExcludingTransaction(itemId, undefined, excludeTxId);
  },

  getItemStock: (itemId: string, _itemType: string | undefined): number => {
    const materials = dataService.getMaterials();
    const found = materials.find((m) => m.id === itemId);
    return found ? found.currentStock : 0;
  },

  getItemStockByStorehouse: (itemId: string, storehouse: string): number => {
    return dataService.getStorehouseStockExcludingTransaction(itemId, storehouse, 'non-existent-id');
  },

  calculateStock: (transactions: InventoryTransaction[]): number => {
    let stock = 0;
    // To calculate correctly, let's process transactions in chronological order if sorted differently
    const sorted = [...transactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    for (const t of sorted) {
      if (
        t.transactionType === 'وارد' ||
        t.transactionType === 'افتتاحي' ||
        (t.transactionType === 'تحويل' && t.transferType === 'in') ||
        (t.transactionType === 'تسوية' && (t.transferType === 'in' || t.quantity >= 0))
      ) {
        stock += t.quantity;
      } else {
        stock -= t.quantity;
      }
    }
    return stock;
  },

  // AUDIT LOGS
  getAuditLogs: (): AuditLog[] => {
    const data = localStorage.getItem(STORAGE_KEYS.AUDIT_LOGS);
    if (!data) {
      localStorage.setItem(STORAGE_KEYS.AUDIT_LOGS, JSON.stringify(INITIAL_AUDIT_LOGS));
      return INITIAL_AUDIT_LOGS;
    }
    try {
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(entry => normalizeAuditLog(entry)).filter((entry): entry is AuditLog => !!entry);
    } catch (_) {
      return [];
    }
  },

  logAudit: async (
    action: string,
    details: string,
    itemType?: 'مادة' | 'مبيد' | 'معاملة' | 'إعدادات' | 'حركة' | 'مولد' | 'عام',
    contextOrLegacyAttachment?: string | AuditEventContext,
  ): Promise<void> => {
    const logs = dataService.getAuditLogs();
    const actor = resolveAuditActor();
    const context = typeof contextOrLegacyAttachment === 'object' && contextOrLegacyAttachment !== null
      ? contextOrLegacyAttachment
      : { operationType: 'system' as const, affectedEntities: ['system/application'] };
    const clientAuditId = typeof (context as AuditEventContext).clientAuditId === 'string'
      ? (context as AuditEventContext).clientAuditId!.trim()
      : '';
    const clientAuditTimestamp = typeof (context as AuditEventContext).clientAuditTimestamp === 'string'
      ? (context as AuditEventContext).clientAuditTimestamp!.trim()
      : '';
    const newLog = buildAuditLog({
      id: clientAuditId || createAuditId(),
      timestamp: clientAuditTimestamp || new Date().toISOString(),
      actorUserId: actor.actorUserId,
      actorDisplayName: actor.actorDisplayName,
      action,
      details,
      itemType,
      context,
    });
    if (clientAuditId) {
      const existingIdx = logs.findIndex(entry => entry?.id === clientAuditId);
      if (existingIdx >= 0) logs[existingIdx] = newLog;
      else logs.unshift(newLog);
    } else {
      logs.unshift(newLog);
    }
    localStorage.setItem(STORAGE_KEYS.AUDIT_LOGS, JSON.stringify(logs));

    if (isSupabaseConfigured() && CLOUD_WRITES_ENABLED && getCurrentAuthUser()) {
      try {
        await supabaseDb.upsertDoc('audit_logs', newLog.id, newLog as unknown as Record<string, unknown>);
      } catch (error) {
        handleCloudWriteError(error, 'persisted');
        if (context.requireCentralAck) throw error;
      }
    }
  },

  // USERS MANAGEMENT
  getUsers: (): SystemUser[] => {
    const data = localStorage.getItem(STORAGE_KEYS.USERS);
    let usersList = INITIAL_USERS;
    if (data) {
      try {
        const parsed = JSON.parse(data) as SystemUser[];
        if (parsed && parsed.length > 0) {
          usersList = parsed;
        }
      } catch (e) {
        // use initial
      }
    }
    
    let needsSave = false;
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    const migrated = usersList.map(user => {
      let modified = false;
      const updatedUser = { ...user };
      if (!emailPattern.test(updatedUser.username)) {
        updatedUser.username = `${updatedUser.username.replace(/\s/g, '').toLowerCase()}@system.com`;
        modified = true;
      }
      if (Object.prototype.hasOwnProperty.call(updatedUser, 'password')) {
        delete (updatedUser as unknown as Record<string, unknown>).password;
        modified = true;
      }
      const isMatrix = updatedUser.username.trim().toLowerCase() === 'matrix@system.com';
      if (isMatrix && updatedUser.active !== false) {
        updatedUser.active = false;
        modified = true;
      } else if (!isMatrix && updatedUser.authUid && updatedUser.active === undefined) {
        updatedUser.active = true;
        modified = true;
      }
      
      if (modified) needsSave = true;
      return updatedUser;
    });

    if (needsSave) {
      localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(migrated));
    }
    return migrated;
  },


  bootstrapCurrentFirebaseUser: async (): Promise<{ success: boolean; user?: SystemUser; message: string }> => {
    const authUser = getCurrentAuthUser();
    if (!authUser || !authUser.uid || !authUser.email) {
      return { success: false, message: 'بيانات المصادقة غير متوفرة.' };
    }

    const uid = authUser.uid;
    const email = authUser.email.trim().toLowerCase();

    try {
      const canonicalGate = await ensureCanonicalCurrentUserProfile(dataService.getUsers());
      if (!canonicalGate.success) {
        if (canonicalGate.reason === 'unavailable') {
          return { success: false, message: `NETWORK_UNAVAILABLE:${canonicalGate.message}` };
        }
        await supabaseAuthSignOut().catch(() => {});
        sessionStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
        localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
        return { success: false, message: canonicalGate.message };
      }

      const remoteUser = await supabaseDb.getDoc<SystemUser>('users', uid);
      if (!remoteUser) {
        await supabaseAuthSignOut().catch(() => {});
        sessionStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
        localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
        return { success: false, message: 'حساب المستخدم غير موجود على الخادم.' };
      }

      const validation = validateCanonicalManagedUser(uid, remoteUser, {
        expectedEmail: email,
        requireActive: true,
      });
      if (!validation.valid) {
        await supabaseAuthSignOut().catch(() => {});
        sessionStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
        localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
        return { success: false, message: 'بيانات المستخدم على الخادم غير صالحة أو معطلة.' };
      }

      const cleanUser = validation.user;
      const localData = localStorage.getItem(STORAGE_KEYS.USERS);
      let usersList: SystemUser[] = [];
      if (localData) {
        try {
          const parsed = JSON.parse(localData);
          if (Array.isArray(parsed)) usersList = parsed;
        } catch {
          usersList = [];
        }
      }

      usersList = usersList.filter(u =>
        u.id !== cleanUser.id &&
        u.authUid !== cleanUser.authUid &&
        u.username.trim().toLowerCase() !== cleanUser.username.trim().toLowerCase()
      );
      usersList.push(cleanUser);
      localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(usersList));

      clearProtectedCloudEnqueueBlock();
      return { success: true, user: cleanUser, message: 'تم استرداد ملف المستخدم بنجاح.' };
    } catch (err: any) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('network') || msg.includes('fetch') || msg.includes('offline')) {
        return { success: false, message: 'NETWORK_UNAVAILABLE:تعذر الوصول إلى الخادم للتحقق من ملف المستخدم.' };
      }
      await supabaseAuthSignOut().catch(() => {});
      sessionStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
      localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
      return { success: false, message: 'تعذر جلب ملف المستخدم من الخادم.' };
    }
  },

  bootstrapFreshDeviceData: async (user: SystemUser): Promise<{ success: boolean; status: string; message?: string }> => {
    const authUser = getCurrentAuthUser();
    if (!isSupabaseConfigured() || !authUser) {
      return { success: false, status: 'no-firebase', message: 'السحابة غير متاحة حالياً.' };
    }

    if (!user || user.active === false || (user.authUid && user.authUid !== authUser.uid) || !Array.isArray(user.permissions)) {
      return { success: false, status: 'invalid-user', message: 'صلاحيات المستخدم غير صالحة للتهيئة.' };
    }

    try {
      let materials: Material[] = [];
      let transactions: InventoryTransaction[] = [];
      let settings: AppSettings | null = null;
      let auditLogs: AuditLog[] = [];
      let generatorLogs: GeneratorLogEntry[] = [];
      let users: SystemUser[] = [];

      if (user.permissions.includes('materials_view')) {
        const rows = await supabaseDb.getCollection<Material>('materials');
        materials = rows.map(r => ({ ...(stripSyncMetadata(r) as unknown as Material), id: r.id }));
      }
      if (user.permissions.includes('transactions_view')) {
        const rows = await supabaseDb.getCollection<InventoryTransaction>('transactions');
        transactions = rows.map(r => ({ ...(stripSyncMetadata(r) as unknown as InventoryTransaction), id: r.id }));
      }
      if (user.permissions.includes('settings_view')) {
        const remoteSettings = await supabaseDb.getDoc<Record<string, unknown>>('settings', 'app_config');
        if (remoteSettings) {
          settings = composeSupabaseAppSettings(remoteSettings, DEFAULT_SETTINGS);
        } else {
          // Brand-new empty Supabase database: initialize default settings and seed to cloud
          settings = withSettingsAttachmentManifest(
            canonicalizeWarehouseSettings({
              ...DEFAULT_SETTINGS,
              cloudSyncEnabled: true,
              firebaseInitialized: true,
            }),
          ) as AppSettings;
          await supabaseDb.upsertDoc('settings', 'app_config', settings as unknown as Record<string, unknown>).catch(() => {});
        }
      }
      if (user.permissions.includes('audit_view')) {
        const rows = await supabaseDb.getCollection<Record<string, unknown>>('audit_logs');
        auditLogs = rows
          .map(d => normalizeAuditLog(stripSyncMetadata(d), String(d.id || '')))
          .filter((entry): entry is AuditLog => !!entry)
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      }
      if (user.permissions.includes('generator_log')) {
        const rows = await supabaseDb.getCollection<GeneratorLogEntry>('generator_logs');
        generatorLogs = rows.map(r => ({ ...(stripSyncMetadata(r) as unknown as GeneratorLogEntry), id: r.id }));
      }
      if (user.permissions.includes('users_manage')) {
        const rows = await supabaseDb.getCollection<SystemUser>('users');
        users = rows.map(u => {
          const copy = { ...(stripSyncMetadata(u) as unknown as SystemUser), id: u.id };
          delete (copy as unknown as Record<string, unknown>).password;
          return copy;
        });
      } else {
        const copy = { ...user };
        delete (copy as unknown as Record<string, unknown>).password;
        users = [copy];
      }

      if (settings && (materials.length > 0 || transactions.length > 0)) {
        const normalized = migrateWarehouseModel({ settings, materials, transactions });
        if (normalized.errors.length === 0) {
          settings = normalized.settings;
          materials = normalized.materials;
          transactions = normalized.transactions;
          const integrity = validateInventoryDataset(transactions as IntegrityTransaction[], {
            materials,
            storehouses: getStorehouseEntities(settings),
          });
          if (!integrity.valid) {
            return {
              success: false,
              status: "validation-failed",
              message: integrity.errors.map(e => e.message).join(" | "),
            };
          }
        } else {
          return {
            success: false,
            status: 'validation-failed',
            message: `تعذرت مواءمة مراجع المستودعات: ${normalized.errors.join(' | ')}`,
          };
        }
      }

      if (user.permissions.includes('materials_view')) {
        localStorage.setItem(STORAGE_KEYS.MATERIALS, JSON.stringify(materials));
      }
      if (user.permissions.includes('transactions_view')) {
        localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(transactions));
      }
      if (user.permissions.includes('settings_view') && settings) {
        localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
      }
      if (user.permissions.includes('audit_view')) {
        localStorage.setItem(STORAGE_KEYS.AUDIT_LOGS, JSON.stringify(auditLogs));
      }
      if (user.permissions.includes('generator_log')) {
        localStorage.setItem(STORAGE_KEYS.GENERATOR_LOGS, JSON.stringify(generatorLogs));
      }
      localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));

      return { success: true, status: 'bootstrapped' };
    } catch (err: any) {
      return { success: false, status: 'error', message: safeResultMessage(err, 'sync') };
    }
  },

  login: async (username: string, password: string, _rememberMe: boolean = false): Promise<{ success: boolean; message: string; requirePasswordChange?: boolean; tempUser?: any }> => {
    let cleanInput = username.trim().toLowerCase();
    if (!cleanInput.includes('@')) {
      cleanInput = `${cleanInput}@system.com`;
    }

    if (!isSupabaseConfigured()) {
      return { success: false, message: 'خدمة Supabase غير مهيأة. يرجى التحقق من إعدادات الاتصال.' };
    }

    try {
      await supabaseAuthSignIn(cleanInput, password);
      return { success: true, message: 'تم التحقق من بيانات الدخول، جاري تهيئة الحساب...' };
    } catch {
      return { success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة!' };
    }
  },

  completeLogin: (user: SystemUser) => {
    firebaseAuthSessionGeneration += 1;
    logoutSingleFlight.reset();
    localStorage.setItem(STORAGE_KEYS.CURRENT_USER, user.id);
    sessionStorage.setItem(STORAGE_KEYS.CURRENT_USER, user.id);
    dataService.notify();
  },

  isLoggedIn: (): boolean => {
    return isSupabaseConfigured() && getCurrentAuthUser() !== null;
  },

  logout: (): Promise<LogoutResult> => {
    bindDiagnosticsSession(null);
    clearUnattributedRuntimeAlert();
    return logoutSingleFlight.run(async () => {
      const failures: LogoutResult['failures'] = [];
      let audit: LogoutResult['audit'] = 'recorded-or-enqueued';
      let signOutSucceeded = true;
      const currentUser = getCurrentAuthUser();
      if (currentUser?.uid) {
        await dataService.logAudit(
          'تسجيل الخروج',
          'تم تسجيل الخروج من الجلسة',
          'إعدادات',
          {
            operationType: 'logout',
            affectedEntities: [`users/${currentUser.uid}`],
          },
        ).catch(() => {
          audit = 'failed';
          failures.push({ phase: 'audit', message: 'LOGOUT_AUDIT_FAILED' });
        });
      }
      stopCloudSync();
      try {
        sessionStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
        localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
      } catch {
        // Ignore storage errors
      }
      sessionTerminationVersion += 1;
      await supabaseAuthSignOut().catch(() => {
        signOutSucceeded = false;
        failures.push({ phase: 'firebase-sign-out', message: 'SUPABASE_SIGN_OUT_FAILED' });
      });
      dataService.notify();
      return { audit, signOutSucceeded, failures };
    });
  },

  getSessionTerminationVersion: (): number => sessionTerminationVersion,

  getPendingLogoutGeneration: (): number | null => pendingLogoutGeneration,

  getSessionTerminationDurability: (generation: number): boolean | undefined =>
    terminationAttemptStateByGeneration.get(generation)?.durable,

  getSessionTerminationMarker: (generation: number): AuthTerminationRecord | undefined => {
    const marker = terminationAttemptStateByGeneration.get(generation)?.marker;
    return marker ? { ...marker } : undefined;
  },

  getTerminationAttemptStateCountForTests: (): number => terminationAttemptStateByGeneration.size,

  beginFirebaseAuthSession: (_uid: string): number => {
    firebaseAuthSessionGeneration += 1;
    logoutSingleFlight.reset();
    // P12: diagnostics are owned by exactly this auth session (uid + generation).
    bindDiagnosticsSession(`${_uid}#${firebaseAuthSessionGeneration}`);
    clearUnattributedRuntimeAlert();
    return firebaseAuthSessionGeneration;
  },

  getFirebaseAuthSessionGeneration: (): number => firebaseAuthSessionGeneration,

  captureSessionContinuationAssertion: (): (() => void) => {
    const captured = captureSessionContinuation();
    return () => assertSessionContinuationCurrent(captured);
  },

  getCurrentFirebaseAuthSessionIdentity: (): string | null =>
    auth?.currentUser ? firebaseUserSessionIdentity(auth.currentUser) : null,

  getFirebaseAuthUserIdentity: (user: FirebaseAuthUserLike): string =>
    firebaseUserSessionIdentity(user),

  isFirebaseSessionTerminationRemembered: (uid: string, identity: string): boolean =>
    isAuthTerminationRemembered(uid, identity),

  readDurableFirebaseSessionTermination: (uid: string, identity: string): Promise<boolean> =>
    readAuthTermination(uid, identity),

  rememberFirebaseSessionTermination: (
    expectedUser: FirebaseAuthUserLike,
    expectedGeneration: number,
    expectedIdentity: string,
  ): AuthTerminationRecord | null => {
    const currentUser = auth?.currentUser;
    if (!currentUser || currentUser !== expectedUser
      || firebaseAuthSessionGeneration !== expectedGeneration
      || firebaseUserSessionIdentity(currentUser) !== expectedIdentity) return null;
    const marker = createAuthTerminationRecord(
      expectedUser.uid,
      expectedIdentity,
      expectedGeneration,
    );
    rememberAuthTerminationInMemory(marker);
    setTerminationAttemptState(expectedGeneration, { durable: false, marker });
    return marker;
  },

  persistDurableFirebaseSessionTermination: async (
    expectedUser: FirebaseAuthUserLike,
    expectedGeneration: number,
    expectedIdentity: string,
    expectedMarker: AuthTerminationRecord,
  ): Promise<boolean> => {
    const currentUser = auth?.currentUser;
    if (!currentUser || currentUser !== expectedUser
      || firebaseAuthSessionGeneration !== expectedGeneration
      || firebaseUserSessionIdentity(currentUser) !== expectedIdentity
      || expectedMarker.userId !== expectedUser.uid
      || expectedMarker.sessionFingerprint !== expectedIdentity
      || expectedMarker.attemptGeneration !== expectedGeneration) return false;
    await persistAuthTermination(expectedMarker);
    setTerminationAttemptState(expectedGeneration, { durable: true, marker: expectedMarker });
    return true;
  },

  clearDurableFirebaseSessionTermination: (
    expectedMarker: AuthTerminationRecord,
  ): Promise<boolean> => clearAuthTermination(expectedMarker),

  markFirebaseSessionLocallyTerminated: (
    expectedUser: FirebaseAuthUserLike,
    expectedGeneration: number,
    expectedIdentity: string,
  ): boolean => {
    const currentUser = auth?.currentUser;
    if (!currentUser
      || currentUser !== expectedUser
      || firebaseAuthSessionGeneration !== expectedGeneration
      || firebaseUserSessionIdentity(currentUser) !== expectedIdentity) return false;
    globalThis.localStorage?.setItem(
      locallyTerminatedFirebaseUidKey(expectedUser.uid),
      expectedIdentity,
    );
    return true;
  },

  isFirebaseSessionLocallyTerminated: (uid: string): boolean => {
    const currentUser = auth?.currentUser;
    const currentIdentity = currentUser?.uid === uid ? firebaseUserSessionIdentity(currentUser) : null;
    return (!!currentIdentity
        && globalThis.localStorage?.getItem(locallyTerminatedFirebaseUidKey(uid)) === currentIdentity)
      || globalThis.localStorage?.getItem(LEGACY_LOCALLY_TERMINATED_FIREBASE_UID_KEY) === uid;
  },

  clearFirebaseSessionLocalTermination: (
    uid: string,
    expectedGeneration?: number,
    expectedIdentity?: string,
  ): void => {
    if (expectedGeneration !== undefined
      && (firebaseAuthSessionGeneration !== expectedGeneration || auth?.currentUser !== null)) return;
    const scopedKey = locallyTerminatedFirebaseUidKey(uid);
    if (expectedIdentity !== undefined
      && globalThis.localStorage?.getItem(scopedKey) === expectedIdentity) {
      globalThis.localStorage.removeItem(scopedKey);
    }
    if (globalThis.localStorage?.getItem(LEGACY_LOCALLY_TERMINATED_FIREBASE_UID_KEY) === uid) {
      globalThis.localStorage.removeItem(LEGACY_LOCALLY_TERMINATED_FIREBASE_UID_KEY);
    }
  },

  getCurrentUser: (): SystemUser => {
    const users = dataService.getUsers();
    // Prioritize sessionStorage over localStorage as sessionStorage represents current non-remembered login
    const rawVal = sessionStorage.getItem(STORAGE_KEYS.CURRENT_USER) || localStorage.getItem(STORAGE_KEYS.CURRENT_USER);
    if (rawVal) {
      let targetId = rawVal;
      if (rawVal.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(rawVal);
          if (parsed && parsed.id) {
            targetId = parsed.id;
          } else if (parsed && parsed.username) {
            targetId = parsed.username;
          }
        } catch (e) {
          // ignore error and use rawVal
        }
      }
      const found = users.find(u => u.id === targetId || u.username.trim().toLowerCase() === targetId.trim().toLowerCase());
      if (found) return found;
    }
    // Return a dummy guest user instead of defaulting to admin to prevent unauthorized access
    return {
      id: 'guest',
      username: 'guest',
      fullName: 'زائر غير مسجل',
      role: 'زائر',
      permissions: [],
      createdAt: new Date().toISOString()
    };
  },

  setCurrentUser: (userId: string) => {
    localStorage.setItem(STORAGE_KEYS.CURRENT_USER, userId);
    sessionStorage.setItem(STORAGE_KEYS.CURRENT_USER, userId);
    dataService.notify();
  },

  createUser: async (user: SystemUser, initialPassword: string): Promise<{ success: boolean; message: string }> => {
    let sessionOwner: ManagedSessionOwner;
    try {
      sessionOwner = captureManagedSessionOwner();
    } catch (error) {
      const message = safeResultMessage(error, 'user-management');
      return { success: false, message };
    }
    if (!dataService.hasPermission('users_manage')) {
      return { success: false, message: 'لا تملك صلاحية إدارة المستخدمين.' };
    }
    const email = user.username.trim().toLowerCase();
    const users = dataService.getUsers();
    if (users.some(existing => existing.username.trim().toLowerCase() === email)) {
      return { success: false, message: 'البريد الإلكتروني مسجل محلياً لمستخدم آخر.' };
    }

    const draft: SystemUser = {
      ...user,
      username: email,
      authUid: undefined,
      active: true,
      createdAt: user.createdAt || new Date().toISOString(),
    };
    const cloud = await createManagedFirebaseUser(draft, initialPassword);
    if (!cloud.success || !cloud.user) return { success: false, message: cloud.message };

    try {
      assertManagedSessionAllowed(sessionOwner);
      const next = dataService.getUsers().filter(existing =>
        existing.id !== cloud.user!.id &&
        existing.authUid !== cloud.user!.authUid &&
        existing.username.trim().toLowerCase() !== cloud.user!.username.trim().toLowerCase()
      );
      next.push(cloud.user);
      await commitOfflineProjectionWrite(localStorage => {
        localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(next));
      }, () => assertManagedSessionAllowed(sessionOwner), () => assertManagedSessionOwnerCurrent(sessionOwner));
    } catch (error) {
      if (isManagedSessionChangedError(error)) return { success: false, message: safeResultMessage(error, 'user-management') };
      return { success: false, message: 'تم إنشاء الحساب على Firebase بنجاح لكن تعذر تحديث النسخة المحلية. أعد تحميل قائمة المستخدمين من الخادم قبل أي إجراء آخر.' };
    }

    // The managed-user service committed the profile and immutable central audit atomically.
    dataService.recordLocalWrite();
    dataService.notify();
    return { success: true, message: cloud.message };
  },

  saveUser: async (user: SystemUser): Promise<{ success: boolean; message: string }> => {
    let sessionOwner: ManagedSessionOwner;
    try {
      sessionOwner = captureManagedSessionOwner();
    } catch (error) {
      const message = safeResultMessage(error, 'user-management');
      return { success: false, message };
    }
    if (!dataService.hasPermission('users_manage')) {
      return { success: false, message: 'لا تملك صلاحية إدارة المستخدمين.' };
    }
    const users = dataService.getUsers();
    const index = users.findIndex(existing => existing.id === user.id);
    if (index === -1) {
      return { success: false, message: 'لا يمكن إنشاء مستخدم عبر مسار التعديل. استخدم إنشاء الحساب السحابي.' };
    }

    const existing = users[index];
    if (!existing.authUid) return { success: false, message: 'هذا سجل محلي قديم غير مرتبط بـ Firebase UID ولا يمكن اعتماده قبل ترحيله.' };
    const email = user.username.trim().toLowerCase();
    if (email !== existing.username.trim().toLowerCase()) return { success: false, message: 'لا يمكن تغيير بريد تسجيل الدخول لمستخدم مرتبط.' };
    if (users.some(other => other.id !== user.id && other.username.trim().toLowerCase() === email)) {
      return { success: false, message: 'البريد الإلكتروني مسجل لمستخدم آخر.' };
    }
    if (users.some(other => other.id !== user.id && other.authUid && other.authUid === existing.authUid)) {
      return { success: false, message: 'Firebase UID مرتبط بمستخدم آخر.' };
    }

    const current = dataService.getCurrentUser();
    if (current.id === existing.id && existing.permissions.includes('users_manage') && !user.permissions.includes('users_manage')) {
      return { success: false, message: 'لا يمكن للمستخدم الإداري سحب صلاحية users_manage من حسابه النشط.' };
    }

    const requested: SystemUser = {
      ...user,
      authUid: existing.authUid,
      username: existing.username,
      active: existing.active !== false,
      createdAt: existing.createdAt,
    };
    if (Object.prototype.hasOwnProperty.call(requested, 'password')) {
      delete (requested as unknown as Record<string, unknown>).password;
    }

    const cloud = await updateManagedFirebaseUserProfile(existing, requested);
    if (!cloud.success || !cloud.user) return { success: false, message: cloud.message };

    users[index] = cloud.user;
    try {
      assertManagedSessionAllowed(sessionOwner);
      await commitOfflineProjectionWrite(localStorage => {
        localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
      }, () => assertManagedSessionAllowed(sessionOwner), () => assertManagedSessionOwnerCurrent(sessionOwner));
    } catch (error) {
      if (isManagedSessionChangedError(error)) return { success: false, message: safeResultMessage(error, 'user-management') };
      return { success: false, message: 'تم تحديث الخادم لكن تعذر تثبيت النسخة المحلية. أعد تحميل الصفحة قبل متابعة العمل.' };
    }
    // The managed-user service committed the profile and immutable central audit atomically.
    dataService.recordLocalWrite();
    dataService.notify();
    return { success: true, message: cloud.message };
  },

  setUserActive: async (id: string, active: boolean): Promise<{ success: boolean; message: string }> => {
    let sessionOwner: ManagedSessionOwner;
    try {
      sessionOwner = captureManagedSessionOwner();
    } catch (error) {
      const message = safeResultMessage(error, 'user-management');
      return { success: false, message };
    }
    if (!dataService.hasPermission('users_manage')) {
      return { success: false, message: 'لا تملك صلاحية إدارة المستخدمين.' };
    }
    const users = dataService.getUsers();
    const index = users.findIndex(user => user.id === id);
    if (index === -1) return { success: false, message: 'المستخدم غير موجود.' };
    const target = users[index];
    const current = dataService.getCurrentUser();
    if (!active && current.id === target.id) {
      return { success: false, message: 'لا يمكن تعطيل الحساب النشط الذي تدير منه النظام.' };
    }
    if (!active && target.permissions.includes('users_manage')) {
      const otherActiveManagers = users.filter(user => user.id !== id && user.active !== false && user.permissions.includes('users_manage'));
      if (otherActiveManagers.length === 0) {
        return { success: false, message: 'لا يمكن تعطيل آخر مستخدم نشط يمتلك users_manage.' };
      }
    }

    const cloud = await setManagedFirebaseUserActive(target, active);
    if (!cloud.success || !cloud.user) return { success: false, message: cloud.message };
    users[index] = cloud.user;
    try {
      assertManagedSessionAllowed(sessionOwner);
      await commitOfflineProjectionWrite(localStorage => {
        localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
      }, () => assertManagedSessionAllowed(sessionOwner), () => assertManagedSessionOwnerCurrent(sessionOwner));
    } catch (error) {
      if (isManagedSessionChangedError(error)) return { success: false, message: safeResultMessage(error, 'user-management') };
      return { success: false, message: 'تم تحديث الخادم لكن تعذر تثبيت النسخة المحلية. أعد تحميل الصفحة قبل متابعة العمل.' };
    }
    // The managed-user service committed the profile and immutable central audit atomically.
    dataService.recordLocalWrite();
    dataService.notify();
    return { success: true, message: cloud.message };
  },

  deleteUser: async (id: string): Promise<{ success: boolean; message: string }> => {
    // P4 uses revocable application access instead of falsely claiming that the client can
    // delete another person's Firebase Authentication identity.
    return dataService.setUserActive(id, false);
  },

  sendUserPasswordReset: async (id: string): Promise<{ success: boolean; message: string }> => {
    let sessionOwner: ManagedSessionOwner;
    try {
      sessionOwner = captureManagedSessionOwner();
    } catch (error) {
      return { success: false, message: safeResultMessage(error, 'user-management') };
    }
    if (!dataService.hasPermission('users_manage')) {
      return { success: false, message: 'لا تملك صلاحية إدارة المستخدمين.' };
    }
    const user = dataService.getUsers().find(existing => existing.id === id);
    if (!user) return { success: false, message: 'المستخدم غير موجود.' };
    try {
      await dataService.logAudit(
        'طلب إعادة تعيين كلمة المرور',
        'تم تثبيت نية غير سرية قبل استدعاء Authentication؛ لا يثبت السجل وحده نتيجة الإرسال.',
        'إعدادات',
        {
          operationType: 'security',
          affectedEntities: [`users/${user.authUid || user.id}`],
          requireDurable: true,
          templateId: 'password_reset',
        },
      );
    } catch {
      return {
        success: false,
        message: 'تعذر تثبيت نية إعادة التعيين؛ لم يُستدعَ Firebase Authentication.',
      };
    }
    try {
      assertManagedSessionAllowed(sessionOwner);
    } catch (error) {
      return { success: false, message: safeResultMessage(error, 'user-management') };
    }
    return sendManagedUserPasswordReset(user);
  },

  refreshManagedUsersFromCloud: async (): Promise<{ success: boolean; message: string }> => {
    if (!dataService.hasPermission('users_manage')) {
      return { success: false, message: 'لا تملك صلاحية إدارة المستخدمين.' };
    }
    try {
      const sessionOwner = captureManagedSessionOwner();
      const result = await fetchManagedFirebaseUsers();
      if ('message' in result) return { success: false, message: result.message };
      await commitOfflineProjectionWrite(localStorage => {
        localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(result.users));
      }, () => assertManagedSessionAllowed(sessionOwner), () => assertManagedSessionOwnerCurrent(sessionOwner));
    } catch (error) {
      return { success: false, message: safeResultMessage(error, 'user-management') };
    }
    dataService.notify();
    return { success: true, message: 'تم تحديث قائمة المستخدمين من ملفات users/{uid} القانونية.' };
  },

  // UX / local eligibility only — NEVER cloud authority (G-C2). Firestore Rules authorize durable cloud mutations.
  hasPermission: (permission: string): boolean => {
    const u = dataService.getCurrentUser();
    return u ? u.permissions.includes(permission) : false;
  },

  // EXPIRE LOGIC HELPERS
  getPesticideExpiryStatus: (expiryDateStr: string, warningThresholdDays: number): 'safe' | 'warning' | 'critical' | 'expired' => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expiry = new Date(expiryDateStr);
    expiry.setHours(0, 0, 0, 0);

    if (expiry < today) {
      return 'expired';
    }

    const diffTime = expiry.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays <= 30) {
      return 'critical';
    }
    if (diffDays <= warningThresholdDays) {
      return 'warning';
    }
    return 'safe';
  },

  resetToFactoryDefaults: async () => {
    if (!dataService.hasPermission('system_reset')) {
      throw new Error('PERMISSION_DENIED: system_reset');
    }
    const currentSettings = dataService.getSettings();
    const wasCloudSyncEnabled = currentSettings.cloudSyncEnabled;

    await dataService.logAudit(
      'إعادة ضبط المصنع',
      'تم اعتماد طلب إعادة ضبط المصنع.',
      'إعدادات',
      {
        operationType: 'system',
        affectedEntities: ['system/factory-reset'],
        templateId: 'factory_reset',
        requireDurable: true,
      },
    );

    const retainedAuditLogs = dataService.getAuditLogs();
    const currentUser = dataService.getCurrentUser();
    stopCloudSync();

    const resetSettings: AppSettings = canonicalizeWarehouseSettings({
      ...DEFAULT_SETTINGS,
      organizationName: currentSettings.organizationName || DEFAULT_SETTINGS.organizationName,
      departmentName: currentSettings.departmentName || DEFAULT_SETTINGS.departmentName,
      storekeeperName: currentSettings.storekeeperName || DEFAULT_SETTINGS.storekeeperName,
      systemManagerName: currentSettings.systemManagerName || DEFAULT_SETTINGS.systemManagerName,
      healthDirectorName: currentSettings.healthDirectorName || DEFAULT_SETTINGS.healthDirectorName,
      cloudSyncEnabled: wasCloudSyncEnabled ?? true,
      transactionCounters: { inbound: 0, outbound: 0, consumed: 0, transfer: 0, adjustment: 0, opening: 0 },
      openingStockAttachments: {},
    });

    localStorage.setItem(STORAGE_KEYS.MATERIALS, JSON.stringify([]));
    localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify([]));
    localStorage.setItem(STORAGE_KEYS.GENERATOR_LOGS, JSON.stringify([]));
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(resetSettings));
    localStorage.setItem(STORAGE_KEYS.AUDIT_LOGS, JSON.stringify(retainedAuditLogs));
    if (currentUser) {
      localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify([currentUser]));
    }
    try {
      localStorage.setItem('show_reset_credentials', 'true');
      sessionStorage.setItem('show_reset_credentials', 'true');
    } catch {
      // informational only
    }
    dataService.notify();
  },

  clearLocalDeviceDataOnly: async (): Promise<void> => {
    await clearActiveAppSyncQueue().catch(() => 0);
    await clearActiveOfflineMutationJournals().catch(() => {});
    stopCloudSync();
    if (getCurrentAuthUser()) {
      try {
        await supabaseAuthSignOut();
      } catch {
        // Best-effort local sign-out
      }
    }
    try {
      clearOfflineDomainProjection();
    } catch {
      // Ignore if projection storage is unavailable
    }
    for (const storage of [localStorage, globalThis.localStorage, globalThis.sessionStorage]) {
      if (!storage) continue;
      try {
        storage.clear();
      } catch {
        // Ignore storage clear errors
      }
    }
    const idb = globalThis.indexedDB;
    if (idb && typeof idb.deleteDatabase === 'function') {
      const dbNames = ['remix_inventory_domain_v1', 'remix_inventory_sync_v1', 'firebaseLocalStorageDb'];
      await Promise.all(dbNames.map(name => new Promise<void>(resolve => {
        try {
          const req = idb.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        } catch {
          resolve();
        }
      })));
    }
    if (typeof globalThis.caches !== 'undefined' && typeof globalThis.caches?.keys === 'function') {
      try {
        const cacheKeys = await globalThis.caches.keys();
        await Promise.all(cacheKeys.map(key => globalThis.caches.delete(key).catch(() => false)));
      } catch {
        // Ignore CacheStorage errors
      }
    }
    dataService.notify();
  },

  uploadAllLocalDataToCloud: async (): Promise<{ success: boolean; message: string }> => {
    if (!isSupabaseConfigured() || !getCurrentAuthUser()) {
      return { success: false, message: 'خدمة السحابة غير متصلة حالياً. يرجى تسجيل الدخول أولاً.' };
    }
    try {
      const settings = dataService.getSettings();
      const materials = dataService.getMaterials();
      const transactions = dataService.getTransactions();
      const generatorLogs = dataService.getGeneratorLogs();
      const auditLogs = dataService.getAuditLogs();

      await supabaseDb.upsertDoc('settings', 'app_config', settings as unknown as Record<string, unknown>);
      if (materials.length > 0) {
        await supabaseDb.upsertDocs(
          'materials',
          materials.map(m => ({ id: m.id, payload: m as unknown as Record<string, unknown> })),
        );
      }
      if (transactions.length > 0) {
        await supabaseDb.upsertDocs(
          'transactions',
          transactions.map(t => ({ id: t.id, payload: t as unknown as Record<string, unknown> })),
        );
      }
      if (generatorLogs.length > 0) {
        await supabaseDb.upsertDocs(
          'generator_logs',
          generatorLogs.map(g => ({ id: g.id, payload: g as unknown as Record<string, unknown> })),
        );
      }
      if (auditLogs.length > 0) {
        await supabaseDb.upsertDocs(
          'audit_logs',
          auditLogs.map(a => ({ id: a.id, payload: a as unknown as Record<string, unknown> })),
        );
      }
      return {
        success: true,
        message: 'تم رفع ومزامنة جميع البيانات المحلية إلى قاعدة بيانات Supabase بنجاح.',
      };
    } catch (error) {
      return {
        success: false,
        message: safeResultMessage(error, 'sync'),
      };
    }
  },

  restoreBackupData: async (parsed: unknown): Promise<{ success: boolean; message: string }> => {
    if (!dataService.hasPermission('users_manage')
      || !dataService.hasPermission('settings_edit')
      || !dataService.hasPermission('system_reset')) {
      return {
        success: false,
        message: 'تم رفض الاستعادة: تتطلب العملية صلاحيات users_manage وsettings_edit وsystem_reset.',
      };
    }
    const check = await validateBackup(parsed);
    if (!check.success || !check.backup) {
      return { success: false, message: `تم رفض النسخة قبل تغيير أي بيانات: ${check.errors.join(' ')}` };
    }

    let rollback: (() => void) | null = null;
    try {
      stopCloudSync();
      rollback = applyBackupLocally(check.backup);
      if (isSupabaseConfigured() && getCurrentAuthUser()) {
        const uploadRes = await dataService.uploadAllLocalDataToCloud();
        if (!uploadRes.success) {
          throw new Error(uploadRes.message);
        }
      }
      await dataService.logAudit(
        'استعادة نسخة احتياطية آمنة',
        `تمت استعادة النسخة ${check.backup.manifest.backupId} مع الحفاظ على مركزية المستودع ${check.backup.manifest.selectedStorehouse}`,
        'إعدادات',
        {
          operationType: 'backup',
          affectedEntities: ['system/backup-restore'],
          templateId: 'backup_restore',
          requireDurable: true,
        },
      );
      await initCloudSync();
      dataService.notify();
      return {
        success: true,
        message: `تمت استعادة ${check.backup.manifest.counts.materials} صنف و${check.backup.manifest.counts.transactions} حركة بنجاح مع الحفاظ على مركزية المستودع ومزامنة السحابة.`,
      };
    } catch (error) {
      if (rollback) rollback();
      await initCloudSync().catch(() => {});
      return {
        success: false,
        message: safeResultMessage(error, 'restore'),
      };
    }
  },

  recoverInterruptedLocalRestoreAndFinalize: async (): Promise<{
    status: 'none' | 'finalized' | 'resumed_awaiting_audit' | 'quarantined' | 'owner_mismatch' | 'failed';
    message: string;
  }> => {
    const recoveryContinuation = captureSessionContinuation();
    const assertRecoveryContinuationCurrent = () => assertSessionContinuationCurrent(recoveryContinuation);
    assertRecoveryContinuationCurrent();
    const ownerUserId = resolveRestoreOwnerUserId();
    if (hasRestoreRecoveryQuarantine(ownerUserId)) {
      return {
        status: 'quarantined',
        message: 'سجل استعادة معزول بشكل دائم؛ أُوقفت الجلسة حتى إعادة التهيئة الآمنة.',
      };
    }

    const recovered = await recoverInterruptedLocalRestore({
      expectedOwnerUserId: ownerUserId,
      assertSessionCurrent: assertRecoveryContinuationCurrent,
    });
    assertRecoveryContinuationCurrent();
    if (recovered.status === 'none') {
      return { status: 'none', message: 'لا توجد نية استرداد نشطة.' };
    }
    if (recovered.status === 'quarantined') {
      return { status: 'quarantined', message: recovered.message };
    }
    if (recovered.status === 'owner_mismatch') {
      return { status: 'owner_mismatch', message: recovered.message };
    }
    if (recovered.status === 'failed') {
      return { status: 'failed', message: recovered.message };
    }

    // FV-P8-03: durable audit already committed — only finalize/clear (idempotent). Never re-audit / never rollback.
    if (recovered.status === 'audit_committed') {
      try {
        assertRecoveryContinuationCurrent();
        await finalizeCrashSafeLocalRestoreAfterAudit(recovered.record.ownerUserId, { expected: recovered.record });
        assertRecoveryContinuationCurrent();
        return {
          status: 'finalized',
          message: `اكتمل تنظيف نية الاسترداد بعد تدقيق دائم للنسخة ${recovered.record.backupId}.`,
        };
      } catch (finalizeError) {
        // Post-commit cleanup failure: leave audit_committed for retry; never rollback.
        return {
          status: 'finalized',
          message: `التدقيق مثبت؛ تعذر تنظيف نية الاسترداد وسيُعاد المحاولة: ${
            safeResultMessage(finalizeError, 'restore')
          }`,
        };
      }
    }

    // resumed: projection is consistent with the backup; durable audit still required.
    if (!dataService.hasPermission('users_manage')
      || !dataService.hasPermission('settings_edit')
      || !dataService.hasPermission('system_reset')) {
      return {
        status: 'resumed_awaiting_audit',
        message: 'أُعيد تطبيق النسخة؛ بانتظار تدقيق دائم بعد توفر صلاحيات الاستعادة.',
      };
    }

    // FV-P8-05/07: authoritative proof spans journal → handoff/outbox → confirmed (never local
    // audit_logs projection scan for templateId backup_restore + backupId).
    const restoreAuditOperationId = await resolveRestoreAuditOperationId(recovered.record);
    assertRecoveryContinuationCurrent();
    const restoreAuditTimestamp = resolveRestoreAuditTimestamp(recovered.record);
    const restoreDeliveryMutationId = await resolveRestoreDeliveryMutationId(recovered.record);
    assertRecoveryContinuationCurrent();
    if (
      recovered.record.auditOperationId !== restoreAuditOperationId
      || recovered.record.auditTimestamp !== restoreAuditTimestamp
      || recovered.record.deliveryMutationId !== restoreDeliveryMutationId
    ) {
      try {
        await persistRestoreRecoveryRecord({
          ...recovered.record,
          auditOperationId: restoreAuditOperationId,
          auditTimestamp: restoreAuditTimestamp,
          deliveryMutationId: restoreDeliveryMutationId,
          updatedAt: new Date().toISOString(),
        }, { assertSessionCurrent: assertRecoveryContinuationCurrent });
        assertRecoveryContinuationCurrent();
      } catch {
        // Best-effort; logAudit still uses the resolved identity for this attempt.
      }
    }
    try {
      // Check durable exact-envelope proof first (journal/handoff/confirmed work without AppSync started).
      const recoverProofActor = resolveAuditActor();
      const recoverProofIdentity = {
        ownerUserId: recovered.record.ownerUserId,
        auditOperationId: restoreAuditOperationId,
        deliveryMutationId: restoreDeliveryMutationId,
        auditTimestamp: restoreAuditTimestamp,
        actorUserId: recoverProofActor.actorUserId,
        actorDisplayName: recoverProofActor.actorDisplayName,
        itemType: 'إعدادات' as const,
      };
      let hasDeliveryProof = await hasAuthoritativeRestoreAuditDeliveryProof(recoverProofIdentity);
      assertRecoveryContinuationCurrent();
      if (!hasDeliveryProof) {
        // FV-P8-07: delivery-only AppSync BEFORE enqueue so boot does not false-fail on
        // missing activeUserId. Does not register cloud snapshot listeners on partial projection.
        await ensureAppSyncDeliveryOnly(recovered.record.ownerUserId);
        assertRecoveryContinuationCurrent();
        hasDeliveryProof = await hasAuthoritativeRestoreAuditDeliveryProof(recoverProofIdentity);
        assertRecoveryContinuationCurrent();
      }
      if (!hasDeliveryProof) {
        await dataService.logAudit(
          'استعادة نسخة احتياطية آمنة',
          `تمت استعادة النسخة ${recovered.backup.manifest.backupId} مع الحفاظ على مركزية المستودع ${recovered.backup.manifest.selectedStorehouse}`,
          'إعدادات',
          {
            operationType: 'backup',
            affectedEntities: ['system/backup-restore'],
            templateId: 'backup_restore',
            requireDurable: true,
            clientAuditId: restoreAuditOperationId,
            clientAuditTimestamp: restoreAuditTimestamp,
            clientMutationId: restoreDeliveryMutationId,
          },
        );
        assertRecoveryContinuationCurrent();
      }
      const recoveredCommitted = await markRestoreRecoveryAuditCommitted(recovered.record.ownerUserId, {
        backupId: recovered.backup.manifest.backupId,
        checksum: recovered.backup.manifest.checksum,
        auditOperationId: restoreAuditOperationId,
        expected: recovered.record,
      });
      assertRecoveryContinuationCurrent();
      // Post-audit: null-equivalent — finalize only; never rollback on cleanup failure.
      try {
        await finalizeCrashSafeLocalRestoreAfterAudit(recovered.record.ownerUserId, { expected: recoveredCommitted });
        assertRecoveryContinuationCurrent();
      } catch (finalizeError) {
        return {
          status: 'finalized',
          message: `اكتمل استرداد الاستعادة مع تدقيق دائم؛ تنظيف النية معلّق: ${
            safeResultMessage(finalizeError, 'restore')
          }`,
        };
      }
      return {
        status: 'finalized',
        message: `اكتمل استرداد الاستعادة المتقطعة للنسخة ${recovered.backup.manifest.backupId}.`,
      };
    } catch (error) {
      if (!isSessionContinuationCurrent(recoveryContinuation)) {
        return {
          status: 'resumed_awaiting_audit',
          message: 'تغيّرت الجلسة أثناء استرداد الاستعادة؛ تُرك سجل الاسترداد للجلسة الحالية دون لمس إسقاطها.',
        };
      }
      return {
        status: 'resumed_awaiting_audit',
        message: `أُعيد تطبيق النسخة وبقي سجل الاسترداد بانتظار التدقيق: ${
          safeResultMessage(error, 'restore')
        }`,
      };
    }
  },

  toggleCloudSync: async (_enabled: boolean): Promise<{ success: boolean; message: string }> => {
    if (!CLOUD_LISTENERS_ENABLED) {
      return { success: false, message: 'المزامنة السحابية معطلة لحين اعتماد ترحيل السحابة' };
    }
    
    const settings = dataService.getSettings();
    settings.cloudSyncEnabled = true; // Force always enabled as requested
    
    if (!isSupabaseConfigured()) {
      return { success: false, message: 'تعذر تنشيط السحابة: ملقم جوجل سحابة غير مهيأ' };
    }
    
    // Upload local data to Firestore so the user doesn't see blank page
    if (!settings.firebaseInitialized) {
      const res = await dataService.uploadAllLocalDataToCloud();
      if (!res.success) {
        return res;
      }
      settings.firebaseInitialized = true;
    }
    
    // Save settings locally
    localStorage.setItem('remix_settings_v1', JSON.stringify(settings));
    
    // Initialize or teardown cloud sync listeners
    initCloudSync();
    
    dataService.notify();
    return { success: true, message: 'التزامن السحابي المباشر مفعل دائماً وإلزامي لضمان دقة وتطابق البيانات بين الأجهزة.' };
  },

  recordLocalWrite: () => {
    localStorage.setItem('last_local_write_time', new Date().toISOString());
  },

  recordGoogleDriveBackupTime: () => {
    localStorage.setItem('last_google_drive_backup_time', new Date().toISOString());
  },

  hasUnbackedUpChanges: (): boolean => {
    const settings = dataService.getSettings();
    if (settings.cloudSyncEnabled && isSupabaseConfigured()) {
      const sync = getAppSyncSnapshot();
      return sync.pending + sync.retrying + sync.staging + sync.conflicts + sync.blocked + (sync.quarantined ?? 0) > 0;
    }
    const lastWrite = localStorage.getItem('last_local_write_time');
    if (!lastWrite) return false;
    const lastBackup = localStorage.getItem('last_google_drive_backup_time');
    if (!lastBackup) return true;
    return new Date(lastWrite) > new Date(lastBackup);
  },
  saveTransfer: async (
    itemId: string,
    quantity: number,
    sourceStorehouse: string,
    destStorehouse: string,
    executedBy: string,
    notes: string,
    transactionDate?: string
  ): Promise<{ success: boolean; message: string }> => {
    const materials = dataService.getMaterials();
    const item = materials.find((material) => material.id === itemId);
    if (!item) return { success: false, message: 'الصنف غير موجود' };

    const settings = dataService.getSettings();
    const previousSettings = JSON.parse(JSON.stringify(settings)) as AppSettings;
    const sourceEntity = getStorehouseByReference(settings, sourceStorehouse, false);
    const destinationEntity = getStorehouseByReference(settings, destStorehouse, false);
    if (!sourceEntity || !destinationEntity) return { success: false, message: 'مصدر أو وجهة التحويل ليست مستودعاً فعالاً صالحاً.' };
    if (sourceEntity.id === destinationEntity.id) return { success: false, message: 'لا يمكن التحويل لنفس المستودع' };

    const scope = resolveWarehouseScope(settings, getPersistedWarehouseScopeReference());
    if (scope.scope === 'warehouse' && scope.selectedStorehouseId !== sourceEntity.id) {
      return { success: false, message: 'مستودع مصدر التحويل يجب أن يطابق المستودع النشط المحدد على مستوى التطبيق.' };
    }

    const normalizedQuantity = Number(quantity);
    if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) return { success: false, message: 'الكمية يجب أن تكون أكبر من صفر' };

    const transactions = dataService.getTransactions() as IntegrityTransaction[];
    const existingNumbers = new Set(transactions.map((tx) => tx.transactionNumber?.trim()).filter((value): value is string => !!value));
    if (!settings.transactionCounters) settings.transactionCounters = { inbound: 0, outbound: 0, consumed: 0, transfer: 0, adjustment: 0, opening: 0 };
    let seq = settings.transactionCounters.transfer || 0;
    let baseNumber = '';
    do {
      seq += 1;
      baseNumber = `T-${String(seq).padStart(4, '0')}`;
    } while (existingNumbers.has(`${baseNumber}-OUT`) || existingNumbers.has(`${baseNumber}-IN`));

    const dateStr = transactionDate || new Date().toISOString().split('T')[0];
    const now = Date.now();
    const operationId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `transfer-${crypto.randomUUID()}`
      : `transfer-${now}-${seq}`;
    const sourceId = `${operationId}-out`;
    const destinationId = `${operationId}-in`;
    const sourceStock = dataService.getItemStockByStorehouse(item.id, sourceEntity.id);
    const destinationStock = dataService.getItemStockByStorehouse(item.id, destinationEntity.id);

    const sourceTx: IntegrityTransaction = {
      id: sourceId,
      pairedTransactionId: destinationId,
      operationId,
      transactionNumber: `${baseNumber}-OUT`,
      date: dateStr,
      itemId: item.id,
      itemCode: item.code,
      itemName: item.name,
      itemCategory: item.category,
      transactionType: 'تحويل',
      transferType: 'out',
      quantity: normalizedQuantity,
      storehouse: sourceEntity.name,
      storehouseId: sourceEntity.id,
      stockBefore: sourceStock,
      stockAfter: sourceStock - normalizedQuantity,
      executedBy,
      supplierOrReceiver: `تحويل إلى ${destinationEntity.name}`,
      notes,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      unit: item.unit,
    };

    const destinationTx: IntegrityTransaction = {
      id: destinationId,
      pairedTransactionId: sourceId,
      operationId,
      transactionNumber: `${baseNumber}-IN`,
      date: dateStr,
      itemId: item.id,
      itemCode: item.code,
      itemName: item.name,
      itemCategory: item.category,
      transactionType: 'تحويل',
      transferType: 'in',
      quantity: normalizedQuantity,
      storehouse: destinationEntity.name,
      storehouseId: destinationEntity.id,
      stockBefore: destinationStock,
      stockAfter: destinationStock + normalizedQuantity,
      executedBy,
      supplierOrReceiver: `تحويل من ${sourceEntity.name}`,
      notes,
      createdAt: new Date(now + 1).toISOString(),
      updatedAt: new Date(now + 1).toISOString(),
      unit: item.unit,
    };

    const next = [destinationTx, sourceTx, ...transactions];
    const integrity = validateInventoryDataset(next, { materials, storehouses: getStorehouseEntities(settings) });
    const legacyTransferIds = new Set(transactions.filter((tx) => tx.transactionType === 'تحويل' && !tx.operationId && !tx.pairedTransactionId).map((tx) => tx.id));
    const blockingErrors = integrity.errors.filter((error) =>
      !(error.code === 'TRANSFER_OPERATION_REQUIRED' && !!error.transactionId && legacyTransferIds.has(error.transactionId))
    );
    if (blockingErrors.length > 0) return { success: false, message: blockingErrors[0].message };

    const writeLimit = validateAtomicWriteCount(3, MAX_ATOMIC_FIRESTORE_WRITES);
    if (!writeLimit.valid) return { success: false, message: writeLimit.errors[0].message };

    const previousTransactionsRaw = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
    const previousSettingsRaw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    settings.transactionCounters.transfer = seq;
    try {
      localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(next));
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    } catch (_) {
      if (previousTransactionsRaw === null) localStorage.removeItem(STORAGE_KEYS.TRANSACTIONS);
      else localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, previousTransactionsRaw);
      if (previousSettingsRaw === null) localStorage.removeItem(STORAGE_KEYS.SETTINGS);
      else localStorage.setItem(STORAGE_KEYS.SETTINGS, previousSettingsRaw);
      return { success: false, message: 'تعذر حفظ التحويل محلياً؛ لم يتم تنفيذ أي كتابة سحابية.' };
    }

    try {
      await ensureCloudSettingsSeeded(previousSettings, { includeRoot: false });
      await queueCloudMutation([
        settingsRootSyncOp(settings, previousSettings),
        createSyncSetOperation('transactions', sourceTx.id, sourceTx as unknown as Record<string, unknown>, undefined),
        createSyncSetOperation('transactions', destinationTx.id, destinationTx as unknown as Record<string, unknown>, undefined),
      ], `save-transfer:${operationId}`);
    } catch (error) {
      if (!shouldRestoreLocalProjection(error)) throw error;
      if (previousTransactionsRaw === null) localStorage.removeItem(STORAGE_KEYS.TRANSACTIONS);
      else localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, previousTransactionsRaw);
      if (previousSettingsRaw === null) localStorage.removeItem(STORAGE_KEYS.SETTINGS);
      else localStorage.setItem(STORAGE_KEYS.SETTINGS, previousSettingsRaw);
      return { success: false, message: safeResultMessage(error, 'generic') };
    }

    await dataService.logAudit('تحويل مخزني', `تحويل ${normalizedQuantity} ${item.unit} من ${sourceEntity.name} إلى ${destinationEntity.name} لصنف ${item.name} ضمن العملية ${operationId}`, 'حركة');
    dataService.recordLocalWrite();
    dataService.notify();
    return { success: true, message: 'تم التحويل بنجاح كساقين مترابطتين ذرياً' };
  },
  isFirebaseOnline: (): boolean => {
    return isSupabaseConfigured() && firebaseOnline && getAppSyncSnapshot().online;
  },

  // GENERATOR LOGS
  getGeneratorLogs: (): GeneratorLogEntry[] => {
    const data = localStorage.getItem(STORAGE_KEYS.GENERATOR_LOGS);
    let logs: GeneratorLogEntry[] = [];
    if (data) {
      try {
        logs = JSON.parse(data);
      } catch (_) {
        logs = [];
      }
    }
    return logs.sort((a, b) => a.date.localeCompare(b.date));
  },

  getLatestGeneratorLog: (): GeneratorLogEntry | undefined => {
    const logs = dataService.getGeneratorLogs();
    if (logs.length === 0) return undefined;
    return logs[logs.length - 1]; // Already sorted by date ascending in getGeneratorLogs
  },

  recalculateGeneratorChain: (inputLogs: GeneratorLogEntry[]): GeneratorLogEntry[] => {
    const sorted = [...inputLogs].sort((a, b) => a.date.localeCompare(b.date));
    const result: GeneratorLogEntry[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const current = { ...sorted[i] };
      if (i === 0) {
        // First record keeps its previousReading (either manual if system started empty, or 0)
        current.operatingHours = Number((current.currentReading - current.previousReading).toFixed(2));
      } else {
        const prev = result[i - 1];
        current.previousReading = prev.currentReading;
        current.operatingHours = Number((current.currentReading - current.previousReading).toFixed(2));
      }

      if (current.currentReading < current.previousReading) {
        throw new Error(`INVALID_SEQUENCE:${current.date}:${current.currentReading}:${current.previousReading}`);
      }
      result.push(current);
    }
    return result;
  },

  simulateSaveGeneratorLog: (
    entry: Partial<GeneratorLogEntry> & { date: string; currentReading: number; previousReading?: number }
  ): GeneratorLogSimulationResult => {
    const logs = dataService.getGeneratorLogs();
    const isEditing = Boolean(entry.id && logs.some((l) => l.id === entry.id));

    // Duplicate date check
    const duplicate = logs.find((l) => l.date === entry.date && l.id !== entry.id);
    if (duplicate) {
      throw new Error('DUPLICATE_DATE_EXISTS');
    }

    const getDayName = (dStr: string) => {
      const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
      const dt = new Date(dStr + 'T00:00:00');
      return days[dt.getDay()] || '';
    };

    const now = new Date().toISOString();
    const currentUser = dataService.getCurrentUser();
    const createdBy = entry.createdBy || currentUser?.fullName || currentUser?.username || 'مستخدم النظام';

    let candidateLogs: GeneratorLogEntry[] = [];
    let targetId = entry.id || `gen-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;

    if (isEditing) {
      candidateLogs = logs.map((l) => {
        if (l.id === entry.id) {
          const prevReading = entry.previousReading !== undefined ? entry.previousReading : l.previousReading;
          return {
            ...l,
            ...entry,
            date: entry.date,
            dayName: entry.dayName || getDayName(entry.date),
            previousReading: prevReading,
            currentReading: entry.currentReading,
            operatingHours: Number((entry.currentReading - prevReading).toFixed(2)),
            updatedAt: now,
          };
        }
        return l;
      });
    } else {
      // Determine initial previousReading if adding
      let initialPrevReading = entry.previousReading ?? 0;
      const sortedBefore = logs.filter((l) => l.date < entry.date).sort((a, b) => a.date.localeCompare(b.date));
      if (logs.length > 0) {
        if (sortedBefore.length > 0) {
          initialPrevReading = sortedBefore[sortedBefore.length - 1].currentReading;
        } else {
          // Inserting before all existing logs
          initialPrevReading = entry.previousReading ?? 0;
        }
      }

      const newLog: GeneratorLogEntry = {
        id: targetId,
        date: entry.date,
        dayName: entry.dayName || getDayName(entry.date),
        previousReading: initialPrevReading,
        currentReading: entry.currentReading,
        operatingHours: Number((entry.currentReading - initialPrevReading).toFixed(2)),
        notes: entry.notes || '',
        createdAt: now,
        updatedAt: now,
        createdBy,
      };
      candidateLogs = [...logs, newLog];
    }

    // Run recalculation chain
    const proposedLogs = dataService.recalculateGeneratorChain(candidateLogs);

    // Compute Impact
    const oldLogsMap = new Map(logs.map((l) => [l.id, l]));
    const impactedItems: any[] = [];

    proposedLogs.forEach((newLog) => {
      const oldLog = oldLogsMap.get(newLog.id);
      if (!oldLog) {
        // Newly added log
        impactedItems.push({
          id: newLog.id,
          date: newLog.date,
          dayName: newLog.dayName,
          oldPreviousReading: 0,
          newPreviousReading: newLog.previousReading,
          oldCurrentReading: 0,
          newCurrentReading: newLog.currentReading,
          oldOperatingHours: 0,
          newOperatingHours: newLog.operatingHours,
          isNew: true,
        });
      } else if (
        oldLog.previousReading !== newLog.previousReading ||
        oldLog.currentReading !== newLog.currentReading ||
        oldLog.operatingHours !== newLog.operatingHours ||
        oldLog.date !== newLog.date
      ) {
        impactedItems.push({
          id: newLog.id,
          date: newLog.date,
          dayName: newLog.dayName,
          oldPreviousReading: oldLog.previousReading,
          newPreviousReading: newLog.previousReading,
          oldCurrentReading: oldLog.currentReading,
          newCurrentReading: newLog.currentReading,
          oldOperatingHours: oldLog.operatingHours,
          newOperatingHours: newLog.operatingHours,
          isNew: false,
        });
      }
    });

    const lastAffected = impactedItems.length > 0 ? impactedItems[impactedItems.length - 1].date : undefined;

    return {
      actionType: isEditing ? 'edit_old' : (logs.some((l) => l.date > entry.date) ? 'add_old' : 'normal_save'),
      affectedCount: impactedItems.length,
      lastAffectedRecordDate: lastAffected,
      impactedItems,
      proposedLogs,
    };
  },

  simulateDeleteGeneratorLog: (id: string): GeneratorLogSimulationResult => {
    const logs = dataService.getGeneratorLogs();
    const target = logs.find((l) => l.id === id);
    if (!target) {
      throw new Error('RECORD_NOT_FOUND');
    }

    const candidateLogs = logs.filter((l) => l.id !== id);
    const proposedLogs = candidateLogs.length > 0 ? dataService.recalculateGeneratorChain(candidateLogs) : [];

    const oldLogsMap = new Map(logs.map((l) => [l.id, l]));
    const impactedItems: any[] = [];

    proposedLogs.forEach((newLog) => {
      const oldLog = oldLogsMap.get(newLog.id);
      if (
        oldLog &&
        (oldLog.previousReading !== newLog.previousReading ||
          oldLog.currentReading !== newLog.currentReading ||
          oldLog.operatingHours !== newLog.operatingHours)
      ) {
        impactedItems.push({
          id: newLog.id,
          date: newLog.date,
          dayName: newLog.dayName,
          oldPreviousReading: oldLog.previousReading,
          newPreviousReading: newLog.previousReading,
          oldCurrentReading: oldLog.currentReading,
          newCurrentReading: newLog.currentReading,
          oldOperatingHours: oldLog.operatingHours,
          newOperatingHours: newLog.operatingHours,
          isNew: false,
        });
      }
    });

    const lastAffected = impactedItems.length > 0 ? impactedItems[impactedItems.length - 1].date : undefined;

    return {
      actionType: 'delete',
      affectedCount: impactedItems.length + 1, // Including deleted target
      lastAffectedRecordDate: lastAffected,
      impactedItems,
      proposedLogs,
    };
  },

  commitGeneratorLogs: async (logs: GeneratorLogEntry[], auditActionMessage?: string, deletedLogs: GeneratorLogEntry[] = []): Promise<void> => {
    const previousLogs = dataService.getGeneratorLogs();
    const previousRaw = localStorage.getItem(STORAGE_KEYS.GENERATOR_LOGS);
    const previousById = new Map(previousLogs.map((log) => [log.id, log] as const));
    const sorted = [...logs].sort((a, b) => a.date.localeCompare(b.date));
    const changed = sorted.filter((log) => JSON.stringify(log) !== JSON.stringify(previousById.get(log.id)));
    const writeLimit = validateAtomicWriteCount(changed.length + deletedLogs.length, MAX_ATOMIC_FIRESTORE_WRITES);
    if (!writeLimit.valid) throw new Error(writeLimit.errors[0].message);
    localStorage.setItem(STORAGE_KEYS.GENERATOR_LOGS, JSON.stringify(sorted));

    try {
      await queueCloudMutation([
        ...changed.map((savedLog) => createSyncSetOperation(
          'generator_logs',
          savedLog.id,
          savedLog as unknown as Record<string, unknown>,
          previousById.get(savedLog.id),
        )),
        ...deletedLogs.map((deletedLog) => createSyncDeleteOperation('generator_logs', deletedLog.id, deletedLog)),
      ], 'commit-generator-log-chain');
    } catch (error) {
      if (!shouldRestoreLocalProjection(error)) throw error;
      if (previousRaw === null) localStorage.removeItem(STORAGE_KEYS.GENERATOR_LOGS);
      else localStorage.setItem(STORAGE_KEYS.GENERATOR_LOGS, previousRaw);
      throw error;
    }

    if (auditActionMessage) {
      await dataService.logAudit('تحديث سجلات المولد', auditActionMessage, 'مولد');
    }
    dataService.recordLocalWrite();
    dataService.notify();
  },

  saveGeneratorLog: async (entry: Partial<GeneratorLogEntry> & { date: string; currentReading: number; previousReading?: number }): Promise<GeneratorLogEntry> => {
    const sim = dataService.simulateSaveGeneratorLog(entry);
    await dataService.commitGeneratorLogs(
      sim.proposedLogs,
      `تم حفظ/تحديث سجل المولد بتاريخ ${entry.date} مع إعادة حساب ${sim.affectedCount} سجل متأثر`
    );
    return sim.proposedLogs.find((l) => l.date === entry.date) || sim.proposedLogs[sim.proposedLogs.length - 1];
  },

  deleteGeneratorLog: async (id: string): Promise<void> => {
    const deletedLog = dataService.getGeneratorLogs().find((log) => log.id === id);
    if (!deletedLog) throw new Error('سجل المولد غير موجود');
    const sim = dataService.simulateDeleteGeneratorLog(id);
    await dataService.commitGeneratorLogs(
      sim.proposedLogs,
      `تم حذف سجل المولد وإعادة حساب ${sim.affectedCount} سجل متأثر`,
      [deletedLog],
    );
  },
};

let realtimeUnsubscribe: (() => void) | null = null;

export function watchCurrentFirebaseUserProfile(onInvalid: (message: string) => void): () => void {
  const currentUser = getCurrentAuthUser();
  if (!isSupabaseConfigured() || !currentUser?.uid || !currentUser.email) {
    return () => {};
  }
  const expectedUid = currentUser.uid;
  const expectedEmail = currentUser.email.trim().toLowerCase();
  let active = true;

  const unsubscribe = supabaseDb.subscribeTables(['users'], async () => {
    if (!active || getCurrentAuthUser()?.uid !== expectedUid) return;
    try {
      const remoteUser = await supabaseDb.getDoc<SystemUser>('users', expectedUid);
      if (!active || getCurrentAuthUser()?.uid !== expectedUid) return;
      if (!remoteUser) {
        active = false;
        onInvalid('تم إلغاء ملف المستخدم على الخادم. انتهت الجلسة حفاظاً على الأمان.');
        return;
      }
      if (remoteUser.active === false) {
        active = false;
        onInvalid('تم تعطيل هذا الحساب من قبل مدير النظام. انتهت الجلسة.');
        return;
      }
      const validation = validateCanonicalManagedUser(expectedUid, remoteUser, {
        expectedEmail,
        requireActive: true,
      });
      if (!validation.valid) {
        active = false;
        onInvalid('تغير ملف صلاحيات المستخدم إلى حالة غير صالحة. انتهت الجلسة.');
        return;
      }
      const canonical = validation.user;
      const users = dataService.getUsers().filter(existing =>
        existing.id !== canonical.id &&
        existing.authUid !== canonical.authUid &&
        existing.username.trim().toLowerCase() !== canonical.username.trim().toLowerCase()
      );
      users.push(canonical);
      localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
      dataService.setCurrentUser(canonical.id);
      dataService.notify();
    } catch {
      // Ignore transient network errors during profile watch
    }
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

export const __p10EnqueueFenceTestApi = {
  block: (reason: ProtectedEnqueueBlockReason) => blockProtectedCloudEnqueue(reason),
  clear: () => clearProtectedCloudEnqueueBlock(),
  reason: () => getProtectedCloudEnqueueBlockReason(),
  assertAllowed: () => assertProtectedCloudEnqueueAllowed(),
  queueCloudMutation: (
    operations: SyncOperation[],
    label: string,
    options?: {
      requireRemoteCommit?: boolean;
      clientMutationId?: string;
      createdAt?: number;
    },
  ) => queueCloudMutation(operations, label, options),
};

export function stopCloudSync(expectedOwnerUid?: string): boolean {
  if (expectedOwnerUid !== undefined && cloudSyncOwnerUid !== expectedOwnerUid) return false;
  cloudSyncGeneration += 1;
  syncIssueRefreshGeneration += 1;
  if (realtimeUnsubscribe) {
    try {
      realtimeUnsubscribe();
    } catch {
      // Ignore unsubscribe errors
    }
    realtimeUnsubscribe = null;
  }
  stopAppSync();

  monitoringDifferences = [];
  monitoringError = null;
  Object.keys(monitoringErrors).forEach(k => delete monitoringErrors[k]);
  monitoringReadyCollections.clear();
  listenerMigrationCache = null;
  listenerMigrationCacheHits = 0;
  listenerMigrationCacheMisses = 0;
  syncIssues = [];
  pendingCloudWritesCount = 0;
  lastCloudWriteError = null;
  lastCloudWriteErrorPersistence = 'unknown';
  cloudSyncOwnerUid = null;
  return true;
}

export const __p9MonitoringTestApi = {
  setPendingCloudWritesCount: (count: number) => { pendingCloudWritesCount = count; },
  setLastCloudWriteError: (error: string | null, persistence: SyncErrorPersistence = 'unknown') => {
    lastCloudWriteError = error;
    lastCloudWriteErrorPersistence = persistence;
  },
  setMonitoringError: (collection: string, error: string | null) => { setMonitoringError(collection, error); },
  markReady: (collection: string) => { monitoringReadyCollections.add(collection); },
  clearReady: () => { monitoringReadyCollections.clear(); },
  setSyncIssues: (issues: AppSyncIssue[]) => { syncIssues = issues; },
  setDifferences: (diffs: MonitoringDifference[]) => { monitoringDifferences = diffs; },
  setCloudSyncOwnerUid: (uid: string | null) => { cloudSyncOwnerUid = uid; },
  getCloudSyncOwnerUid: () => cloudSyncOwnerUid,
  getCloudSyncGeneration: () => cloudSyncGeneration,
  getMonitoringErrorsCopy: () => ({ ...monitoringErrors }),
  getListenerMigrationCacheStats: () => ({
    hits: listenerMigrationCacheHits,
    misses: listenerMigrationCacheMisses,
    cachedKey: listenerMigrationCache?.key ?? null,
  }),
};

export async function ensureAppSyncDeliveryOnly(_userId: string): Promise<void> {
  return;
}

export async function initCloudSync() {
  stopCloudSync();
  const sessionGeneration = cloudSyncGeneration;

  if (!CLOUD_LISTENERS_ENABLED && !CLOUD_MONITORING_ENABLED) {
    return;
  }

  const settings = dataService.getSettings();
  const currentUser = getCurrentAuthUser();
  if (!isSupabaseConfigured() || !settings.cloudSyncEnabled || !currentUser?.uid) {
    return;
  }

  cloudSyncOwnerUid = currentUser.uid;
  const expected = dataService.getExpectedMonitoringCollections();
  for (const col of expected) {
    setMonitoringError(col, null);
    monitoringReadyCollections.add(col);
  }
  dataService.notify();

  const tablesToWatch: SupabaseTableName[] = [
    'settings',
    'materials',
    'transactions',
    'audit_logs',
    'generator_logs',
    'users',
  ];

  realtimeUnsubscribe = supabaseDb.subscribeTables(tablesToWatch, async (table) => {
    if (cloudSyncGeneration !== sessionGeneration || getCurrentAuthUser()?.uid !== cloudSyncOwnerUid) {
      return;
    }
    try {
      if (table === 'settings' && dataService.hasPermission('settings_view')) {
        const remoteSettings = await supabaseDb.getDoc<Record<string, unknown>>('settings', 'app_config');
        if (remoteSettings && cloudSyncGeneration === sessionGeneration) {
          const canonical = composeSupabaseAppSettings(remoteSettings, DEFAULT_SETTINGS);
          localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(canonical));
          setMonitoringError('settings', null);
          monitoringReadyCollections.add('settings');
          dataService.notify();
        }
      } else if (table === 'materials' && dataService.hasPermission('materials_view')) {
        const rows = await supabaseDb.getCollection<Material>('materials');
        if (cloudSyncGeneration === sessionGeneration) {
          const currentSettings = dataService.getSettings();
          const currentTransactions = dataService.getTransactions();
          const cleaned = rows.map(r => ({ ...(stripSyncMetadata(r) as unknown as Material), id: r.id }));
          const normalized = migrateWarehouseModel({
            settings: currentSettings,
            materials: cleaned,
            transactions: currentTransactions,
          });
          localStorage.setItem(
            STORAGE_KEYS.MATERIALS,
            JSON.stringify(normalized.errors.length === 0 ? normalized.materials : cleaned),
          );
          setMonitoringError('materials', null);
          monitoringReadyCollections.add('materials');
          dataService.notify();
        }
      } else if (table === 'transactions' && dataService.hasPermission('transactions_view')) {
        const rows = await supabaseDb.getCollection<InventoryTransaction>('transactions');
        if (cloudSyncGeneration === sessionGeneration) {
          const currentSettings = dataService.getSettings();
          const currentMaterials = dataService.getMaterials();
          const cleaned = rows.map(r => ({ ...(stripSyncMetadata(r) as unknown as InventoryTransaction), id: r.id }));
          const normalized = migrateWarehouseModel({
            settings: currentSettings,
            materials: currentMaterials,
            transactions: cleaned,
          });
          const toStore = (normalized.errors.length === 0 ? normalized.transactions : cleaned).sort(
            (a, b) => new Date(b.createdAt || b.date).getTime() - new Date(a.createdAt || a.date).getTime(),
          );
          localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(toStore));
          setMonitoringError('transactions', null);
          monitoringReadyCollections.add('transactions');
          dataService.notify();
        }
      } else if (table === 'audit_logs' && dataService.hasPermission('audit_view')) {
        const rows = await supabaseDb.getCollection<Record<string, unknown>>('audit_logs');
        if (cloudSyncGeneration === sessionGeneration) {
          const logs = rows
            .map(d => normalizeAuditLog(stripSyncMetadata(d), String(d.id || '')))
            .filter((entry): entry is AuditLog => !!entry)
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          localStorage.setItem(STORAGE_KEYS.AUDIT_LOGS, JSON.stringify(logs));
          setMonitoringError('audit_logs', null);
          monitoringReadyCollections.add('audit_logs');
          dataService.notify();
        }
      } else if (table === 'generator_logs' && dataService.hasPermission('generator_log')) {
        const rows = await supabaseDb.getCollection<GeneratorLogEntry>('generator_logs');
        if (cloudSyncGeneration === sessionGeneration) {
          const cleaned = rows.map(r => ({ ...(stripSyncMetadata(r) as unknown as GeneratorLogEntry), id: r.id }));
          localStorage.setItem(STORAGE_KEYS.GENERATOR_LOGS, JSON.stringify(cleaned));
          setMonitoringError('generator_logs', null);
          monitoringReadyCollections.add('generator_logs');
          dataService.notify();
        }
      } else if (table === 'users' && dataService.hasPermission('users_manage')) {
        const rows = await supabaseDb.getCollection<SystemUser>('users');
        if (cloudSyncGeneration === sessionGeneration) {
          const cleaned = rows.map(u => {
            const copy = { ...(stripSyncMetadata(u) as unknown as SystemUser), id: u.id };
            delete (copy as unknown as Record<string, unknown>).password;
            return copy;
          });
          localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(cleaned));
          dataService.notify();
        }
      }
    } catch (error) {
      setMonitoringError(table, `Sync reconciliation error: ${safeErrorDetail(error)}`);
      dataService.notify();
    }
  });
}
