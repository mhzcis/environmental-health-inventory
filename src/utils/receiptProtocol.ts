import type { SyncExpectation } from './syncProtocol';
import { canonicalProofValue, stripSyncMetadata } from './syncProtocol';
import { assertDomainProofPayload, assertLegacyUserProofPayload, assertSettingsDocumentProof } from './productSchema';

export const RECEIPT_V4_SCHEMA_VERSION = 4 as const;
export const FIRESTORE_DOCUMENT_MAX_BYTES = 1_048_576;
export const FIRESTORE_REQUEST_MAX_BYTES = 10 * 1_048_576;
export const FIRESTORE_INDEX_ENTRY_MAX_BYTES = 7.5 * 1_024;
export const FIRESTORE_DOCUMENT_INDEX_TOTAL_MAX_BYTES = 8 * 1_048_576;
const FIRESTORE_INDEXED_VALUE_MAX_BYTES = 1_500;
const RULES_MUTATION_ID = /^[A-Za-z0-9._:-]{1,180}$/;
const RULES_BUSINESS_DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,180}$/;
const RULES_AUDIT_DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,256}$/;

export type ReceiptBeforeProof =
  | { kind: 'missing' }
  | { kind: 'state'; revision: number; mutationId: string }
  | { kind: 'legacy'; exactLegacyPayload: Record<string, unknown> };

export interface ReceiptV4Binding {
  index: number;
  op: 'set' | 'delete';
  path: string;
  before: ReceiptBeforeProof;
  auditId: string;
  afterPayload?: Record<string, unknown>;
}

export interface CommitReceiptV4 {
  schemaVersion: typeof RECEIPT_V4_SCHEMA_VERSION;
  userId: string;
  mutationId: string;
  operationCount: number;
  proofAuditIds: string[];
  bindings: ReceiptV4Binding[];
  deleteCollections: string[];
}

export interface ReceiptOperationLike {
  kind: 'set' | 'delete';
  collection: string;
  docId: string;
  expected: SyncExpectation;
  value?: Record<string, unknown>;
}

