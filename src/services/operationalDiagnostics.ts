/**
 * P12 — bounded, process-memory-only operational diagnostics (D-2 privacy contract).
 *
 * - At most DIAGNOSTIC_BUFFER_LIMIT records; the oldest is evicted deterministically.
 * - Records are built from an allowlisted, structured shape BEFORE insertion. Raw error objects,
 *   Error.message, stacks, payloads and server responses are never stored.
 * - Owned by exactly one auth session key (uid + Firebase auth-session generation, supplied by the
 *   existing App/dataService lifecycle). Any owner change, logout or termination clears it.
 * - No Firestore, IndexedDB, Web Storage, Service Worker, network, timers or external services.
 * - Never throws into a caller: every public entry point contains its own failures.
 */

export const DIAGNOSTIC_BUFFER_LIMIT = 100;

export type DiagnosticCategory =
  | 'NETWORK'
  | 'QUOTA'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'FIRESTORE_LISTENER'
  | 'RENDER'
  | 'INTERNAL';

export type DiagnosticSeverity = 'error' | 'warning';
export type DiagnosticSource = 'global-handler' | 'error-boundary' | 'cloud-listener-startup';

export interface DiagnosticEvent {
  readonly seq: number;
  readonly timestamp: string;
  readonly severity: DiagnosticSeverity;
  readonly source: DiagnosticSource;
  readonly category: DiagnosticCategory;
  /** Allowlisted stable code only (e.g. Firestore `permission-denied`), otherwise `unknown`. */
  readonly code: string;
  readonly retryable: boolean;
  readonly phase: string;
  readonly hint: string;
}

export interface DiagnosticInput {
  source: DiagnosticSource;
  phase: string;
  error: unknown;
  severity?: DiagnosticSeverity;
  /** Category for failures whose code alone does not identify the channel (e.g. render). */
  fallbackCategory?: DiagnosticCategory;
}

/** Firestore/Firebase error codes (gRPC canonical) we map; anything else stays `unknown`. */
const KNOWN_CODES: Readonly<Record<string, { category: DiagnosticCategory; retryable: boolean }>> = {
  'permission-denied': { category: 'AUTHORIZATION', retryable: false },
  unauthenticated: { category: 'AUTHENTICATION', retryable: false },
  unavailable: { category: 'NETWORK', retryable: true },
  'deadline-exceeded': { category: 'NETWORK', retryable: true },
  'resource-exhausted': { category: 'QUOTA', retryable: false },
  cancelled: { category: 'INTERNAL', retryable: false },
  'failed-precondition': { category: 'INTERNAL', retryable: false },
  'not-found': { category: 'INTERNAL', retryable: false },
  aborted: { category: 'INTERNAL', retryable: false },
  internal: { category: 'INTERNAL', retryable: false },
  'invalid-argument': { category: 'INTERNAL', retryable: false },
  'out-of-range': { category: 'INTERNAL', retryable: false },
  unimplemented: { category: 'INTERNAL', retryable: false },
  'already-exists': { category: 'INTERNAL', retryable: false },
  'data-loss': { category: 'INTERNAL', retryable: false },
  unknown: { category: 'INTERNAL', retryable: false },
};

const SOURCE_SET: ReadonlySet<string> = new Set<DiagnosticSource>([
  'global-handler', 'error-boundary', 'cloud-listener-startup',
]);
const CATEGORY_SET: ReadonlySet<string> = new Set<DiagnosticCategory>([
  'NETWORK', 'QUOTA', 'AUTHENTICATION', 'AUTHORIZATION', 'FIRESTORE_LISTENER', 'RENDER', 'INTERNAL',
]);
const SAFE_PHASE = /^[a-z][a-z0-9-]{0,39}$/;

const HINTS: Readonly<Record<DiagnosticCategory, string>> = {
  NETWORK: 'تعذر الاتصال بالخدمة مؤقتاً. تحقق من الاتصال وأعد المحاولة لاحقاً.',
  QUOTA: 'تم بلوغ حد الاستخدام أو الموارد المتاحة. انتظر حتى تتجدد الحصة أو راجع مسؤول النظام.',
  AUTHENTICATION: 'انتهت صلاحية الجلسة أو تعذر التحقق منها. سجّل الدخول من جديد.',
  AUTHORIZATION: 'تم رفض العملية لعدم توفر الصلاحية. راجع مدير النظام.',
  FIRESTORE_LISTENER: 'تعذر تهيئة المزامنة السحابية. أعد تحميل الصفحة أو أعد تسجيل الدخول.',
  RENDER: 'تعذر عرض هذه الشاشة. أعد تحميل الصفحة.',
  INTERNAL: 'حدث خطأ داخلي غير متوقع. أعد المحاولة أو راجع مدير النظام.',
};

