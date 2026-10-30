/**
 * P9 MonitoringHealth — derived fail-closed view-model over AppSync + listener mirrors.
 * NO FALSE HEALTHY STATE. Prefer derivation over a second mutable source of truth.
 */

import type { AppSyncIssue } from './appSyncService';

/** Diagnostic difference shape (mirrors dataService.MonitoringDifference; no import cycle). */
export interface MonitoringDifferenceView {
  collection: string;
  missingLocallyCount: number;
  missingCloudCount: number;
  contentMismatchCount: number;
  duplicateIdsCount: number;
  orphanCount?: number;
  warehouseBalanceDiff?: number;
  details: string;
}

export type MonitoringPhase =
  | 'UNAVAILABLE'
  | 'UNKNOWN'
  | 'NOT_READY'
  | 'OFFLINE'
  | 'PENDING'
  | 'DEGRADED'
  | 'ACTION_REQUIRED'
  | 'ERROR'
  | 'HEALTHY';

export interface MonitoringOutboxCounts {
  staging: number;
  pending: number;
  retrying: number;
  flushing: boolean;
  conflicts: number;
  blocked: number;
  quarantined: number;
}

export interface MonitoringReadySnapshot {
  expected: string[];
  ready: string[];
  missing: string[];
}

export interface MonitoringHealthErrors {
  /** Per-collection listener/reconcile/integrity errors (sticky until cleared per collection). */
  monitoringByCollection: Record<string, string>;
  /** Sticky write / enqueue / AppSync lastError channel — not wiped by AppSync null while monitoring errors remain. */
  writeOrEnqueue: string | null;
}

export interface MonitoringHealth {
  phase: MonitoringPhase;
  activeUserId: string | null;
  lifecycleGeneration: number;
  online: boolean;
  ready: MonitoringReadySnapshot;
  outbox: MonitoringOutboxCounts;
  errors: MonitoringHealthErrors;
  syncIssues: AppSyncIssue[];
  /** Diagnostic only — never sole HEALTHY authority under listeners. */
  differences: MonitoringDifferenceView[];
}

/** RBAC permission → collection for HEALTHY expected ready-set. `users` intentionally excluded. */
export const MONITORING_RBAC_COLLECTION_PERMISSIONS: ReadonlyArray<{
  collection: string;
  permission: string;
}> = [
  { collection: 'settings', permission: 'settings_view' },
  { collection: 'materials', permission: 'materials_view' },
  { collection: 'transactions', permission: 'transactions_view' },
  { collection: 'audit_logs', permission: 'audit_view' },
  { collection: 'generator_logs', permission: 'generator_log' },
] as const;

export function resolveExpectedMonitoringCollections(
  hasPermission: (permission: string) => boolean,
): string[] {
  return MONITORING_RBAC_COLLECTION_PERMISSIONS
    .filter(entry => hasPermission(entry.permission))
    .map(entry => entry.collection);
}

export interface MonitoringHealthInput {
  cloudSyncEnabled: boolean;
  firebaseAvailable: boolean;
  online: boolean;
  authUserId: string | null;
  domainUserId: string | null;
  activeUserId: string | null;
  lifecycleGeneration: number;
  /** True when full cloud listener session is owned (initCloudSync). Delivery-only must stay false. */
  listenersSessionActive: boolean;
  expectedCollections: string[];
  readyCollections: readonly string[];
  outbox: MonitoringOutboxCounts;
  monitoringErrors: Record<string, string>;
  writeOrEnqueueError: string | null;
  syncIssues: readonly AppSyncIssue[];
  differences?: readonly MonitoringDifferenceView[];
}

const hasActionRequiredOutbox = (outbox: MonitoringOutboxCounts): boolean =>
  outbox.conflicts > 0 || outbox.blocked > 0 || outbox.quarantined > 0;

const hasPendingOutbox = (outbox: MonitoringOutboxCounts): boolean =>
  outbox.staging > 0 || outbox.pending > 0 || outbox.retrying > 0 || outbox.flushing;

const hasMeaningfulDifferences = (
  differences: readonly MonitoringDifferenceView[] | undefined,
): boolean =>
  !!differences?.some(d =>
    d.missingLocallyCount > 0
    || d.missingCloudCount > 0
    || d.contentMismatchCount > 0
    || d.duplicateIdsCount > 0
    || (d.orphanCount ?? 0) > 0
    || (d.warehouseBalanceDiff ?? 0) > 0);

/**
 * Session binding required for HEALTHY (and for trusting ready/outbox as current-user).
 * Fail-closed: auth + domain + AppSync activeUserId must all agree.
 */
export function isMonitoringSessionBound(input: Pick<
  MonitoringHealthInput,
  'activeUserId' | 'authUserId' | 'domainUserId'
>): boolean {
  const { activeUserId, authUserId, domainUserId } = input;
  return !!activeUserId
    && !!authUserId
    && !!domainUserId
    && activeUserId === authUserId
    && activeUserId === domainUserId;
}