export interface ReceiptMutationLike {
  id: string;
  userId: string;
  operations: ReceiptOperationLike[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const ROOT_PAYLOAD_KEYS: Record<string, ReadonlySet<string>> = {
  materials: new Set([
    'id', 'code', 'name', 'category', 'unit', 'minimumStock', 'currentStock', 'initialStock',
    'storageLocation', 'primaryStorehouseId', 'storageLocationDetail', 'warehouseStocks',
    'warehouseStocksById', 'notes', 'createdAt', 'updatedAt', 'type', 'manufacturer',
    'productionDate', 'expiryDate', 'hazardLevel',
  ]),
  transactions: new Set([
    'id', 'transactionNumber', 'date', 'itemType', 'itemId', 'itemCode', 'itemName',
    'itemCategory', 'transactionType', 'transferType', 'operationId', 'pairedTransactionId',
    'quantity', 'unit', 'storehouse', 'storehouseId', 'stockBefore', 'stockAfter', 'executedBy',
    'supplierOrReceiver', 'notes', 'attachment', 'createdAt', 'updatedAt',
  ]),
  settings: new Set([
    'settingsSchemaVersion', 'organizationName', 'departmentName', 'expiryWarningThresholdDays', 'units',
    'storehouses', 'storehouseIds', 'warehouseSchemaVersion', 'cloudSyncEnabled',
    'firebaseInitialized', 'storekeeperName', 'systemManagerName', 'healthDirectorName',
    'storekeeperRole', 'systemManagerRole', 'healthDirectorRole', 'showStorekeeperSignature',
    'showSystemManagerSignature', 'showHealthDirectorSignature', 'transactionCounters',
    'openingStockAttachmentKeys', 'categoryIds', 'partnerIds',
    // Typed children + legacy nested baselines (discriminated by docId / allowLegacyNestedBaseline).
    'id', 'name', 'prefix', 'startRange', 'endRange', 'sortOrder', 'active', 'createdAt', 'updatedAt',
    'type', 'phone', 'notes', 'key', 'data',
    'categories', 'storehouseEntities', 'partners', 'openingStockAttachment', 'openingStockAttachments',
  ]),
  generator_logs: new Set([
    'id', 'date', 'dayName', 'previousReading', 'currentReading', 'operatingHours', 'notes',
    'createdAt', 'updatedAt', 'createdBy',
  ]),
  users: new Set([
    'id', 'authUid', 'username', 'fullName', 'role', 'permissions', 'active', 'createdAt',
  ]),
  audit_logs: new Set([
    'schemaVersion', 'id', 'action', 'details', 'itemType', 'templateId', 'operationType',
    'primaryEntity', 'outcome',
  ]),
};

const SENSITIVE_FIELD_NAMES = new Set([
  'password', 'passwordhash', 'passwordsalt', 'passcode', 'pin', 'secret', 'clientsecret',
  'credentials', 'credential', 'authorization', 'accesstoken', 'refreshtoken', 'idtoken',
  'authtoken', 'oauthtoken', 'sessiontoken', 'token', 'jwt', 'bearer', 'oauth',
  'privatekey', 'secretkey', 'signingkey', 'encryptionkey', 'apikey', 'cookie', 'setcookie',
  'sessionid', 'recoverycode', 'recoverycodes', 'totpsecret', 'mfasecret',
]);

const normalizedFieldName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const assertNoSensitiveFields = (value: unknown, path: string, seen: WeakSet<object>): void => {
  if (!value || typeof value !== 'object' || value instanceof Date) return;
  if (seen.has(value)) throw new Error(`SYNC_RECEIPT_PAYLOAD_CYCLIC:${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => assertNoSensitiveFields(entry, `${path}[${index}]`, seen));
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_NAMES.has(normalizedFieldName(key))) {
        throw new Error(`SYNC_RECEIPT_PAYLOAD_SENSITIVE_REJECTED:${path}.${key}`);
      }
      assertNoSensitiveFields(nested, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
};

export const assertReceiptProofPayloadSafe = (
  collection: string,
  payload: Record<string, unknown>,
  options: { docId?: string; allowLegacyNestedBaseline?: boolean } = {},
): void => {
  const allowed = ROOT_PAYLOAD_KEYS[collection];
  if (!allowed || Object.keys(payload).some(key => !allowed.has(key))) {
    throw new Error(`SYNC_RECEIPT_PAYLOAD_SCHEMA_REJECTED:${collection}`);
  }
  assertNoSensitiveFields(payload, collection, new WeakSet());
  try {
    if (collection === 'settings' && options.docId) {
      assertSettingsDocumentProof(options.docId, payload, {
        allowLegacyNestedBaseline: options.allowLegacyNestedBaseline,
      });
    } else {
      assertDomainProofPayload(collection, payload);
    }
  } catch (error) {
    throw new Error(`SYNC_RECEIPT_PAYLOAD_SCHEMA_REJECTED:${collection}:${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * Audit documents are server-enriched with actor identity, request.time and __sync. Receipt proof
 * contains only the immutable, fixed-template application fields; Rules verify the server fields
 * separately against the authenticated request.
 */
export const auditReceiptAfterPayload = (value: Record<string, unknown>): Record<string, unknown> => {
  const {
    timestamp: _timestamp,
    actorUserId: _actorUserId,
    user: _user,
    __sync: _sync,
    attachment: _attachment,
    ...stable
  } = value;
  assertReceiptProofPayloadSafe('audit_logs', stable);
  return stable;
};

const applicationPayloadFor = (operation: ReceiptOperationLike): Record<string, unknown> => {
  if (operation.kind !== 'set' || !operation.value) {
    throw new Error(`SYNC_RECEIPT_AFTER_PAYLOAD_REQUIRED:${operation.collection}/${operation.docId}`);
  }
  const payload = operation.collection === 'audit_logs'
    ? auditReceiptAfterPayload(operation.value)
    : stripSyncMetadata(operation.value);
  if (!isRecord(payload)) {
    throw new Error(`SYNC_RECEIPT_AFTER_PAYLOAD_INVALID:${operation.collection}/${operation.docId}`);
  }
  assertReceiptProofPayloadSafe(operation.collection, payload, { docId: operation.docId });
  return payload;
};

const beforeProofFor = (operation: ReceiptOperationLike): ReceiptBeforeProof => {
  if (operation.expected.kind === 'missing') return { kind: 'missing' };
  if (operation.expected.stateToken) {
    const { revision, mutationId } = operation.expected.stateToken;
    if (!Number.isSafeInteger(revision) || revision < 1 || !mutationId || mutationId.includes('/')) {
      throw new Error(`SYNC_STATE_TOKEN_INVALID:${operation.collection}/${operation.docId}`);
    }
    return { kind: 'state', revision, mutationId };
  }
  if (isRecord(operation.expected.exactLegacyPayload)) {
    if (Object.hasOwn(operation.expected.exactLegacyPayload, '__sync')) {
      throw new Error(`SYNC_LEGACY_BASELINE_INVALID:${operation.collection}/${operation.docId}`);
    }
    const exactLegacyPayload = stripSyncMetadata(operation.expected.exactLegacyPayload);
    if (!isRecord(exactLegacyPayload)) {
      throw new Error(`SYNC_LEGACY_BASELINE_INVALID:${operation.collection}/${operation.docId}`);
    }
    if (operation.collection === 'users') {
      const allowed = ROOT_PAYLOAD_KEYS.users;
      if (Object.keys(exactLegacyPayload).some(key => !allowed.has(key))) {
        throw new Error(`SYNC_RECEIPT_PAYLOAD_SCHEMA_REJECTED:${operation.collection}`);
      }
      assertNoSensitiveFields(exactLegacyPayload, operation.collection, new WeakSet());
      assertLegacyUserProofPayload(exactLegacyPayload);
    } else {
      assertReceiptProofPayloadSafe(operation.collection, exactLegacyPayload, {
        docId: operation.docId,
        allowLegacyNestedBaseline: operation.collection === 'settings' && operation.docId === 'app_config',
      });
    }
    return { kind: 'legacy', exactLegacyPayload };
  }
  throw new Error(`SYNC_BASELINE_PROOF_REQUIRED:${operation.collection}/${operation.docId}`);
};

const schemaV3Audit = (operation: ReceiptOperationLike): boolean =>
  operation.kind === 'set'
  && operation.collection === 'audit_logs'
  && operation.value?.schemaVersion === 3;

export const buildReceiptV4 = (
  mutation: ReceiptMutationLike,
  activeUserId: string,
): CommitReceiptV4 => {
  if (!activeUserId || mutation.userId !== activeUserId || !RULES_MUTATION_ID.test(mutation.id)) {
    throw new Error('SYNC_RECEIPT_IDENTITY_INVALID');
  }
  for (const operation of mutation.operations) {
    const allowedId = operation.collection === 'audit_logs'
      ? RULES_AUDIT_DOCUMENT_ID
      : RULES_BUSINESS_DOCUMENT_ID;
    if (!Object.hasOwn(ROOT_PAYLOAD_KEYS, operation.collection) || !allowedId.test(operation.docId)) {
      throw new Error(`SYNC_RECEIPT_DOCUMENT_ID_INVALID:${operation.collection}/${operation.docId}`);
    }
  }
  const audits = mutation.operations.filter(schemaV3Audit);
  if (audits.length < 1) throw new Error('SYNC_RECEIPT_AUDIT_PROOF_REQUIRED');
  const business = mutation.operations.filter(operation => operation.collection !== 'audit_logs');
  if (business.length > 0 && (audits.length !== business.length
    || mutation.operations.length !== business.length + audits.length)) {
    throw new Error('SYNC_COMPANION_AUDIT_CARDINALITY_MISMATCH');
  }
  if (business.length === 0 && (mutation.operations.length !== 1 || audits.length !== 1)) {
    throw new Error('SYNC_STANDALONE_AUDIT_CARDINALITY_MISMATCH');
  }

  const auditByEntity = new Map<string, ReceiptOperationLike>();
  for (const audit of audits) {
    const entity = String(audit.value?.primaryEntity ?? '');
    if (!entity || auditByEntity.has(entity)) throw new Error('SYNC_RECEIPT_AUDIT_ENTITY_DUPLICATE');
    auditByEntity.set(entity, audit);
  }
  const proofAuditIds = audits.map(audit => audit.docId);
  if (new Set(proofAuditIds).size !== proofAuditIds.length) {
    throw new Error('SYNC_RECEIPT_AUDIT_ID_DUPLICATE');
  }

  const bindings = mutation.operations.map((operation, index): ReceiptV4Binding => {
    const path = `${operation.collection}/${operation.docId}`;
    const audit = operation.collection === 'audit_logs' ? operation : auditByEntity.get(path);
    if (!audit || (operation.collection !== 'audit_logs' && business.length > 0
      && audit.docId !== `${mutation.id}--${operation.collection}--${operation.docId}`)) {
      throw new Error(`SYNC_COMPANION_AUDIT_REQUIRED:${path}`);
    }
    const binding: ReceiptV4Binding = {
      index,
      op: operation.kind,
      path,
      before: beforeProofFor(operation),
      auditId: audit.docId,
    };
    if (operation.kind === 'set') binding.afterPayload = applicationPayloadFor(operation);
    return binding;
  });

  return {
    schemaVersion: RECEIPT_V4_SCHEMA_VERSION,
    userId: activeUserId,
    mutationId: mutation.id,
    operationCount: mutation.operations.length,
    proofAuditIds,
    bindings,
    deleteCollections: [...new Set(mutation.operations
      .filter(operation => operation.kind === 'delete')
      .map(operation => operation.collection))].sort(),
  };
};

const RECEIPT_V4_KEYS = [
  'bindings', 'deleteCollections', 'mutationId', 'operationCount', 'proofAuditIds',
  'schemaVersion', 'timestamp', 'userId',
].sort().join('\u0000');

export const receiptV4PayloadMatches = (
  value: unknown,
  expected: CommitReceiptV4,
): boolean => {
  if (!isRecord(value) || Object.keys(value).sort().join('\u0000') !== RECEIPT_V4_KEYS) return false;
  const { timestamp: _timestamp, ...payload } = value;
  return canonicalProofValue(payload) === canonicalProofValue(expected);
};

const utf8Size = (value: string): number => new TextEncoder().encode(value).byteLength;
const firestoreStringSize = (value: string): number => utf8Size(value) + 1;

export const estimateFirestoreValueSize = (value: unknown, seen = new WeakSet<object>()): number => {
  if (value === null || value === undefined) return 1;
  if (typeof value === 'string') return firestoreStringSize(value);
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number' || typeof value === 'bigint') return 8;
  if (value instanceof Date || typeof (value as { toDate?: unknown })?.toDate === 'function') return 8;
  if (typeof value !== 'object') return firestoreStringSize(String(value));
  if (seen.has(value)) throw new Error('SYNC_RECEIPT_SIZE_CYCLIC');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.reduce((total, entry) => total + estimateFirestoreValueSize(entry, seen), 0);
    }
    let total = 32;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      total += firestoreStringSize(key) + estimateFirestoreValueSize(nested, seen);
    }
    return total;
  } finally {
    seen.delete(value);
  }
};

const firestoreDocumentNameSize = (path: string): number =>
  path.split('/').reduce((total, segment) => total + firestoreStringSize(segment), 16);

export const estimateFirestoreDocumentSize = (path: string, value: Record<string, unknown>): number =>
  firestoreDocumentNameSize(path) + estimateFirestoreValueSize(value);

const estimateAutomaticIndexBytes = (
  documentNameBytes: number,
  value: unknown,
  fieldPath: string,
  seen: WeakSet<object>,
): number => {
  if (value && typeof value === 'object' && !(value instanceof Date)
    && typeof (value as { toDate?: unknown }).toDate !== 'function') {
    if (seen.has(value)) throw new Error('SYNC_RECEIPT_SIZE_CYCLIC');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        // Firestore's automatic array mode creates one entry per element. Charging three capped
        // entries per element also covers ascending/descending configuration drift conservatively.
        return value.reduce((total, entry) => {
          const entryBytes = Math.min(
            FIRESTORE_INDEX_ENTRY_MAX_BYTES,
            (documentNameBytes * 2) + firestoreStringSize(fieldPath)
              + Math.min(estimateFirestoreValueSize(entry), FIRESTORE_INDEXED_VALUE_MAX_BYTES) + 32,
          );
          return total + (entryBytes * 3);
        }, 0);
      }
      return Object.entries(value as Record<string, unknown>).reduce((total, [key, nested]) =>
        total + estimateAutomaticIndexBytes(
          documentNameBytes,
          nested,
          fieldPath ? `${fieldPath}.${key}` : key,
          seen,
        ), 0);
    } finally {
      seen.delete(value);
    }
  }
  const entryBytes = Math.min(
    FIRESTORE_INDEX_ENTRY_MAX_BYTES,
    (documentNameBytes * 2) + firestoreStringSize(fieldPath)
      + Math.min(estimateFirestoreValueSize(value), FIRESTORE_INDEXED_VALUE_MAX_BYTES) + 32,
  );
  // Automatic scalar indexes have ascending and descending entries.
  return entryBytes * 2;
};

