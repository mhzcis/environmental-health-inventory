import { classifyError, type DiagnosticCategory } from './operationalDiagnostics';

/**
 * P12 RW2-02 (USER Option A) — application-scoped, UNATTRIBUTED global runtime alert.
 *
 * window `error` / `unhandledrejection` events carry no reliable creation-session provenance, so
 * they are NEVER attributed to the current session: this channel has no ownerKey, no sequence,
 * no ack inheritance, never enters the session diagnostics buffer and never touches
 * the MonitoringHealth derivation. It holds at most one allowlisted record (category + safe code) in process
 * memory only — no Firestore, IndexedDB, Web Storage or network I/O. It is cleared on every auth
 * transition; clearing does NOT imply that later events belong to the new session.
 */

export const UNATTRIBUTED_ALERT_MESSAGE =
  'تم رصد خطأ عام في التطبيق لا يمكن نسبه بشكل موثوق إلى الجلسة الحالية.';

export interface UnattributedRuntimeAlert {
  readonly category: DiagnosticCategory;
  readonly code: string;
  readonly message: string;
}

type Listener = () => void;
let current: UnattributedRuntimeAlert | null = null;
const listeners = new Set<Listener>();
let notifying = false;

const publish = (): void => {
  if (notifying) return;
  notifying = true;
  try {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* UI failure must never escape */ }
    }
  } finally {
    notifying = false;
  }
};

/** Never throws. Only a known code and a category are kept; the error itself is discarded. */
export function raiseUnattributedRuntimeAlert(error: unknown, fallbackCategory: DiagnosticCategory): boolean {
  try {
    const { category, code } = classifyError(error, fallbackCategory);
    current = Object.freeze({ category, code, message: UNATTRIBUTED_ALERT_MESSAGE });
    publish();
    return true;
  } catch {
    return false;
  }
}

export function getUnattributedRuntimeAlert(): UnattributedRuntimeAlert | null {
  return current;
}

/** Called on logout, user switch, same-UID new generation and auth termination. Never throws. */
export function clearUnattributedRuntimeAlert(): void {
  try {
    if (current === null) return;
    current = null;
    publish();
  } catch { /* ignore */ }
}

export function subscribeUnattributedRuntimeAlert(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** @internal test seam */
export function __resetUnattributedRuntimeAlertForTests(): void {
  current = null;
  listeners.clear();
  notifying = false;
}
