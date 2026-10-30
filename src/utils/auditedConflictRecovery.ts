import type { SyncExpectation } from './syncProtocol';
import type { SyncOperation } from '../services/syncCoordinator';

type ExpectationBuilder = (
  operation: SyncOperation,
  remoteValue: Record<string, unknown> | undefined,
) => SyncExpectation;

const isCompanionAudit = (operation: SyncOperation): operation is Extract<SyncOperation, { kind: 'set' }> =>
  operation.kind === 'set'
  && operation.collection === 'audit_logs'
  && operation.value.schemaVersion === 3;

/**
 * Rebases an audited envelope as business/Audit pairs. A conflict must never change or remove a
 * business operation independently from its immutable proof row.
 */
export const rebaseAuditedEnvelopeForConflict = (
  operations: SyncOperation[],
  businessRemoteValues: Array<Record<string, unknown> | undefined>,
  buildExpectation: ExpectationBuilder,
): SyncOperation[] => {
  const businessCount = operations.filter(operation => operation.collection !== 'audit_logs').length;
  if (businessCount < 1 || operations.length !== businessCount * 2) {
    throw new Error('SYNC_CONFLICT_AUDITED_ENVELOPE_REQUIRED');
  }
  if (businessRemoteValues.length !== businessCount) {
    throw new Error('SYNC_CONFLICT_BUSINESS_SNAPSHOT_CARDINALITY_MISMATCH');
  }

  const businessOperations = operations.slice(0, businessCount);
  const auditOperations = operations.slice(businessCount);
  if (businessOperations.some(operation => operation.collection === 'audit_logs')
    || auditOperations.some(operation => !isCompanionAudit(operation))) {
    throw new Error('SYNC_CONFLICT_AUDITED_ENVELOPE_ORDER_INVALID');
  }

  const rebasedBusiness: SyncOperation[] = [];
  const rebuiltAudits: SyncOperation[] = [];
  for (let index = 0; index < businessCount; index += 1) {
    const operation = businessOperations[index];
    const audit = auditOperations[index] as Extract<SyncOperation, { kind: 'set' }>;
    const entity = `${operation.collection}/${operation.docId}`;
    if (audit.docId !== `${String(audit.value.id || '').trim()}`
      || audit.value.primaryEntity !== entity) {
      throw new Error(`SYNC_CONFLICT_AUDIT_PAIR_INVALID:${entity}`);
    }
    const remoteValue = businessRemoteValues[index];
    // An explicit "use local" resolution for an already-missing delete resolves the whole pair;
    // retaining only the Audit would create false/incomplete evidence.
    if (operation.kind === 'delete' && remoteValue === undefined) {
      if (businessCount > 1) throw new Error('SYNC_CONFLICT_ATOMIC_REBASE_UNSAFE');
      continue;
    }

    const expected = buildExpectation(operation, remoteValue);
    const operationType = operation.kind === 'delete'
      ? 'delete'
      : expected.kind === 'missing' ? 'create' : 'update';
    rebasedBusiness.push({ ...operation, expected });
    rebuiltAudits.push({
      ...audit,
      expected: { kind: 'missing' },
      value: { ...audit.value, operationType },
    });
  }

  return [...rebasedBusiness, ...rebuiltAudits];
};
