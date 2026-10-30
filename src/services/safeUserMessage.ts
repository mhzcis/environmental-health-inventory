/**
 * PREPROD-B — canonical user-facing error sanitizer (G-5 / OBS-B).
 *
 * `safeUserMessage(error, context)` turns ANY thrown value (Error, SDK error, string, response-like
 * object, nothing) into stable Arabic application text. It is pure: no I/O, no storage, no logging.
 *
 * Contract (what may reach a rendered surface):
 *  - fixed Arabic text selected by an ALLOWLISTED code or category only;
 *  - never the raw `message`, `stack`, server response body, payload, token, secret, e-mail, UID,
 *    document path or any other free text taken from the error;
 *  - an unknown / unparseable / hostile input yields the context's generic fallback, never an exception.
 *
 * Code sources (each is looked up in a closed table; free text is never copied):
 *  1. `error.code` that is a known Firestore/gRPC code (reuses operationalDiagnostics.classifyError);
 *  2. `error.code` that is a known Firebase Auth code (`auth/...`);
 *  3. a numeric `error.httpStatus` / `error.status` (HTTP class → fixed text);
 *  4. a leading application domain code in the message (`CODE` or `CODE:detail`), accepted only when its
 *     prefix is in DOMAIN_RULES; everything after the first `:` is discarded
 *     (`SYNC_FIRESTORE_PERMANENT:<firestore-code>:<raw text>` keeps only the allowlisted inner code);
 *  5. optional (`allowAppText`, default false) bounded Arabic-only application text thrown by this app's own
 *     validators: passes only if it has no Latin letters, 6+ digit runs, '@', '/', '\\', ':' or URL characters, so no
 *     e-mail, UID, token, path or English SDK text can ride through.
 *
 * Raw errors may still be written to the developer console by callers; they must never be rendered,
 * stored in diagnostics/audit/exports, or put into a report field (use `safeErrorDetail` for those).
 */
import { classifyError, safeHintFor, type DiagnosticCategory } from './operationalDiagnostics';

export type SafeMessageContext =
  | 'generic'
  | 'sync'
  | 'monitoring'
  | 'backup'
  | 'restore'
  | 'drive'
  | 'export'
  | 'import'
  | 'user-management'
  | 'diagnostics'
  | 'reset';

export interface SafeMessageOptions {
  /** Allow bounded Arabic-only text authored by this application's own validators (see header). */
  allowAppText?: boolean;
  /** Fixed application text used instead of the context default when the error is unknown (never derived from the error). */
  fallback?: string;
}

const CONTEXT_PREFIX: Readonly<Record<SafeMessageContext, string>> = {
  generic: 'تعذر إكمال العملية.',
  sync: 'تعذرت المزامنة السحابية.',
  monitoring: 'تعذر فحص حالة المزامنة.',
  backup: 'تعذر إكمال عملية النسخ الاحتياطي.',
  restore: 'تعذرت عملية الاستعادة.',
  drive: 'تعذر إكمال عملية Google Drive.',
  export: 'تعذر التصدير.',
  import: 'تعذر الاستيراد.',
  'user-management': 'تعذرت عملية إدارة الحساب.',
  diagnostics: 'تعذر تنفيذ الفحص.',
  reset: 'تعذرت عملية إعادة الضبط.',
};

const CONTEXT_FALLBACK_CATEGORY: Readonly<Record<SafeMessageContext, DiagnosticCategory>> = {
  generic: 'INTERNAL', sync: 'NETWORK', monitoring: 'INTERNAL', backup: 'INTERNAL', restore: 'INTERNAL',
  drive: 'NETWORK', export: 'INTERNAL', import: 'INTERNAL', 'user-management': 'INTERNAL', diagnostics: 'INTERNAL', reset: 'INTERNAL',
};

