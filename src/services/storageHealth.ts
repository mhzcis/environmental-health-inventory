/**
 * PREPROD-D — browser storage-quota health (read-only, throttled, in-memory).
 *
 * The app keeps durable offline work (sync queue, mutation journals, domain snapshot) in IndexedDB/localStorage. When the
 * origin quota is nearly exhausted, writes start failing (OFFLINE_DOMAIN_QUOTA_EXCEEDED). This module only OBSERVES:
 *   - reads `navigator.storage.estimate()` and nothing else (no `persist()`, no clearing, no deletion, no writes anywhere);
 *   - is throttled (no timers/polling; callers refresh on mount / when the tab becomes visible, and a minimum interval applies);
 *   - keeps its snapshot in memory only (never persisted/audited/exported) and is not an Auth authority.
 *
 * States: UNSUPPORTED (no estimate API) · UNKNOWN (estimate failed/invalid) · HEALTHY · WARNING · CRITICAL.
 *
 * Documented thresholds (usage / quota):
 *   - WARNING  at ≥ 70 %, or ≥ 50 % while durable outstanding sync work exists (the queue still needs headroom),
 *              or less than 50 MiB remaining;
 *   - CRITICAL at ≥ 90 %, or ≥ 85 % while durable outstanding sync work exists, or less than 10 MiB remaining.
 * Absolute-headroom rules apply only when the browser reports a quota; a nonsensical estimate is UNKNOWN.
 */
export type StorageHealthState = 'UNSUPPORTED' | 'UNKNOWN' | 'HEALTHY' | 'WARNING' | 'CRITICAL';

export const STORAGE_WARNING_RATIO = 0.7;
export const STORAGE_CRITICAL_RATIO = 0.9;
export const STORAGE_WARNING_RATIO_WITH_OUTSTANDING_WORK = 0.5;
export const STORAGE_CRITICAL_RATIO_WITH_OUTSTANDING_WORK = 0.85;
export const STORAGE_WARNING_FREE_BYTES = 50 * 1024 * 1024;
export const STORAGE_CRITICAL_FREE_BYTES = 10 * 1024 * 1024;
export const STORAGE_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const STORAGE_FORCED_REFRESH_MIN_INTERVAL_MS = 15 * 1000;

export interface StorageHealthInput {
  supported: boolean;
  usageBytes: unknown;
  quotaBytes: unknown;
  /** Count of durable outstanding sync work; null/undefined = unknown (base thresholds apply). */
  outstandingWork?: number | null;
}

export interface StorageHealthSnapshot {
  readonly state: StorageHealthState;
  /** Whole-number percentage (0–100) of usage/quota, or null when not computable. */
  readonly usedPercent: number | null;
  readonly hasOutstandingWork: boolean;
}

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Pure classifier (no I/O). */
export function classifyStorageQuota(input: StorageHealthInput): StorageHealthSnapshot {
  const hasOutstandingWork = typeof input.outstandingWork === 'number' && Number.isFinite(input.outstandingWork) && input.outstandingWork > 0;
  if (!input.supported) return { state: 'UNSUPPORTED', usedPercent: null, hasOutstandingWork };
  const { usageBytes, quotaBytes } = input;
  if (!isFiniteNonNegative(usageBytes) || !isFiniteNonNegative(quotaBytes) || quotaBytes <= 0) {
    return { state: 'UNKNOWN', usedPercent: null, hasOutstandingWork };
  }
  const ratio = usageBytes / quotaBytes;
  const free = quotaBytes - usageBytes;
  const usedPercent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const warnRatio = hasOutstandingWork ? STORAGE_WARNING_RATIO_WITH_OUTSTANDING_WORK : STORAGE_WARNING_RATIO;
  const critRatio = hasOutstandingWork ? STORAGE_CRITICAL_RATIO_WITH_OUTSTANDING_WORK : STORAGE_CRITICAL_RATIO;
  if (ratio >= critRatio || free < STORAGE_CRITICAL_FREE_BYTES) return { state: 'CRITICAL', usedPercent, hasOutstandingWork };
  if (ratio >= warnRatio || free < STORAGE_WARNING_FREE_BYTES) return { state: 'WARNING', usedPercent, hasOutstandingWork };
  return { state: 'HEALTHY', usedPercent, hasOutstandingWork };
}

export interface StorageManagerLike {
  estimate?: () => Promise<{ usage?: unknown; quota?: unknown }>;
}

type Listener = () => void;
const listeners = new Set<Listener>();
const INITIAL: StorageHealthSnapshot = { state: 'UNKNOWN', usedPercent: null, hasOutstandingWork: false };
let snapshot: StorageHealthSnapshot = INITIAL;
let lastReadAt: number | null = null;
let lastForcedAt: number | null = null;
let inFlight: Promise<StorageHealthSnapshot> | null = null;

const publish = (next: StorageHealthSnapshot): void => {
  const changed = next.state !== snapshot.state || next.usedPercent !== snapshot.usedPercent || next.hasOutstandingWork !== snapshot.hasOutstandingWork;
  snapshot = next;
  if (!changed) return;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a throwing subscriber must not affect others */ }
  }
};

export const getStorageHealth = (): StorageHealthSnapshot => snapshot;
export const subscribeStorageHealth = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export interface RefreshOptions {
  storage: StorageManagerLike | undefined | null;
  /** Read-only provider of the durable outstanding-work count. A throwing/rejecting provider is treated as unknown. */
  getOutstandingWork?: () => Promise<number> | number;
  now?: () => number;
  /** User-initiated refresh: still bounded by STORAGE_FORCED_REFRESH_MIN_INTERVAL_MS. */
  force?: boolean;
}

/**
 * Throttled read. Concurrent calls share one in-flight read; within the minimum interval the cached snapshot is returned
 * without touching `estimate()`. Never throws.
 */
export function refreshStorageHealth(options: RefreshOptions): Promise<StorageHealthSnapshot> {
  const now = (options.now ?? Date.now)();
  if (inFlight) return inFlight;
  const interval = options.force ? STORAGE_FORCED_REFRESH_MIN_INTERVAL_MS : STORAGE_REFRESH_MIN_INTERVAL_MS;
  const reference = options.force ? lastForcedAt ?? lastReadAt : lastReadAt;
  if (reference !== null && now - reference >= 0 && now - reference < interval) return Promise.resolve(snapshot);
  lastReadAt = now;
  if (options.force) lastForcedAt = now;
  inFlight = (async (): Promise<StorageHealthSnapshot> => {
    try {
      let outstandingWork: number | null = null;
      if (options.getOutstandingWork) {
        try {
          const value = await options.getOutstandingWork();
          outstandingWork = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
        } catch {
          outstandingWork = null;
        }
      }
      const estimate = options.storage?.estimate;
      if (typeof estimate !== 'function') {
        publish(classifyStorageQuota({ supported: false, usageBytes: null, quotaBytes: null, outstandingWork }));
        return snapshot;
      }
      try {
        // The ONLY storage call: a read-only estimate. `this` must stay the StorageManager.
        const result = await estimate.call(options.storage);
        publish(classifyStorageQuota({ supported: true, usageBytes: result?.usage, quotaBytes: result?.quota, outstandingWork }));
      } catch {
        publish(classifyStorageQuota({ supported: true, usageBytes: null, quotaBytes: null, outstandingWork }));
      }
      return snapshot;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test-only reset. */
export function __resetStorageHealthForTests(): void {
  listeners.clear();
  snapshot = INITIAL;
  lastReadAt = null;
  lastForcedAt = null;
  inFlight = null;
}