/** Reads only a string `code` property and accepts it only if it is a known Firebase code. */
export function extractSafeErrorCode(error: unknown): string {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return 'unknown';
    const raw = (error as { code?: unknown }).code;
    if (typeof raw !== 'string') return 'unknown';
    const code = raw.startsWith('firestore/') ? raw.slice('firestore/'.length) : raw;
    return Object.prototype.hasOwnProperty.call(KNOWN_CODES, code) ? code : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function classifyError(
  error: unknown,
  fallbackCategory: DiagnosticCategory = 'INTERNAL',
): { category: DiagnosticCategory; code: string; retryable: boolean } {
  const code = extractSafeErrorCode(error);
  const known = code !== 'unknown' ? KNOWN_CODES[code] : undefined;
  if (known) return { category: known.category, code, retryable: known.retryable };
  return { category: CATEGORY_SET.has(fallbackCategory) ? fallbackCategory : 'INTERNAL', code: 'unknown', retryable: false };
}

/** Arabic recovery hint for a category — fixed application text, never derived from error input. */
export function safeHintFor(category: DiagnosticCategory): string {
  return HINTS[category] ?? HINTS.INTERNAL;
}

/** Builds the allowlisted record. Nothing from the error except a known code is copied. */
export function buildDiagnosticEvent(input: DiagnosticInput, seq: number, now: Date): DiagnosticEvent {
  const source: DiagnosticSource = SOURCE_SET.has(input.source) ? input.source : 'global-handler';
  const phase = typeof input.phase === 'string' && SAFE_PHASE.test(input.phase) ? input.phase : 'unspecified';
  const { category, code, retryable } = classifyError(input.error, input.fallbackCategory);
  return Object.freeze({
    seq,
    timestamp: now.toISOString(),
    severity: input.severity === 'warning' ? 'warning' : 'error',
    source,
    category,
    code,
    retryable,
    phase,
    hint: safeHintFor(category),
  });
}

type Listener = () => void;

let ownerKey: string | null = null;
let records: DiagnosticEvent[] = [];
let nextSeq = 1;
let acknowledgedSeq = 0;
let snapshot: readonly DiagnosticEvent[] = Object.freeze([]);
const listeners = new Set<Listener>();
let notifying = false;

const publish = (): void => {
  snapshot = Object.freeze(records.slice());
  if (notifying) return; // a listener that records again cannot recurse
  notifying = true;
  try {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* diagnostics UI failure must never escape */ }
    }
  } finally {
    notifying = false;
  }
};

/** Append one sanitized record for the current owner. Never throws; returns false on failure. */
export function recordDiagnostic(input: DiagnosticInput): boolean {
  try {
    const event = buildDiagnosticEvent(input, nextSeq, new Date());
    nextSeq += 1;
    records.push(event);
    if (records.length > DIAGNOSTIC_BUFFER_LIMIT) records.splice(0, records.length - DIAGNOSTIC_BUFFER_LIMIT);
    publish();
    return true;
  } catch {
    return false;
  }
}

/** Current-session, already-sanitized copy (immutable). */
export function getDiagnosticsSnapshot(): readonly DiagnosticEvent[] {
  return snapshot;
}

export function clearDiagnostics(): void {
  try {
    const hadState = records.length > 0 || acknowledgedSeq !== 0;
    records = [];
    acknowledgedSeq = 0;
    if (hadState) publish();
    else snapshot = Object.freeze([]);
  } catch { /* never throw into teardown */ }
}

/**
 * Binds the buffer to the canonical auth session key (uid + auth-session generation) supplied by
 * the existing lifecycle. A different key (user switch, same-UID new session, sign-out → null)
 * clears every prior record before the new owner can read anything.
 */
export function bindDiagnosticsSession(nextOwnerKey: string | null): void {
  try {
    if (nextOwnerKey === ownerKey) return;
    // RW2-03: atomic transition — every owner-visible field is reset BEFORE any subscriber runs,
    // so a re-entrant subscriber can only ever observe (and append to) the new session's state.
    ownerKey = nextOwnerKey;
    records = [];
    nextSeq = 1;
    acknowledgedSeq = 0;
    snapshot = Object.freeze([]);
    publish();
  } catch { /* never throw into auth lifecycle */ }
}

export function getDiagnosticsOwnerKey(): string | null {
  return ownerKey;
}

/** Latest unacknowledged error-severity record, for the narrow health alert. */
export function getActiveOperationalAlert(): DiagnosticEvent | null {
  for (let i = snapshot.length - 1; i >= 0; i -= 1) {
    const event = snapshot[i];
    if (event.seq <= acknowledgedSeq) return null;
    if (event.severity === 'error') return event;
  }
  return null;
}

/** Hides the alert up to `seq`; records stay in the buffer. Business state is untouched. */
export function acknowledgeOperationalAlert(seq: number): void {
  try {
    if (Number.isFinite(seq) && seq > acknowledgedSeq) {
      acknowledgedSeq = seq;
      publish();
    }
  } catch { /* ignore */ }
}

export function subscribeDiagnostics(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** @internal test seam */
export function __resetOperationalDiagnosticsForTests(): void {
  ownerKey = null;
  records = [];
  nextSeq = 1;
  acknowledgedSeq = 0;
  snapshot = Object.freeze([]);
  listeners.clear();
  notifying = false;
}