/** Fixed Arabic text per domain-code prefix. Longest matching prefix wins; first entry of a tie wins. */
const DOMAIN_RULES: ReadonlyArray<readonly [prefix: string, text: string]> = [
  ['OFFLINE_DOMAIN_QUOTA_EXCEEDED', 'مساحة التخزين المحلي في المتصفح ممتلئة. حرّر مساحة ثم أعد المحاولة، ولا تُحذف بيانات غير مزامنة.'],
  ['OFFLINE_DOMAIN_SESSION', 'تغيّرت الجلسة أو انتهت أثناء العملية. أعد تسجيل الدخول ثم أعد المحاولة.'],
  ['OFFLINE_DOMAIN_STALE_TAB', 'تم تحديث البيانات من نافذة أخرى. أعد تحميل الصفحة ثم أعد المحاولة.'],
  ['OFFLINE_DOMAIN_REVISION_CONFLICT', 'تم تحديث البيانات من نافذة أخرى. أعد تحميل الصفحة ثم أعد المحاولة.'],
  ['OFFLINE_DOMAIN_', 'تعذر الوصول إلى التخزين المحلي بأمان. أعد تحميل الصفحة؛ إن تكرر ذلك فراجع مدير النظام.'],
  ['INDEXEDDB_', 'تعذر الوصول إلى التخزين المحلي بأمان. أعد تحميل الصفحة؛ إن تكرر ذلك فراجع مدير النظام.'],
  ['SYNC_SESSION', 'تغيّرت الجلسة أو انتهت أثناء المزامنة. أعد تسجيل الدخول.'],
  ['SYNC_AUTH', 'تعذر التحقق من الجلسة للمزامنة. أعد تسجيل الدخول.'],
  ['SYNC_USER', 'تعذر التحقق من هوية المستخدم للمزامنة. أعد تسجيل الدخول.'],
  ['SYNC_CONFLICT', 'يوجد تعارض في المزامنة يحتاج قراراً صريحاً من المسؤول.'],
  ['SYNC_QUARANTINE', 'عملية مزامنة محجوزة وتحتاج فحصاً يدوياً من المسؤول.'],
  ['SYNC_LEGACY', 'عملية مزامنة قديمة تحتاج فحصاً يدوياً من المسؤول.'],
  ['SYNC_FIREBASE_UNAVAILABLE', 'خدمة المزامنة غير متاحة حالياً. ستبقى التغييرات محفوظة محلياً.'],
  ['SYNC_REMOTE_ACK_OFFLINE', 'لا يوجد اتصال لتأكيد المزامنة. ستبقى التغييرات محفوظة محلياً.'],
  // PREPROD rework #2 (R3-01): generic SYNC_* codes include pre-write validation failures and rolled-back paths, so this text makes NO claim
  // about local persistence (only the two connectivity codes above, where the change is already queued locally, say so).
  ['SYNC_', 'تعذرت المزامنة السحابية لهذه العملية ولم يتأكد حفظها في السحابة. راجع حالة العملية قبل إعادة المحاولة.'],
  ['MIGRATION_PRECHECK_FAILED', 'تعذر فحص قاعدة البيانات الهدف قبل الترحيل. لم تُكتب أي بيانات.'],
  ['MIGRATION_TARGET_NOT_EMPTY', 'قاعدة البيانات الهدف ليست فارغة. أوقف الترحيل للحفاظ على البيانات (راجع المجموعة المذكورة في التقرير).'],
  ['PROTECTED_ENQUEUE_REFUSED', 'رُفض حفظ التغيير لحماية سلامة البيانات.'],
  ['MANAGED_USER_', 'تعذرت عملية إدارة الحساب أو نتيجتها غير مؤكدة. راجع سجل مراجعة العمليات قبل إعادة المحاولة.'],
  ['SETTINGS_', 'تعذر حفظ الإعدادات لأن بياناتها غير صالحة أو غير متسقة.'],
  ['WAREHOUSE_', 'بيانات المخزن غير صالحة أو غير متسقة. راجع الاسم والمعرّف ثم أعد المحاولة.'],
  ['AUDIT_', 'تعذر تسجيل سجل التدقيق المطلوب، لذلك لم تُنفّذ العملية.'],
  ['AUTH_', 'تعذر التحقق من الجلسة. أعد تسجيل الدخول.'],
  ['LOGOUT_', 'تعذر إنهاء الجلسة بشكل مؤكد. أعد المحاولة.'],
  ['FIREBASE_AUTH_NOT_READY', 'خدمة الدخول غير جاهزة بعد. أعد المحاولة بعد لحظات.'],
  ['FIREBASE_UNAVAILABLE', 'الخدمة السحابية غير متاحة حالياً.'],
  ['NETWORK_UNAVAILABLE', 'لا يوجد اتصال بالشبكة حالياً. تحقق من الاتصال وأعد المحاولة.'],
  ['IDB_BLOCKED', 'تعذر الوصول إلى التخزين المحلي بأمان. أغلق النوافذ الأخرى للتطبيق ثم أعد المحاولة.'],
  // R2-PP-52: the durable reset of the previous session committed, then the session changed; the tail stopped
  // without touching the new session (no storage wipe, no reset banner, no reload).
  ['RESET_COMMITTED_SESSION_CHANGED', 'اكتملت إعادة الضبط المحلي للجلسة السابقة ثم تغيّرت الجلسة، فلم تُطبَّق أي خطوة إضافية على الجلسة الحالية. أعد تحميل الصفحة وتحقق من حالة الجلسة.'],
  ['RESET_COMMITTED_', 'اكتملت إعادة الضبط المحلي للبيانات الأساسية، لكن تعذر استكمال بعض خطوات التنظيف اللاحقة. أعد تحميل الصفحة للمتابعة.'],
  ['RESET_SESSION_CHANGED', 'تغيّرت الجلسة أثناء إعادة الضبط فلم تُنفّذ العملية. أعد تسجيل الدخول ثم أعد المحاولة.'],
  ['RESET_BLOCKED_OUTSTANDING_SYNC_WORK', 'لا يمكن إعادة الضبط لوجود تغييرات لم تُزامَن بعد. زامنها أولاً أو صدّر نسخة احتياطية، ولا تحذف بيانات المتصفح يدوياً.'],
  ['RESET_AUDIT_', 'تعذر تسجيل سجل التدقيق المركزي لإعادة الضبط، لذلك لم تُنفّذ العملية ولم تتغير أي بيانات. تحقق من الاتصال ثم أعد المحاولة.'],
  ['RESET_', 'تعذرت عملية إعادة الضبط ولم تُنفّذ. أعد تحميل الصفحة ثم أعد المحاولة، ولا تحذف بيانات المتصفح يدوياً.'],
  ['RESTORE_', 'تعذرت عملية الاستعادة أو تحتاج إلى مراجعة سجل الاسترداد قبل المتابعة.'],
  ['PERMISSION_DENIED', 'تم رفض العملية لعدم توفر الصلاحية. راجع مدير النظام.'],
  ['UNIQUE_CODE_COLLISION', 'الكود مستخدم مسبقاً. اختر كوداً آخر.'],
  ['DUPLICATE_DATE_EXISTS', 'يوجد سجل بالتاريخ نفسه مسبقاً.'],
  ['INVALID_SEQUENCE', 'تسلسل الترقيم غير صالح. راجع الإعدادات ثم أعد المحاولة.'],
  ['MATERIAL_ID_COLLISION', 'معرّف الصنف مستخدم مسبقاً.'],
  ['TRANSACTION_ID_COLLISION', 'معرّف الحركة مستخدم مسبقاً.'],
  ['RECORD_NOT_FOUND', 'السجل المطلوب غير موجود أو حُذف.'],
  ['PRODUCT_SCHEMA_REJECTED', 'بيانات المنتج غير صالحة.'],
  ['INVALID_USER_PROFILE', 'بيانات المستخدم غير صالحة.'],
  ['OPENING_MATERIAL_ID_MISMATCH', 'بيانات الرصيد الافتتاحي غير متسقة.'],
  ['TRANSFER_OPERATION_REQUIRED', 'بيانات التحويل غير مكتملة.'],
  ['ACTIVE_WAREHOUSE_REQUIRED_FOR_VOUCHER', 'يلزم تحديد مخزن نشط لهذا السند.'],
  ['LEGACY_USER_', 'تعذر التحقق من بيانات مستخدم قديمة. راجع مدير النظام.'],
];

