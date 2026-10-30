/**
 * Firestore Security Rules allow at most 20 document access calls for an atomic multi-document
 * request and retain the 10-call limit for each individual operation. The P7 rules cache the actor
 * and receipt reads across the request, while every linked business/audit pair contributes one
 * target -> audit read and one audit -> target read. A delete envelope also reads the actor-scoped
 * commit marker. Bounded material-map validation reads settings/app_config once per request so
 * dynamic warehouse names/ids cannot bypass the Rules schema. The receipt is the most expensive
 * individual operation: one actor read plus one read for every proof Audit.
 *
 * The canonical Rules proof has also been measured with the Firestore Emulator after schema
 * enforcement. The access-safe worst case is 8 business pairs for both set and delete envelopes;
 * smaller domain-specific payloads are not allowed to create a larger durable envelope because a
 * later conflict rebase must retain the same guarantee. Keep this as a topology calculation rather
 * than a hand-picked business-operation ceiling. Any future rules change must update the access
 * model and its Emulator expression/access boundary tests together.
 */
export const FIRESTORE_ATOMIC_RULE_DOCUMENT_ACCESS_LIMIT = 20;
export const FIRESTORE_RULE_PER_OPERATION_DOCUMENT_ACCESS_LIMIT = 10;

const SHARED_ACTOR_AND_RECEIPT_ACCESSES = 2;
const ACCESSES_PER_LINKED_BUSINESS_OPERATION = 2;
const DELETE_COMMIT_MARKER_ACCESSES = 1;
const MATERIAL_SCHEMA_SETTINGS_ACCESSES = 1;

interface AuditedEnvelopeOperation {
  kind: 'set' | 'delete';
  collection: string;
  docId: string;
  value?: Record<string, unknown>;
}

const isSchemaV3Audit = (operation: AuditedEnvelopeOperation): boolean =>
  operation.kind === 'set'
  && operation.collection === 'audit_logs'
  && operation.value?.schemaVersion === 3;

export const auditedEnvelopeRuleDocumentAccesses = (
  operations: AuditedEnvelopeOperation[],
): number | null => {
  const auditOperations = operations.filter(operation => operation.collection === 'audit_logs');
  if (!auditOperations.some(isSchemaV3Audit)) return null;
  const businessOperations = operations.filter(operation => operation.collection !== 'audit_logs');

  // A standalone structured Audit event uses only the shared actor/receipt reads and the receipt's
  // proof-audit read. It is not an expanded business envelope.
  if (businessOperations.length === 0) return SHARED_ACTOR_AND_RECEIPT_ACCESSES + 1;

  const hasDelete = businessOperations.some(operation => operation.kind === 'delete');
  const validatesWarehouseMaps = businessOperations.some(operation => operation.collection === 'materials');
  return SHARED_ACTOR_AND_RECEIPT_ACCESSES
    + (businessOperations.length * ACCESSES_PER_LINKED_BUSINESS_OPERATION)
    + (hasDelete ? DELETE_COMMIT_MARKER_ACCESSES : 0)
    + (validatesWarehouseMaps ? MATERIAL_SCHEMA_SETTINGS_ACCESSES : 0);
};

export const auditedEnvelopeMaxPerOperationRuleDocumentAccesses = (
  operations: AuditedEnvelopeOperation[],
): number | null => {
  const auditOperations = operations.filter(operation => operation.collection === 'audit_logs');
  if (!auditOperations.some(isSchemaV3Audit)) return null;
  const businessCount = operations.length - auditOperations.length;
  if (businessCount === 0) return 2;
  const receiptAccesses = 1 + auditOperations.length;
  const linkedTargetOrAuditAccesses = operations.some(operation => operation.collection === 'materials') ? 4 : 3;
  return Math.max(receiptAccesses, linkedTargetOrAuditAccesses);
};

export const validateAuditedEnvelopeCapacity = (
  operations: AuditedEnvelopeOperation[],
): void => {
  const auditOperations = operations.filter(operation => operation.collection === 'audit_logs');
  if (!auditOperations.some(isSchemaV3Audit)) return;
  if (auditOperations.some(operation => !isSchemaV3Audit(operation))) {
    throw new Error('SYNC_AUDIT_SCHEMA_MIXED');
  }

  const businessOperations = operations.filter(operation => operation.collection !== 'audit_logs');
  if (businessOperations.length === 0) {
    if (operations.length !== 1 || auditOperations.length !== 1) {
      throw new Error('SYNC_STANDALONE_AUDIT_CARDINALITY_MISMATCH');
    }
    return;
  }
  if (auditOperations.length !== businessOperations.length
    || operations.length !== businessOperations.length + auditOperations.length) {
    throw new Error('SYNC_COMPANION_AUDIT_CARDINALITY_MISMATCH');
  }

  // The Rules proof intentionally avoids re-validating each binding twice. Its complete-proof
  // invariant therefore depends on one canonical layout: business operation i is followed, in the
  // second half, by its Audit operation i. Reject a non-canonical envelope before it can enter the
  // journal/queue and become permanently undeliverable.
  const businessCount = businessOperations.length;
  const orderedBusiness = operations.slice(0, businessCount);
  const orderedAudits = operations.slice(businessCount);
  if (orderedBusiness.some(operation => operation.collection === 'audit_logs')
    || orderedAudits.some(operation => !isSchemaV3Audit(operation))) {
    throw new Error('SYNC_AUDITED_ENVELOPE_ORDER_INVALID');
  }
  for (let index = 0; index < businessCount; index += 1) {
    const business = orderedBusiness[index];
    const audit = orderedAudits[index];
    if (audit.value?.id !== audit.docId
      || audit.value?.primaryEntity !== `${business.collection}/${business.docId}`) {
      throw new Error(`SYNC_AUDITED_ENVELOPE_PAIR_INVALID:${index}`);
    }
  }

  const requiredAccesses = auditedEnvelopeRuleDocumentAccesses(operations);
  if (requiredAccesses !== null && requiredAccesses > FIRESTORE_ATOMIC_RULE_DOCUMENT_ACCESS_LIMIT) {
    throw new Error(
      `SYNC_FIRESTORE_RULES_ACCESS_LIMIT_EXCEEDED:${requiredAccesses}/${FIRESTORE_ATOMIC_RULE_DOCUMENT_ACCESS_LIMIT}`,
    );
  }
  const perOperationAccesses = auditedEnvelopeMaxPerOperationRuleDocumentAccesses(operations);
  if (perOperationAccesses !== null
    && perOperationAccesses > FIRESTORE_RULE_PER_OPERATION_DOCUMENT_ACCESS_LIMIT) {
    throw new Error(
      `SYNC_FIRESTORE_RULES_PER_OPERATION_ACCESS_LIMIT_EXCEEDED:${perOperationAccesses}/${FIRESTORE_RULE_PER_OPERATION_DOCUMENT_ACCESS_LIMIT}`,
    );
  }
};