/**
 * Conservative request contribution for a document plus repository-defined automatic indexes.
 * Composite indexes are not declared by this repository. The platform's absolute 8 MiB per-doc
 * index ceiling is applied even though the structural estimate is normally much smaller.
 */
export const estimateFirestoreWriteFootprint = (
  path: string,
  value: Record<string, unknown>,
): number => {
  if (!isRecord(value)) throw new Error(`SYNC_DOCUMENT_VALUE_INVALID:${path}`);
  const documentBytes = estimateFirestoreDocumentSize(path, value);
  const indexBytes = estimateAutomaticIndexBytes(
    firestoreDocumentNameSize(path),
    value,
    '',
    new WeakSet(),
  );
  if (indexBytes > FIRESTORE_DOCUMENT_INDEX_TOTAL_MAX_BYTES) {
    throw new Error(
      `SYNC_DOCUMENT_INDEX_SIZE_LIMIT_EXCEEDED:${path}:${indexBytes}/${FIRESTORE_DOCUMENT_INDEX_TOTAL_MAX_BYTES}`,
    );
  }
  return documentBytes + indexBytes;
};

const baselineWriteFootprint = (operation: ReceiptOperationLike): number => {
  if (operation.expected.kind !== 'present') return 0;
  if (isRecord(operation.expected.exactLegacyPayload)) {
    return estimateFirestoreWriteFootprint(
      `${operation.collection}/${operation.docId}`,
      operation.expected.exactLegacyPayload,
    );
  }
  const estimated = operation.expected.baselineRequestBytes;
  if (!Number.isSafeInteger(estimated) || Number(estimated) <= 0) {
    throw new Error(`SYNC_BASELINE_SIZE_PROOF_REQUIRED:${operation.collection}/${operation.docId}`);
  }
  return Number(estimated);
};