const AUTH_RULES: Readonly<Record<string, string>> = {
  'auth/network-request-failed': 'تعذر الاتصال بخدمة الدخول. تحقق من الاتصال وأعد المحاولة.',
  'auth/popup-blocked': 'تم حظر النافذة المنبثقة. اسمح بالنوافذ المنبثقة لهذا الموقع ثم أعد المحاولة.',
  'auth/popup-closed-by-user': 'أُغلقت نافذة تسجيل الدخول قبل اكتمال العملية.',
  'auth/cancelled-popup-request': 'أُلغي طلب تسجيل الدخول السابق. أعد المحاولة.',
  'auth/too-many-requests': 'تم تجاوز عدد المحاولات المسموح به مؤقتاً. انتظر قليلاً ثم أعد المحاولة.',
  'auth/requires-recent-login': 'تتطلب هذه العملية تسجيل دخول حديثاً. أعد تسجيل الدخول ثم أعد المحاولة.',
  'auth/user-disabled': 'هذا الحساب معطّل. راجع مدير النظام.',
  'auth/user-token-expired': 'انتهت صلاحية الجلسة. سجّل الدخول من جديد.',
  'auth/invalid-credential': 'بيانات الدخول غير صحيحة.',
  'auth/wrong-password': 'بيانات الدخول غير صحيحة.',
  'auth/user-not-found': 'بيانات الدخول غير صحيحة.',
  'auth/invalid-email': 'صيغة البريد الإلكتروني غير صالحة.',
  'auth/operation-not-allowed': 'هذه العملية غير مفعّلة لهذا التطبيق. راجع مدير النظام.',
  'auth/unauthorized-domain': 'هذا النطاق غير مصرّح له بتسجيل الدخول. راجع مدير النظام.',
  'auth/internal-error': 'حدث خطأ داخلي في خدمة الدخول. أعد المحاولة لاحقاً.',
};

