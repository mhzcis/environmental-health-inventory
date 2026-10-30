import type { DiagnosticCategory } from './operationalDiagnostics';
import { raiseUnattributedRuntimeAlert } from './unattributedRuntimeAlert';

/**
 * P12 G-1 — route-and-suppress for the global Firestore/permission failures that main.tsx has
 * always suppressed with preventDefault(). The match predicate is unchanged; the change is that a
 * matched failure now raises the application-scoped UNATTRIBUTED runtime alert (RW2-02, never the
 * current session's diagnostics or health) instead of disappearing. Unmatched errors are left completely untouched (no preventDefault, no
 * diagnostic) so arbitrary runtime errors do not become health incidents.
 */

const PERMISSION_TEXT = 'Missing or insufficient permissions';

const safeIncludes = (value: unknown, needle: string): boolean => {
  try {
    return typeof value === 'string' && value.includes(needle);
  } catch {
    return false;
  }
};

const safeString = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return '';
  }
};

const messageOf = (value: unknown): unknown => {
  try {
    return value && typeof value === 'object' ? (value as { message?: unknown }).message : undefined;
  } catch {
    return undefined;
  }
};

/** Same predicate as pre-P12 main.tsx for unhandledrejection. */
export function matchSuppressedRejection(reason: unknown): DiagnosticCategory | null {
  if (!reason) return null;
  if (safeIncludes(messageOf(reason), 'Firestore Error')) return 'INTERNAL';
  if (safeIncludes(safeString(reason), PERMISSION_TEXT)) return 'AUTHORIZATION';
  return null;
}

/** Same predicate as pre-P12 main.tsx for window `error`. */
export function matchSuppressedErrorEvent(error: unknown, message: unknown): DiagnosticCategory | null {
  if (!error) return null;
  if (safeIncludes(messageOf(error), 'Firestore Error')) return 'INTERNAL';
  if (safeIncludes(message, PERMISSION_TEXT)) return 'AUTHORIZATION';
  return null;
}

const recordSafely = (error: unknown, phase: string, fallbackCategory: DiagnosticCategory): void => {
  try {
    // RW2-02: global events have no reliable session provenance → unattributed channel only.
    void phase;
    raiseUnattributedRuntimeAlert(error, fallbackCategory);
  } catch {
    /* observability failure must never change the original handling */
  }
};

export function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  const category = matchSuppressedRejection(event.reason);
  if (!category) return;
  event.preventDefault(); // unchanged: prevent crashing the page / full-screen overlays
  recordSafely(event.reason, 'unhandled-rejection', category);
}

export function handleGlobalError(event: ErrorEvent): void {
  const category = matchSuppressedErrorEvent(event.error, event.message);
  if (!category) return;
  event.preventDefault(); // unchanged
  recordSafely(event.error, 'uncaught-error', category);
}

let installed = false;

/** Installs the handlers once per window. */
export function installGlobalErrorRouting(target: Window): void {
  if (installed) return;
  installed = true;
  target.addEventListener('unhandledrejection', handleUnhandledRejection);
  target.addEventListener('error', handleGlobalError);
}