export function deriveMonitoringHealth(input: MonitoringHealthInput): MonitoringHealth {
  const readyList = [...input.readyCollections];
  const expected = [...input.expectedCollections];
  const missing = expected.filter(collection => !readyList.includes(collection));
  const monitoringByCollection = { ...input.monitoringErrors };
  const syncIssues = [...input.syncIssues];
  const differences = input.differences ? [...input.differences] : [];
  const outbox = { ...input.outbox };
  const bound = isMonitoringSessionBound(input);
  const hasMonitoringErrors = Object.keys(monitoringByCollection).length > 0;
  const hasStickyWriteError = !!input.writeOrEnqueueError;
  const actionRequired =
    hasActionRequiredOutbox(outbox) || syncIssues.length > 0;
  const pending = hasPendingOutbox(outbox);
  // Fail-closed: empty expected is NOT vacuously ready (zero RBAC / never-monitored ≠ HEALTHY).
  const allExpectedReady = expected.length > 0 && missing.length === 0;

  const base: Omit<MonitoringHealth, 'phase'> = {
    activeUserId: input.activeUserId,
    lifecycleGeneration: input.lifecycleGeneration,
    online: input.online,
    ready: { expected, ready: readyList, missing },
    outbox,
    errors: {
      monitoringByCollection,
      writeOrEnqueue: input.writeOrEnqueueError,
    },
    syncIssues,
    differences,
  };

  // --- Phase precedence (fail-closed; HEALTHY only via full conjunction) ---

  if (!input.cloudSyncEnabled || !input.firebaseAvailable) {
    return { ...base, phase: 'UNAVAILABLE' };
  }

  // No bound session / no AppSync user yet → UNKNOWN (never HEALTHY).
  if (!bound || !input.activeUserId) {
    return { ...base, phase: 'UNKNOWN' };
  }

  // Offline never HEALTHY when cloud sync is enabled.
  if (!input.online) {
    return { ...base, phase: 'OFFLINE' };
  }

  // Errors (listener/reconcile/integrity + sticky write/enqueue) — never HEALTHY.
  if (hasMonitoringErrors || hasStickyWriteError) {
    return { ...base, phase: 'ERROR' };
  }

  // Conflicts / blocked / quarantined / syncIssues — ACTION_REQUIRED (quarantined stays here).
  if (actionRequired) {
    return { ...base, phase: 'ACTION_REQUIRED' };
  }

  // In-flight delivery work.
  if (pending) {
    return { ...base, phase: 'PENDING' };
  }

  // Delivery-only AppSync (no listener session) must not claim full monitoring HEALTHY/ready.
  if (!input.listenersSessionActive) {
    return { ...base, phase: 'NOT_READY' };
  }

  // Expected RBAC collections not all authoritatively ready.
  // Also: session active but expected empty → NOT_READY (never vacuous HEALTHY).
  if (!allExpectedReady) {
    return { ...base, phase: 'NOT_READY' };
  }

  // Monitoring-only divergence diagnostics (not authority under listeners, but never HEALTHY).
  if (hasMeaningfulDifferences(differences)) {
    return { ...base, phase: 'DEGRADED' };
  }

  // HEALTHY conjunction (Contract Gate) — all must already be true by reaching here:
  // 1. cloudSyncEnabled ∧ firebase ∧ session bound
  // 2. online
  // 3. expectedCollections.length > 0 ∧ every RBAC-expected ∈ ready (users excluded)
  // 4. outbox staging+pending+retrying+conflicts+blocked+quarantined === 0 ∧ !flushing
  // 5. no monitoringErrors ∧ no sticky write/enqueue
  // 6. syncIssues empty
  // + listeners session active (full monitoring, not delivery-only)
  return { ...base, phase: 'HEALTHY' };
}

/** Arabic UX labels for MonitoringHealth.phase — never map CLOUD_MONITORING_ENABLED alone to healthy. */
export function monitoringPhaseArabicLabel(phase: MonitoringPhase): string {
  switch (phase) {
    case 'UNAVAILABLE':
      return 'محلي فقط';
    case 'UNKNOWN':
      return 'جاري تهيئة المراقبة';
    case 'NOT_READY':
      return 'المراقبة غير جاهزة';
    case 'OFFLINE':
      return 'محلي فقط (غير متصل)';
    case 'PENDING':
      return 'مزامنة معلّقة';
    case 'DEGRADED':
      return 'مراقبة متدهورة';
    case 'ACTION_REQUIRED':
      return 'يلزم إجراء يدوي';
    case 'ERROR':
      return 'خطأ مزامنة';
    case 'HEALTHY':
      return 'المزامنة السحابية سليمة';
    default:
      return 'حالة مراقبة غير معروفة';
  }
}

export function monitoringPhaseColor(phase: MonitoringPhase): string {
  switch (phase) {
    case 'HEALTHY':
      return '#10b981';
    case 'PENDING':
      return '#f59e0b';
    case 'DEGRADED':
      return '#f59e0b';
    case 'ACTION_REQUIRED':
      return '#ef4444';
    case 'ERROR':
      return '#ef4444';
    case 'OFFLINE':
      return '#94a3b8';
    case 'NOT_READY':
      return '#6366f1';
    case 'UNKNOWN':
      return '#6366f1';
    case 'UNAVAILABLE':
      return '#94a3b8';
    default:
      return '#94a3b8';
  }
}

/**
 * Pending-writes UX count: staging+pending+retrying only.
 * Do NOT fold conflicts/blocked/quarantined into “pending writes”.
 */
export function pendingDeliveryCount(outbox: MonitoringOutboxCounts): number {
  return outbox.staging + outbox.pending + outbox.retrying;
}

export function actionRequiredCount(outbox: MonitoringOutboxCounts): number {
  return outbox.conflicts + outbox.blocked + outbox.quarantined;
}