const PROTECTED_ENQUEUE_REASONS: ReadonlySet<string> = new Set([
  'NO_AUTH', 'SESSION_TERMINATED', 'INACTIVE_OR_MISSING_PROFILE', 'AUTH_UID_MISMATCH', 'PROFILE_REVOKED',
]);

const CODE_TOKEN = /^([A-Z][A-Z0-9_]{3,80})(?=$|[:\s])/;
const APP_TEXT_MAX = 300;
// m-RT-07 (PREPROD rework #6): allow-list instead of a Latin/ASCII block-list. Only Arabic-block characters (minus the bidi mark U+061C), ASCII digits, space/newline
// and a few neutral punctuation marks pass verbatim, so full-width e-mails (ＡＢＣ＠…), math-Latin, Cyrillic/Greek confusables, bidi/zero-width controls and any other
// script are rejected. Any run of 6+ Unicode decimal digits (ASCII or Arabic-Indic U+0660-0669 / U+06F0-06F9) is an identifier-like value and is rejected.
const APP_TEXT_ALLOWED = /^[\u0600-\u061B\u061D-\u06FF0-9 \n.,!()\-_*+;\u2014]+$/u;
const LONG_DIGIT_RUN = /\p{Nd}{6,}/u;
const ARABIC_LETTER = /[\u0600-\u06FF]/;