/**
 * Uses Firestore's documented UTF-8/field/map/document sizing model. Delete targets with only a
 * StateToken are charged at the full 1 MiB document ceiling because their payload is intentionally
 * absent from the journal. This is a conservative upper bound, not a guessed business cap.
 */
export const assertReceiptV4EnvelopeCapacity = (
  mutation: ReceiptMutationLike,
  activeUserId: string,
): CommitReceiptV4 => {
  const receipt = buildReceiptV4(mutation, activeUserId);
  const timestampPlaceholder = new Date(0);
  const receiptPath = `_sync_delete_receipts/${activeUserId}/mutations/${mutation.id}`;
  const receiptDocument = {
    ...receipt,
    timestamp: timestampPlaceholder,
  };
  const receiptSize = estimateFirestoreDocumentSize(receiptPath, receiptDocument);
  if (receiptSize > FIRESTORE_DOCUMENT_MAX_BYTES) {
    throw new Error(`SYNC_RECEIPT_DOCUMENT_SIZE_LIMIT_EXCEEDED:${receiptSize}/${FIRESTORE_DOCUMENT_MAX_BYTES}`);
  }

  let requestSize = estimateFirestoreWriteFootprint(receiptPath, receiptDocument);
  for (const operation of mutation.operations) {
    const path = `${operation.collection}/${operation.docId}`;
    if (operation.kind === 'delete') {
      requestSize += baselineWriteFootprint(operation);
      continue;
    }
    const written = {
      ...(operation.value ?? {}),
      __sync: {
        revision: 1,
        mutationId: mutation.id,
        auditId: 'x'.repeat(256),
        updatedBy: activeUserId,
        updatedAt: timestampPlaceholder,
        receiptBindingIndex: mutation.operations.length,
        targetCollection: operation.collection,
        targetDocumentId: operation.docId,
        targetOperation: 'update',
        targetReceiptBindingIndex: mutation.operations.length,
      },
    };
    const documentSize = estimateFirestoreDocumentSize(path, written);
    if (documentSize > FIRESTORE_DOCUMENT_MAX_BYTES) {
      throw new Error(`SYNC_DOCUMENT_SIZE_LIMIT_EXCEEDED:${path}:${documentSize}/${FIRESTORE_DOCUMENT_MAX_BYTES}`);
    }
    requestSize += estimateFirestoreWriteFootprint(path, written);
    if (operation.expected.kind === 'present') requestSize += baselineWriteFootprint(operation);
  }
  if (receipt.deleteCollections.length > 0) {
    const markerPath = `_audit_commits/${activeUserId}`;
    const marker = {
      schemaVersion: 1,
      userId: activeUserId,
      mutationId: mutation.id,
      timestamp: timestampPlaceholder,
    };
    // The marker is mutable, so include both removal and insertion of its small index footprint.
    requestSize += estimateFirestoreWriteFootprint(markerPath, marker) * 2;
  }
  if (requestSize > FIRESTORE_REQUEST_MAX_BYTES) {
    throw new Error(`SYNC_FIRESTORE_REQUEST_SIZE_LIMIT_EXCEEDED:${requestSize}/${FIRESTORE_REQUEST_MAX_BYTES}`);
  }
  return receipt;
};
