import type { EnqueueSyncMutation, SyncOperation } from '../services/syncCoordinator';
import { buildAuditLog } from './auditPolicy';
import { validateAuditedEnvelopeCapacity } from './auditedEnvelope';
import { assertReceiptV4EnvelopeCapacity } from './receiptProtocol';

export interface LegacyP3AuditUpgradeContext {
  mutationId: string;
  userId: string;
  createdAt: number;
}

export interface LegacyP3AuditEnvelope {
  kind: 'business' | 'standalone-audit';
  originalOperations: SyncOperation[];
  businessOperations: SyncOperation[];
}

export type LegacyP3V4Classification =
  | { kind: 'DELIVERABLE'; delivery: EnqueueSyncMutation }
  | { kind: 'QUARANTINED'; reason: string };

const LEGACY_AUDIT_KEYS = ['action', 'details', 'id', 'itemType', 'timestamp', 'user'] as const;
const LEGACY_AUDIT_ACTION = 'تثبيت عملية محلية ذرية';
const LEGACY_STANDALONE_KEYS = new Set(['action', 'attachment', 'details', 'id', 'itemType', 'timestamp', 'user']);

const operationItemType = (operation: SyncOperation): 'مادة' | 'حركة' | 'إعدادات' | 'مولد' => {
  if (operation.collection === 'materials') return 'مادة';
  if (operation.collection === 'transactions') return 'حركة';
  if (operation.collection === 'generator_logs') return 'مولد';
  return 'إعدادات';
};

const isExactLegacyP3Audit = (
  operation: SyncOperation,
  label: string,
): operation is Extract<SyncOperation, { kind: 'set' }> => {
  if (operation.kind !== 'set'
    || operation.collection !== 'audit_logs'
    || operation.expected.kind !== 'missing') return false;
  const value = operation.value;
  if (Object.keys(value).sort().join('\u0000') !== LEGACY_AUDIT_KEYS.join('\u0000')) return false;
  return typeof value.id === 'string'
    && value.id === operation.docId
    && /^al-domain-\d+-[a-z0-9]{1,12}$/.test(operation.docId)
    && typeof value.timestamp === 'string'
    && !Number.isNaN(new Date(value.timestamp).getTime())
    && typeof value.user === 'string'
    && value.user.trim().length > 0
    && value.action === LEGACY_AUDIT_ACTION
    && value.details === label
    && value.itemType === 'إعدادات';
};

const isExactLegacyP3StandaloneAudit = (
  operation: SyncOperation,
): operation is Extract<SyncOperation, { kind: 'set' }> => {
  if (operation.kind !== 'set'
    || operation.collection !== 'audit_logs'
    || operation.expected.kind !== 'missing') return false;
  const value = operation.value;
  const keys = Object.keys(value);
  return keys.every(key => LEGACY_STANDALONE_KEYS.has(key))
    && ['action', 'details', 'id', 'timestamp', 'user'].every(key => Object.hasOwn(value, key))
    && typeof value.id === 'string'
    && value.id === operation.docId
    && /^al-\d+-[a-z0-9]{1,12}$/.test(operation.docId)
    && typeof value.timestamp === 'string'
    && !Number.isNaN(new Date(value.timestamp).getTime())
    && typeof value.user === 'string'
    && value.user.trim().length > 0
    && typeof value.action === 'string'
    && value.action.length > 0
    && typeof value.details === 'string'
    && value.details.length > 0
    && (value.itemType === undefined || typeof value.itemType === 'string')
    && (value.attachment === undefined || typeof value.attachment === 'string');
};

export const inspectLegacyP3AuditEnvelope = (
  input: EnqueueSyncMutation,
  context: LegacyP3AuditUpgradeContext,
): LegacyP3AuditEnvelope | null => {
  if (typeof input.label !== 'string' || !input.label
    || !/^domain-[A-Za-z0-9-]{1,180}$/.test(context.mutationId)
    || !context.userId || context.userId.length > 128
    || !Number.isSafeInteger(context.createdAt) || context.createdAt < 0
    || input.operations.length < 1) return null;

  if (input.label === 'append-audit-log' && input.operations.length === 1
    && isExactLegacyP3StandaloneAudit(input.operations[0])) {
    return {
      kind: 'standalone-audit',
      originalOperations: input.operations,
      businessOperations: [],
    };
  }

  if (input.operations.length < 2) return null;
  const legacyAudit = input.operations.at(-1);
  if (!legacyAudit || !isExactLegacyP3Audit(legacyAudit, input.label)) return null;
  const businessOperations = input.operations.slice(0, -1);
  if (businessOperations.some(operation => operation.collection === 'audit_logs')) return null;
  return {
    kind: 'business',
    originalOperations: input.operations,
    businessOperations,
  };
};