const own = (value: unknown, key: string): unknown => {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

const rawMessageOf = (error: unknown): string | null => {
  try {
    if (typeof error === 'string') return error;
    const message = own(error, 'message');
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
};

const domainRuleFor = (code: string): string | null => {
  let best: { length: number; text: string } | null = null;
  for (const [prefix, text] of DOMAIN_RULES) {
    if (code.startsWith(prefix) && (!best || prefix.length > best.length)) best = { length: prefix.length, text };
  }
  return best ? best.text : null;
};

interface Resolved {
  /** Stable token that may be stored in reports (never free text). */
  detail: string;
  text: string | null;
  category: DiagnosticCategory;
}

const authCodeOf = (error: unknown): string | null => {
  const code = own(error, 'code');
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(AUTH_RULES, code) ? code : null;
};

const httpStatusOf = (error: unknown): number | null => {
  for (const key of ['httpStatus', 'status']) {
    const value = own(error, key);
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return null;
};

const httpText = (status: number): { text: string; category: DiagnosticCategory } => {
  if (status === 401 || status === 403) return { text: 'رفضت الخدمة الطلب لعدم توفر صلاحية صالحة. أعد تسجيل الدخول أو راجع إعدادات الحساب.', category: 'AUTHORIZATION' };
  if (status === 404) return { text: 'لم يتم العثور على المورد المطلوب في الخدمة.', category: 'INTERNAL' };
  if (status === 408 || status === 504) return { text: 'انتهت مهلة الاتصال بالخدمة. أعد المحاولة لاحقاً.', category: 'NETWORK' };
  if (status === 429) return { text: 'تم تجاوز حد الاستخدام المسموح به مؤقتاً. انتظر قليلاً ثم أعد المحاولة.', category: 'QUOTA' };
  if (status >= 500) return { text: 'الخدمة غير متاحة مؤقتاً. أعد المحاولة لاحقاً.', category: 'NETWORK' };
  return { text: 'رفضت الخدمة الطلب. تحقق من البيانات ثم أعد المحاولة.', category: 'INTERNAL' };
};

const resolve = (error: unknown): Resolved => {
  // 1. Firestore / gRPC canonical code.
  const classified = classifyError(error);
  if (classified.code !== 'unknown') return { detail: classified.code, text: null, category: classified.category };
  // 2. Firebase Auth code.
  const authCode = authCodeOf(error);
  if (authCode) return { detail: authCode, text: AUTH_RULES[authCode], category: 'AUTHENTICATION' };
  // 3. HTTP status of a response-like error (the body is never read).
  const status = httpStatusOf(error);
  if (status !== null) {
    const mapped = httpText(status);
    return { detail: `http-${Math.floor(status / 100)}xx`, text: mapped.text, category: mapped.category };
  }
  // 4. Leading application domain code.
  const message = rawMessageOf(error);
  if (message !== null) {
    const match = CODE_TOKEN.exec(message.trimStart().slice(0, 200));
    if (match) {
      const code = match[1];
      if (code === 'SYNC_FIRESTORE_PERMANENT') {
        const inner = /^SYNC_FIRESTORE_PERMANENT:([a-z-]{3,30})(?=$|:)/.exec(message.trimStart().slice(0, 200));
        if (inner) {
          const innerClass = classifyError({ code: inner[1] });
          if (innerClass.code !== 'unknown') return { detail: `${code}:${innerClass.code}`, text: null, category: innerClass.category };
        }
      }
      const text = domainRuleFor(code);
      if (text && code === 'PROTECTED_ENQUEUE_REFUSED') {
        // Closed, code-defined reason set (p10AuthorityContract.ProtectedEnqueueBlockReason): the machine
        // reference is part of the managed-user result contract and carries no free text.
        const reason = /^PROTECTED_ENQUEUE_REFUSED:([A-Z_]{3,30})(?=$|[:\s])/.exec(message.trimStart().slice(0, 200));
        if (reason && PROTECTED_ENQUEUE_REASONS.has(reason[1])) {
          return { detail: `${code}:${reason[1]}`, text: `${text} (${code}:${reason[1]})`, category: 'INTERNAL' };
        }
      }
      if (text) return { detail: code, text, category: 'INTERNAL' };
    }
  }
  return { detail: 'unknown', text: null, category: 'INTERNAL' };
};

/** Arabic-only application text authored by this app's validators (opt-in; see header). */
const passesAppText = (error: unknown): string | null => {
  const message = rawMessageOf(error);
  if (message === null) return null;
  const text = message.trim();
  if (text.length === 0 || text.length > APP_TEXT_MAX) return null;
  if (!ARABIC_LETTER.test(text) || !APP_TEXT_ALLOWED.test(text) || LONG_DIGIT_RUN.test(text)) return null;
  return text;
};

/** Stable allowlisted token describing the error class — safe to store in reports/exports (never free text). */
export function safeErrorDetail(error: unknown): string {
  try {
    return resolve(error).detail;
  } catch {
    return 'unknown';
  }
}

/** Fixed Arabic text for a user-visible error. Never throws; never returns anything derived from free text. */
export function safeUserMessage(
  error: unknown,
  context: SafeMessageContext = 'generic',
  options: SafeMessageOptions = {},
): string {
  try {
    const ctx: SafeMessageContext = Object.prototype.hasOwnProperty.call(CONTEXT_PREFIX, context) ? context : 'generic';
    const resolved = resolve(error);
    if (resolved.text) return resolved.text;
    if (resolved.detail !== 'unknown') return `${CONTEXT_PREFIX[ctx]} ${safeHintFor(resolved.category)}`;
    if (options.allowAppText) {
      const appText = passesAppText(error);
      if (appText) return appText;
    }
    if (typeof options.fallback === 'string' && options.fallback.length > 0) return options.fallback;
    return `${CONTEXT_PREFIX[ctx]} ${safeHintFor(CONTEXT_FALLBACK_CATEGORY[ctx])}`;
  } catch {
    return `${CONTEXT_PREFIX.generic} ${safeHintFor('INTERNAL')}`;
  }
}

/** Sanitizes a record of per-key error strings (e.g. monitoring by collection) into de-duplicated safe text. */
export function safeUserMessages(values: Iterable<unknown>, context: SafeMessageContext, options?: SafeMessageOptions): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = safeUserMessage(value, context, options);
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * A message that is EXACTLY one allowlisted application code (optionally with a closed protected-enqueue
 * reason). Such a string carries no free text and is the machine-readable contract that service results
 * (managed-user, restore, …) expose to callers and tests.
 */
export function isBareAllowlistedCode(message: unknown): boolean {
  try {
    if (typeof message !== 'string') return false;
    const reason = /^PROTECTED_ENQUEUE_REFUSED:([A-Z_]{3,30})$/.exec(message);
    if (reason) return PROTECTED_ENQUEUE_REASONS.has(reason[1]);
    return /^[A-Z][A-Z0-9_]{3,80}$/.test(message) && domainRuleFor(message) !== null;
  } catch {
    return false;
  }
}

/**
 * Producer-side (service result) sanitizer: keeps a bare allowlisted code verbatim (machine contract) and
 * converts every other thrown value to safe Arabic text. Raw SDK/queue text can never be returned.
 */
export function safeResultMessage(error: unknown, context: SafeMessageContext = 'generic', options: SafeMessageOptions = {}): string {
  try {
    const message = rawMessageOf(error);
    if (message !== null && isBareAllowlistedCode(message)) return message;
  } catch {
    // fall through to the text sanitizer
  }
  return safeUserMessage(error, context, { allowAppText: true, ...options });
}

/**
 * Consumer-side presenter for a service result message: a bare allowlisted code is rendered as stable
 * Arabic text; any other message was already sanitized by its producer and is returned unchanged.
 */
export function presentResultMessage(message: string, context: SafeMessageContext = 'generic'): string {
  return isBareAllowlistedCode(message) ? safeUserMessage(message, context) : message;
}
