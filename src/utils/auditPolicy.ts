import type { AuditEventContext, AuditLog, AuditTemplateId } from '../types';

const MAX_AUDIT_TEXT_LENGTH = 1_000;
const MAX_AFFECTED_ENTITIES = 450;
const MAX_AFFECTED_ENTITY_LENGTH = 256;
const MAX_AFFECTED_ENTITIES_TEXT_LENGTH = 120_000;
const REDACTED = '[REDACTED]';

const normalizeText = (value: unknown): string => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const SECRET_KEY = '(?:password|passwd|pwd|token|access[\\s_-]*token|refresh[\\s_-]*token|id[\\s_-]*token|auth[\\s_-]*token|client[\\s_-]*secret|secret|api[\\s_-]*key|private[\\s_-]*key|authorization|credential|cookie|set[\\s_-]*cookie|session[\\s_-]*(?:id|token)|oauth[\\s_-]*(?:token|code))';

/** Defense in depth for legacy/free-form inputs. New schema-v3 events use fixed templates. */
export const sanitizeAuditText = (value: unknown): string => {
  const normalized = normalizeText(value)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(new RegExp(`(["'])(${SECRET_KEY})\\1\\s*:\\s*(["'])(?:\\\\.|(?!\\3).)*\\3`, 'gi'),
      (_match, quote: string, key: string) => `${quote}${key}${quote}:${quote}${REDACTED}${quote}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(new RegExp(`\\b(${SECRET_KEY})\\b\\s*[:=]\\s*(?:"(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|[^\\s,;]+)`, 'gi'),
      (_match, key: string) => `${key}=${REDACTED}`)
    .replace(/([?&](?:code|token|access_token|refresh_token|id_token|client_secret)=)[^&#\s]+/gi, `$1${REDACTED}`);
  return normalized.slice(0, MAX_AUDIT_TEXT_LENGTH);
};

export const sanitizeAffectedEntities = (values: unknown): string[] => {
  if (!Array.isArray(values)) return [];
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = normalizeText(value)
      .replace(/[^A-Za-z0-9._:/-]/g, '_')
      .slice(0, MAX_AFFECTED_ENTITY_LENGTH);
    if (normalized) unique.add(normalized);
    if (unique.size >= MAX_AFFECTED_ENTITIES) break;
  }
  return [...unique];
};

export const encodeAffectedEntities = (values: unknown): string =>
  sanitizeAffectedEntities(values).join('\n').slice(0, MAX_AFFECTED_ENTITIES_TEXT_LENGTH);

export const getAuditAffectedEntities = (value: unknown): string[] => {
  if (typeof value === 'string') return sanitizeAffectedEntities(value.split('\n'));
  return sanitizeAffectedEntities(value);
};

const primaryEntityFor = (values: unknown): string => {
  if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') {
    throw new Error('AUDIT_PRIMARY_ENTITY_REQUIRED');
  }
  const value = values[0].trim();
  // Keep the identifier small enough that the deterministic mutation audit ID remains below
  // buildAuditLog's 256-character document-ID boundary.
  if (!/^(materials|transactions|settings|generator_logs|users|system)\/[A-Za-z0-9._:-]{1,180}$/.test(value)) {
    throw new Error('AUDIT_PRIMARY_ENTITY_INVALID');
  }
  return value;
};

export const AUDIT_TEMPLATES: Record<AuditTemplateId, { action: string; details: string }> = {
  domain_mutation: { action: 'تغيير بيانات تشغيلي', details: 'تم تثبيت تغيير البيانات وسجل التدقيق المرتبط به ضمن معاملة واحدة.' },
  login: { action: 'تسجيل الدخول', details: 'تم قبول دورة تسجيل دخول جديدة.' },
  logout: { action: 'طلب تسجيل الخروج', details: 'تم تسجيل طلب المستخدم لإنهاء دورة الدخول؛ لا يثبت السجل اكتمال الخروج.' },
  security_change: { action: 'تغيير أمني', details: 'تم تنفيذ تغيير أمني على حساب مستخدم مُدار.' },
  password_reset: { action: 'طلب إعادة تعيين كلمة المرور', details: 'تم تسجيل طلب مستخدم مخوّل لإرسال إعادة التعيين دون حفظ بيانات اعتماد.' },
  backup_restore: { action: 'طلب استعادة نسخة احتياطية', details: 'تم تسجيل محاولة استعادة محلية مخوّلة؛ لا يثبت السجل وحده اكتمال تطبيق البيانات.' },
  settings_change: { action: 'تغيير إعدادات', details: 'تم تطبيق تغيير في إعدادات النظام.' },
  factory_reset: { action: 'طلب إعادة ضبط المصنع', details: 'تم تسجيل طلب إعادة ضبط مخوّل قبل تنفيذ مسح البيانات المحلية.' },
  legacy_audit_migration: {
    action: 'ترحيل سجل تدقيق قديم',
    details: 'تم تسجيل نية ترحيل سجل محلي من الإصدار السابق؛ لا يثبت هذا وقوع الحدث الأصلي أو ملاحظته مركزيًا.',
  },
  system_event: { action: 'حدث نظام', details: 'تم تسجيل حدث نظام مُهيكل.' },
};

const INTENT_TEMPLATES = new Set<AuditTemplateId>([
  'logout',
  'password_reset',
  'backup_restore',
  'factory_reset',
  'legacy_audit_migration',
]);

export const auditOutcomeForTemplate = (templateId: AuditTemplateId): NonNullable<AuditLog['outcome']> =>
  INTENT_TEMPLATES.has(templateId) ? 'recorded_intent' : 'success';

const defaultTemplateFor = (operationType: AuditEventContext['operationType']): AuditTemplateId => {
  if (operationType === 'login') return 'login';
  if (operationType === 'logout') return 'logout';
  if (operationType === 'security') return 'security_change';
  if (operationType === 'backup') return 'backup_restore';
  if (operationType === 'settings') return 'settings_change';
  if (operationType === 'system') return 'system_event';
  return 'domain_mutation';
};

export interface BuildAuditLogInput {
  id: string;
  timestamp: string;
  actorUserId: string;
  actorDisplayName: string;
  /** Source compatibility only; v3 persists allowlisted template text, never these values. */
  action?: string;
  details?: string;
  itemType?: string;
  context: AuditEventContext;
}

export const buildAuditLog = (input: BuildAuditLogInput): AuditLog => {
  const id = normalizeText(input.id).slice(0, 256);
  const actorUserId = normalizeText(input.actorUserId).slice(0, 128);
  const user = sanitizeAuditText(input.actorDisplayName);
  const primaryEntity = primaryEntityFor(input.context.affectedEntities);
  const templateId = input.context.templateId || defaultTemplateFor(input.context.operationType);
  const template = AUDIT_TEMPLATES[templateId];
  if (!id || !actorUserId || !user || !primaryEntity || !template) throw new Error('AUDIT_REQUIRED_FIELD_MISSING');
  if (Number.isNaN(new Date(input.timestamp).getTime())) throw new Error('AUDIT_TIMESTAMP_INVALID');

  return {
    id, timestamp: input.timestamp, actorUserId, user, templateId,
    action: template.action, details: template.details,
    ...(input.itemType ? { itemType: sanitizeAuditText(input.itemType).slice(0, 64) } : {}),
    schemaVersion: 3,
    operationType: input.context.operationType,
    primaryEntity,
    outcome: auditOutcomeForTemplate(templateId),
  };
};

const normalizeTimestamp = (value: unknown): string | null => {
  let candidate: unknown = value;
  if (value && typeof value === 'object') {
    const record = value as {
      toDate?: () => Date;
      toMillis?: () => number;
      seconds?: number;
      nanoseconds?: number;
      _seconds?: number;
      _nanoseconds?: number;
    };
    if (typeof record.toDate === 'function') candidate = record.toDate();
    else if (typeof record.toMillis === 'function') candidate = new Date(record.toMillis());
    else {
      const seconds = record.seconds ?? record._seconds;
      const nanos = record.nanoseconds ?? record._nanoseconds ?? 0;
      if (typeof seconds === 'number') candidate = new Date(seconds * 1_000 + nanos / 1_000_000);
    }
  }
  const date = candidate instanceof Date ? candidate : new Date(String(candidate ?? ''));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** Converts untrusted local/remote data to a small render-safe representation. */
export const normalizeAuditLog = (value: unknown, documentId?: string): AuditLog | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = normalizeText(documentId ?? record.id).slice(0, 256);
  const timestamp = normalizeTimestamp(record.timestamp);
  const user = sanitizeAuditText(record.user);
  const actorUserId = typeof record.actorUserId === 'string' ? normalizeText(record.actorUserId).slice(0, 128) : undefined;
  const allowedOperationTypes = new Set(['create', 'update', 'delete', 'batch', 'login', 'logout', 'security', 'backup', 'settings', 'system']);
  const operationType = typeof record.operationType === 'string' && allowedOperationTypes.has(record.operationType)
    ? record.operationType as AuditLog['operationType']
    : undefined;
  const affected = getAuditAffectedEntities(record.primaryEntity ?? record.affectedEntities);
  if (!id || !timestamp || !user) return null;

  if (record.schemaVersion === 3) {
    const templateId = typeof record.templateId === 'string' ? record.templateId as AuditTemplateId : undefined;
    const template = templateId ? AUDIT_TEMPLATES[templateId] : undefined;
    const expectedOutcome = templateId ? auditOutcomeForTemplate(templateId) : undefined;
    if (!template || !actorUserId || !operationType || affected.length !== 1 || record.outcome !== expectedOutcome) return null;
    return {
      id, timestamp, user, actorUserId, templateId, action: template.action, details: template.details,
      ...(typeof record.itemType === 'string' ? { itemType: sanitizeAuditText(record.itemType).slice(0, 64) } : {}),
      schemaVersion: 3, operationType, primaryEntity: affected[0], outcome: expectedOutcome,
    };
  }

  const action = sanitizeAuditText(record.action);
  const details = sanitizeAuditText(record.details);
  if (!action || !details) return null;
  return {
    id, timestamp, user, action, details, actorUserId, operationType,
    ...(affected.length ? { affectedEntities: encodeAffectedEntities(affected) } : {}),
    ...(typeof record.itemType === 'string' ? { itemType: sanitizeAuditText(record.itemType).slice(0, 64) } : {}),
  };
};