/**
 * Adapts only the exact durable envelope emitted by P3's appendAtomicMutationAudit helper.
 *
 * The original business operations, baselines and ordering stay byte-for-byte intact. The one
 * unattested free-form audit is not promoted to a claim of prior central observation. Instead,
 * deterministic schema-v3 audits describe the business writes that will now be committed with
 * their targets and immutable receipt in the same Firestore transaction.
 */
export const upgradeLegacyP3AuditEnvelope = (
  input: EnqueueSyncMutation,
  context: LegacyP3AuditUpgradeContext,
): EnqueueSyncMutation => {
  const legacy = inspectLegacyP3AuditEnvelope(input, context);
  if (!legacy) return input;
  const timestamp = new Date(context.createdAt).toISOString();
  if (legacy.kind === 'standalone-audit') {
    const id = `${context.mutationId}--system--legacy-audit-migration`;
    if (id.length > 256) return input;
    const audit = buildAuditLog({
      id,
      timestamp,
      actorUserId: context.userId,
      actorDisplayName: 'مستخدم النظام',
      context: {
        operationType: 'system',
        affectedEntities: ['system/legacy-audit-migration'],
        templateId: 'legacy_audit_migration',
      },
    });
    return {
      ...input,
      operations: [{
        kind: 'set',
        collection: 'audit_logs',
        docId: id,
        value: audit as unknown as Record<string, unknown>,
        expected: { kind: 'missing' },
      }],
    };
  }

  const audits: SyncOperation[] = [];
  for (const operation of legacy.businessOperations) {
    if (!/^[A-Za-z0-9._:-]{1,180}$/.test(operation.docId)) return input;
    const id = `${context.mutationId}--${operation.collection}--${operation.docId}`;
    if (id.length > 256) return input;
    const operationType = operation.kind === 'delete'
      ? 'delete'
      : operation.expected.kind === 'missing' ? 'create' : 'update';
    const audit = buildAuditLog({
      id,
      timestamp,
      actorUserId: context.userId,
      // FirestoreSyncTransport replaces this placeholder with the authenticated profile name in
      // the same transaction; it is deterministic so receipt replay cannot drift.
      actorDisplayName: 'مستخدم النظام',
      itemType: operationItemType(operation),
      context: {
        operationType,
        affectedEntities: [`${operation.collection}/${operation.docId}`],
        templateId: 'domain_mutation',
      },
    });
    audits.push({
      kind: 'set',
      collection: 'audit_logs',
      docId: id,
      value: audit as unknown as Record<string, unknown>,
      expected: { kind: 'missing' },
    });
  }

  return { ...input, operations: [...legacy.businessOperations, ...audits] };
};

/**
 * Classifies only the exact P3 envelope shape. The original mutation is never rewritten here;
 * callers persist it unchanged and use `delivery` transiently. An old fingerprint-only baseline,
 * an unsplittable over-capacity atomic envelope, or any proof/size failure is terminal quarantine.
 */
export const classifyLegacyP3AuditEnvelopeForV4 = (mutation: {
  id: string;
  userId: string;
  createdAt: number;
  operations: SyncOperation[];
  label?: string;
}): LegacyP3V4Classification | null => {
  const input = { operations: mutation.operations, label: mutation.label };
  const context = {
    mutationId: mutation.id,
    userId: mutation.userId,
    createdAt: mutation.createdAt,
  };
  if (!inspectLegacyP3AuditEnvelope(input, context)) return null;
  const delivery = upgradeLegacyP3AuditEnvelope(input, context);
  if (!delivery.operations.some(operation => operation.kind === 'set'
    && operation.collection === 'audit_logs'
    && operation.value.schemaVersion === 3)) {
    return { kind: 'QUARANTINED', reason: 'SYNC_LEGACY_QUARANTINED:UPGRADE_PROOF_UNAVAILABLE' };
  }
  try {
    validateAuditedEnvelopeCapacity(delivery.operations);
    assertReceiptV4EnvelopeCapacity({
      id: mutation.id,
      userId: mutation.userId,
      operations: delivery.operations,
    }, mutation.userId);
    return { kind: 'DELIVERABLE', delivery };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'QUARANTINED', reason: `SYNC_LEGACY_QUARANTINED:${reason}` };
  }
};
