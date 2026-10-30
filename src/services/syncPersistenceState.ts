/**
 * PREPROD rework #6 (m-RT-08): the sync error banner must not claim "saved locally" when the failed write was NOT persisted.
 * `persisted`          a durable local record (domain journal / IndexedDB outbox / staging handoff) exists; only cloud delivery failed.
 * `not-persisted`      the local write was rejected and rolled back (IndexedDB/localStorage quota, enqueue refused): nothing was saved.
 * `recovery-required`  persistence is ambiguous (cleanup/rollback failed): recovery decides, nothing may be claimed.
 * `unknown`            no persisted-state evidence for this error: nothing may be claimed.
 * Pure (no I/O); the text is fixed Arabic, never derived from the error.
 */
export type SyncErrorPersistence = 'persisted' | 'not-persisted' | 'recovery-required' | 'unknown';

export interface SyncErrorCandidate {
  error: string;
  persistence: SyncErrorPersistence | null | undefined;
}

const PERSISTENCE_SEVERITY: Readonly<Record<SyncErrorPersistence, number>> = {
  persisted: 0,
  unknown: 1,
  'not-persisted': 2,
  'recovery-required': 3,
};

const normalizePersistence = (state: SyncErrorPersistence | null | undefined): SyncErrorPersistence =>
  state && Object.prototype.hasOwnProperty.call(PERSISTENCE_SEVERITY, state) ? state : 'unknown';

/**
 * R2-PP-41: when several enqueue/staging failures coexist, never let an older durable
 * failure make a newer/less-safe failure look persisted. Select the least-safe state;
 * for equal severity the later candidate wins (callers append the current enqueue error last).
 */
export const selectLeastSafeSyncError = (candidates: readonly SyncErrorCandidate[]): { error: string; persistence: SyncErrorPersistence } | null => {
  let selected: { error: string; persistence: SyncErrorPersistence } | null = null;
  let selectedSeverity = -1;
  for (const candidate of candidates) {
    if (!candidate.error) continue;
    const persistence = normalizePersistence(candidate.persistence);
    const severity = PERSISTENCE_SEVERITY[persistence];
    if (severity >= selectedSeverity) {
      selected = { error: candidate.error, persistence };
      selectedSeverity = severity;
    }
  }
  return selected;
};

const QUOTA_NAMES = new Set(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']);

/** Storage-full style failures are, by construction, writes that did not land. */
export const isStorageQuotaError = (error: unknown): boolean => {
  try {
    if (typeof error === 'string') return error.includes('OFFLINE_DOMAIN_QUOTA_EXCEEDED');
    if (!error || typeof error !== 'object') return false;
    const { name, message } = error as { name?: unknown; message?: unknown };
    return (typeof name === 'string' && QUOTA_NAMES.has(name))
      || (typeof message === 'string' && message.includes('OFFLINE_DOMAIN_QUOTA_EXCEEDED'));
  } catch {
    return false;
  }
};

export const SYNC_ERROR_SAVED_NOTICE: Readonly<Record<SyncErrorPersistence, string>> = {
  persisted: 'التغييرات محفوظة محلياً بأمان، يرجى التحقق من الشبكة أو الصلاحيات.',
  'not-persisted': 'لم يتم حفظ آخر تغيير على هذا الجهاز. تحقق من مساحة التخزين ثم أعد المحاولة.',
  'recovery-required': 'حالة حفظ آخر تغيير غير مؤكدة وتحتاج إلى استرداد. لا تُغلق التطبيق وراجع مدير النظام.',
  unknown: 'حالة حفظ آخر تغيير غير مؤكدة. تحقق من الشبكة أو الصلاحيات وراجع آخر عملية قبل المتابعة.',
};

export const syncErrorSavedNotice = (state: SyncErrorPersistence | null | undefined): string =>
  SYNC_ERROR_SAVED_NOTICE[typeof state === 'string' && Object.prototype.hasOwnProperty.call(SYNC_ERROR_SAVED_NOTICE, state) ? state : 'unknown'];
