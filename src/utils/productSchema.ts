/**
 * P7 bounded in-place product contract.
 *
 * Cardinalities come from the repository's production defaults and producers, with one additional
 * item of operational headroom: 5 categories/units, 6 warehouses/partners, and one additional
 * complete warehouse row beyond the 5 x 6 opening-document matrix.
 * Byte bounds come from Firestore's indexed-string/document limits and the existing 850,000-byte
 * settings guard. They are deliberately shared by UI/import, pre-journal proof generation and
 * Firestore Rules; unsupported data is rejected rather than truncated or normalized.
 */
import { safeUserMessage } from '../services/safeUserMessage';

export const PRODUCT_LIMITS = Object.freeze({
  documentIdBytes: 180,
  indexedTextBytes: 1_500,
  isoDateBytes: 32,
  categories: 6,
  units: 6,
  storehouses: 7,
  warehouseStockEntries: 7,
  partners: 7,
  openingStockAttachments: 36,
  permissions: 18,
  attachmentBytes: 850_000,
  settingsDocumentBytes: 850_000,
  nestingDepth: 2,
});

export type ReceiptProofDomain =
  | 'materials'
  | 'transactions'
  | 'settings'
  | 'users'
  | 'generator_logs'
  | 'audit_logs';

const encoder = new TextEncoder();
const bytes = (value: string): number => encoder.encode(value).byteLength;
const own = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function fail(domain: string, field: string, reason: string): never {
  throw new Error(`PRODUCT_SCHEMA_REJECTED:${domain}:${field}:${reason}`);
}

const assertKeys = (
  domain: string,
  field: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = [],
): void => {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find(key => !allowedSet.has(key));
  if (unexpected) fail(domain, `${field}.${unexpected}`, 'UNAUTHORIZED_FIELD');
  const missing = required.find(key => !own(value, key));
  if (missing) fail(domain, `${field}.${missing}`, 'REQUIRED');
};

function assertString(
  domain: string,
  field: string,
  value: unknown,
  maximum: number = PRODUCT_LIMITS.indexedTextBytes,
  allowEmpty: boolean = false,
): asserts value is string {
  if (typeof value !== 'string') fail(domain, field, 'STRING_REQUIRED');
  const size = bytes(value);
  if ((!allowEmpty && size === 0) || size > maximum) fail(domain, field, `TEXT_BYTES_${size}_MAX_${maximum}`);
}

const assertOptionalString = (
  domain: string,
  record: Record<string, unknown>,
  field: string,
  maximum: number = PRODUCT_LIMITS.indexedTextBytes,
  allowEmpty: boolean = true,
): void => {
  if (own(record, field)) assertString(domain, field, record[field], maximum, allowEmpty);
};

function assertFiniteNumber(
  domain: string,
  field: string,
  value: unknown,
  integer: boolean = false,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
    fail(domain, field, integer ? 'SAFE_INTEGER_REQUIRED' : 'FINITE_NUMBER_REQUIRED');
  }
}

const assertOptionalNumber = (
  domain: string,
  record: Record<string, unknown>,
  field: string,
  integer = false,
): void => {
  if (own(record, field)) assertFiniteNumber(domain, field, record[field], integer);
};

const assertOptionalBoolean = (domain: string, record: Record<string, unknown>, field: string): void => {
  if (own(record, field) && typeof record[field] !== 'boolean') fail(domain, field, 'BOOLEAN_REQUIRED');
};

function assertStringList(
  domain: string,
  field: string,
  value: unknown,
  maximum: number,
  options: { nonEmpty?: boolean; allowed?: ReadonlySet<string> } = {},
): asserts value is string[] {
  if (!Array.isArray(value)) fail(domain, field, 'LIST_REQUIRED');
  if ((options.nonEmpty && value.length === 0) || value.length > maximum) {
    fail(domain, field, `CARDINALITY_${value.length}_MAX_${maximum}`);
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    assertString(domain, `${field}[${index}]`, entry);
    if (seen.has(entry)) fail(domain, `${field}[${index}]`, 'DUPLICATE');
    if (options.allowed && !options.allowed.has(entry)) fail(domain, `${field}[${index}]`, 'UNKNOWN_VALUE');
    seen.add(entry);
  });
}

const MATERIAL_KEYS = [
  'id', 'code', 'name', 'category', 'unit', 'minimumStock', 'currentStock', 'initialStock',
  'storageLocation', 'primaryStorehouseId', 'storageLocationDetail', 'warehouseStocks',
  'warehouseStocksById', 'notes', 'createdAt', 'updatedAt', 'type', 'manufacturer',
  'productionDate', 'expiryDate', 'hazardLevel',
] as const;

const TRANSACTION_KEYS = [
  'id', 'transactionNumber', 'date', 'itemType', 'itemId', 'itemCode', 'itemName',
  'itemCategory', 'transactionType', 'transferType', 'operationId', 'pairedTransactionId',
  'quantity', 'unit', 'storehouse', 'storehouseId', 'stockBefore', 'stockAfter', 'executedBy',
  'supplierOrReceiver', 'notes', 'attachment', 'createdAt', 'updatedAt',
] as const;

const SETTINGS_SLIM_ROOT_KEYS = [
  'settingsSchemaVersion', 'organizationName', 'departmentName', 'expiryWarningThresholdDays', 'units',
  'storehouses', 'storehouseIds', 'warehouseSchemaVersion', 'cloudSyncEnabled',
  'firebaseInitialized', 'storekeeperName', 'systemManagerName', 'healthDirectorName',
  'storekeeperRole', 'systemManagerRole', 'healthDirectorRole', 'showStorekeeperSignature',
  'showSystemManagerSignature', 'showHealthDirectorSignature', 'transactionCounters',
  'openingStockAttachmentKeys', 'categoryIds', 'partnerIds',
] as const;

/** @deprecated nested monolithic root — rejected for cloud settingsSchemaVersion 3 writes */
const SETTINGS_LEGACY_NESTED_KEYS = [
  'organizationName', 'departmentName', 'expiryWarningThresholdDays', 'categories', 'units',
  'storehouses', 'storehouseEntities', 'storehouseIds', 'warehouseSchemaVersion', 'cloudSyncEnabled',
  'firebaseInitialized', 'storekeeperName', 'systemManagerName', 'healthDirectorName',
  'storekeeperRole', 'systemManagerRole', 'healthDirectorRole', 'showStorekeeperSignature',
  'showSystemManagerSignature', 'showHealthDirectorSignature', 'transactionCounters', 'partners',
  'openingStockAttachment', 'openingStockAttachments', 'openingStockAttachmentKeys',
] as const;

const SETTINGS_CATEGORY_KEYS = ['id', 'name', 'prefix', 'startRange', 'endRange', 'sortOrder', 'active'] as const;
const SETTINGS_WAREHOUSE_KEYS = ['id', 'name', 'active', 'createdAt', 'updatedAt', 'sortOrder'] as const;
const SETTINGS_PARTNER_KEYS = ['id', 'name', 'type', 'phone', 'notes', 'active'] as const;
const SETTINGS_OSA_KEYS = ['key', 'data'] as const;

/** Composed local UI view-model keys (not a cloud document shape). */
const SETTINGS_COMPOSED_KEYS = SETTINGS_LEGACY_NESTED_KEYS;

const USER_KEYS = ['id', 'authUid', 'username', 'fullName', 'role', 'permissions', 'active', 'createdAt'] as const;
const GENERATOR_KEYS = [
  'id', 'date', 'dayName', 'previousReading', 'currentReading', 'operatingHours', 'notes',
  'createdAt', 'updatedAt', 'createdBy',
] as const;
const AUDIT_KEYS = [
  'schemaVersion', 'id', 'action', 'details', 'itemType', 'templateId', 'operationType',
  'primaryEntity', 'outcome',
] as const;

export const KNOWN_PERMISSION_IDS = new Set([
  'dashboard_view', 'materials_view', 'materials_create', 'materials_edit', 'materials_delete',
  'materials_stocktake', 'transactions_view', 'transactions_create', 'transactions_delete',
  'reports_view', 'reports_export', 'reports_print', 'audit_view', 'generator_log',
  'settings_view', 'settings_edit', 'users_manage', 'system_reset',
]);

const assertNumberMap = (
  domain: string,
  field: string,
  value: unknown,
  maximum: number,
): void => {
  if (!isRecord(value)) fail(domain, field, 'MAP_REQUIRED');
  const entries = Object.entries(value);
  if (entries.length > maximum) fail(domain, field, `CARDINALITY_${entries.length}_MAX_${maximum}`);
  for (const [key, nested] of entries) {
    assertString(domain, `${field}.<key>`, key);
    assertFiniteNumber(domain, `${field}.${key}`, nested);
  }
};

const assertMaterial = (data: Record<string, unknown>): void => {
  const domain = 'materials';
  assertKeys(domain, domain, data, MATERIAL_KEYS, ['id', 'name']);
  assertString(domain, 'id', data.id, PRODUCT_LIMITS.documentIdBytes);
  assertString(domain, 'name', data.name);
  for (const field of ['code', 'category', 'unit', 'storageLocation', 'primaryStorehouseId',
    'storageLocationDetail', 'notes', 'type', 'manufacturer', 'hazardLevel']) {
    assertOptionalString(domain, data, field);
  }
  for (const field of ['createdAt', 'updatedAt', 'productionDate', 'expiryDate']) {
    assertOptionalString(domain, data, field, PRODUCT_LIMITS.isoDateBytes);
  }
  for (const field of ['minimumStock', 'currentStock', 'initialStock']) assertOptionalNumber(domain, data, field);
  if (own(data, 'warehouseStocks')) assertNumberMap(domain, 'warehouseStocks', data.warehouseStocks, PRODUCT_LIMITS.warehouseStockEntries);
  if (own(data, 'warehouseStocksById')) assertNumberMap(domain, 'warehouseStocksById', data.warehouseStocksById, PRODUCT_LIMITS.warehouseStockEntries);
};

const TRANSACTION_TYPES = new Set(['وارد', 'صادر', 'مستهلك', 'تحويل', 'تسوية', 'افتتاحي']);
const assertTransaction = (data: Record<string, unknown>): void => {
  const domain = 'transactions';
  assertKeys(domain, domain, data, TRANSACTION_KEYS, ['id', 'date', 'itemId', 'quantity']);
  assertString(domain, 'id', data.id, PRODUCT_LIMITS.documentIdBytes);
  assertString(domain, 'date', data.date, PRODUCT_LIMITS.isoDateBytes);
  assertString(domain, 'itemId', data.itemId, PRODUCT_LIMITS.documentIdBytes);
  assertFiniteNumber(domain, 'quantity', data.quantity);
  for (const field of ['transactionNumber', 'itemType', 'itemCode', 'itemName', 'itemCategory',
    'unit', 'storehouse', 'storehouseId', 'executedBy', 'supplierOrReceiver', 'notes']) {
    assertOptionalString(domain, data, field);
  }
  for (const field of ['operationId', 'pairedTransactionId']) {
    assertOptionalString(domain, data, field, PRODUCT_LIMITS.documentIdBytes);
  }
  for (const field of ['createdAt', 'updatedAt']) assertOptionalString(domain, data, field, PRODUCT_LIMITS.isoDateBytes);
  for (const field of ['stockBefore', 'stockAfter']) assertOptionalNumber(domain, data, field);
  if (own(data, 'transactionType')) {
    assertString(domain, 'transactionType', data.transactionType);
    if (!TRANSACTION_TYPES.has(data.transactionType)) fail(domain, 'transactionType', 'UNKNOWN_VALUE');
  }
  if (own(data, 'transferType') && data.transferType !== 'in' && data.transferType !== 'out') {
    fail(domain, 'transferType', 'UNKNOWN_VALUE');
  }
  assertOptionalString(domain, data, 'attachment', PRODUCT_LIMITS.attachmentBytes);
};

const assertTransactionCountersField = (domain: string, data: Record<string, unknown>): void => {
  if (!own(data, 'transactionCounters')) return;
  if (!isRecord(data.transactionCounters)) fail(domain, 'transactionCounters', 'MAP_REQUIRED');
  assertKeys(domain, 'transactionCounters', data.transactionCounters,
    ['inbound', 'outbound', 'consumed', 'transfer', 'adjustment', 'opening'],
    ['inbound', 'outbound', 'consumed']);
  for (const field of Object.keys(data.transactionCounters)) {
    assertFiniteNumber(domain, `transactionCounters.${field}`, data.transactionCounters[field], true);
    if ((data.transactionCounters[field] as number) < 0) fail(domain, `transactionCounters.${field}`, 'NON_NEGATIVE_REQUIRED');
  }
};

const assertSlimSettingsRoot = (data: Record<string, unknown>): void => {
  const domain = 'settings';
  assertKeys(domain, domain, data, SETTINGS_SLIM_ROOT_KEYS, [
    'settingsSchemaVersion', 'organizationName', 'departmentName', 'expiryWarningThresholdDays',
    'units', 'storehouses', 'storehouseIds', 'warehouseSchemaVersion',
  ]);
  if (data.settingsSchemaVersion !== 3) fail(domain, 'settingsSchemaVersion', 'VERSION_3_REQUIRED');
  assertString(domain, 'organizationName', data.organizationName);
  assertString(domain, 'departmentName', data.departmentName);
  assertFiniteNumber(domain, 'expiryWarningThresholdDays', data.expiryWarningThresholdDays, true);
  if (data.expiryWarningThresholdDays < 0) fail(domain, 'expiryWarningThresholdDays', 'NON_NEGATIVE_REQUIRED');
  assertStringList(domain, 'units', data.units, PRODUCT_LIMITS.units, { nonEmpty: true });
  assertStringList(domain, 'storehouses', data.storehouses, PRODUCT_LIMITS.storehouses, { nonEmpty: true });
  assertStringList(domain, 'storehouseIds', data.storehouseIds, PRODUCT_LIMITS.storehouses, { nonEmpty: true });
  if (data.warehouseSchemaVersion !== 2) fail(domain, 'warehouseSchemaVersion', 'VERSION_2_REQUIRED');
  for (const field of ['cloudSyncEnabled', 'firebaseInitialized', 'showStorekeeperSignature',
    'showSystemManagerSignature', 'showHealthDirectorSignature']) assertOptionalBoolean(domain, data, field);
  for (const field of ['storekeeperName', 'systemManagerName', 'healthDirectorName', 'storekeeperRole',
    'systemManagerRole', 'healthDirectorRole']) assertOptionalString(domain, data, field);
  assertTransactionCountersField(domain, data);
  if (own(data, 'openingStockAttachmentKeys')) {
    assertStringList(domain, 'openingStockAttachmentKeys', data.openingStockAttachmentKeys,
      PRODUCT_LIMITS.openingStockAttachments);
  }
  if (own(data, 'categoryIds')) {
    assertStringList(domain, 'categoryIds', data.categoryIds, PRODUCT_LIMITS.categories, { nonEmpty: true });
  }
  if (own(data, 'partnerIds')) {
    assertStringList(domain, 'partnerIds', data.partnerIds, PRODUCT_LIMITS.partners);
  }
  for (const forbidden of ['categories', 'partners', 'storehouseEntities', 'openingStockAttachments', 'openingStockAttachment']) {
    if (own(data, forbidden)) fail(domain, forbidden, 'NESTED_FORBIDDEN_ON_SLIM_ROOT');
  }
  const totalBytes = bytes(JSON.stringify(data));
  if (totalBytes > PRODUCT_LIMITS.settingsDocumentBytes) {
    fail(domain, domain, `DOCUMENT_BYTES_${totalBytes}_MAX_${PRODUCT_LIMITS.settingsDocumentBytes}`);
  }
};

const assertSettingsCategoryDoc = (data: Record<string, unknown>): void => {
  const domain = 'settings';
  assertKeys(domain, domain, data, SETTINGS_CATEGORY_KEYS, ['id', 'name', 'prefix', 'startRange', 'endRange']);
  assertString(domain, 'id', data.id, PRODUCT_LIMITS.documentIdBytes);
  assertString(domain, 'name', data.name);
  assertString(domain, 'prefix', data.prefix);
  assertFiniteNumber(domain, 'startRange', data.startRange, true);
  assertFiniteNumber(domain, 'endRange', data.endRange, true);
  if ((data.startRange as number) > (data.endRange as number)) fail(domain, 'startRange', 'INVALID_RANGE');
  assertOptionalNumber(domain, data, 'sortOrder', true);
  assertOptionalBoolean(domain, data, 'active');
};

const assertSettingsWarehouseDoc = (data: Record<string, unknown>): void => {
  const domain = 'settings';
  assertKeys(domain, domain, data, SETTINGS_WAREHOUSE_KEYS, ['id', 'name', 'active']);
  assertString(domain, 'id', data.id, PRODUCT_LIMITS.documentIdBytes);
  assertString(domain, 'name', data.name);
  if (typeof data.active !== 'boolean') fail(domain, 'active', 'BOOLEAN_REQUIRED');
  assertOptionalString(domain, data, 'createdAt', PRODUCT_LIMITS.isoDateBytes);
  assertOptionalString(domain, data, 'updatedAt', PRODUCT_LIMITS.isoDateBytes);
  assertOptionalNumber(domain, data, 'sortOrder', true);
};

const assertSettingsPartnerDoc = (data: Record<string, unknown>): void => {
  const domain = 'settings';
  assertKeys(domain, domain, data, SETTINGS_PARTNER_KEYS, ['id', 'name', 'type']);
  assertString(domain, 'id', data.id, PRODUCT_LIMITS.documentIdBytes);
  assertString(domain, 'name', data.name);
  if (!['مورد', 'جهة مستلمة', 'أخرى'].includes(String(data.type))) fail(domain, 'type', 'UNKNOWN_VALUE');
  assertOptionalString(domain, data, 'phone');
  assertOptionalString(domain, data, 'notes');
  assertOptionalBoolean(domain, data, 'active');
};

const assertSettingsOpeningAttachmentDoc = (data: Record<string, unknown>): void => {
  const domain = 'settings';
  assertKeys(domain, domain, data, SETTINGS_OSA_KEYS, ['key', 'data']);
  assertString(domain, 'key', data.key);
  assertString(domain, 'data', data.data, PRODUCT_LIMITS.attachmentBytes, true);
};

/** Local composed AppSettings view-model (categories/partners/entities/attachments). Not cloud root. */
export const assertComposedSettingsViewModel = (data: Record<string, unknown>): void => {
  const domain = 'settings';
  assertKeys(domain, domain, data, SETTINGS_COMPOSED_KEYS, [
    'organizationName', 'departmentName', 'expiryWarningThresholdDays', 'categories', 'units', 'storehouses',
  ]);
  assertString(domain, 'organizationName', data.organizationName);
  assertString(domain, 'departmentName', data.departmentName);
  assertFiniteNumber(domain, 'expiryWarningThresholdDays', data.expiryWarningThresholdDays, true);
  if (data.expiryWarningThresholdDays < 0) fail(domain, 'expiryWarningThresholdDays', 'NON_NEGATIVE_REQUIRED');

  if (!Array.isArray(data.categories) || data.categories.length === 0
    || data.categories.length > PRODUCT_LIMITS.categories) {
    fail(domain, 'categories', `CARDINALITY_${Array.isArray(data.categories) ? data.categories.length : 'INVALID'}_MAX_${PRODUCT_LIMITS.categories}`);
  }
  const categoryNames = new Set<string>();
  data.categories.forEach((entry, index) => {
    if (!isRecord(entry)) fail(domain, `categories[${index}]`, 'MAP_REQUIRED');
    assertKeys(domain, `categories[${index}]`, entry, ['name', 'prefix', 'startRange', 'endRange'], ['name', 'prefix', 'startRange', 'endRange']);
    assertString(domain, `categories[${index}].name`, entry.name);
    assertString(domain, `categories[${index}].prefix`, entry.prefix);
    assertFiniteNumber(domain, `categories[${index}].startRange`, entry.startRange, true);
    assertFiniteNumber(domain, `categories[${index}].endRange`, entry.endRange, true);
    if (entry.startRange > entry.endRange) fail(domain, `categories[${index}]`, 'INVALID_RANGE');
    if (categoryNames.has(entry.name)) fail(domain, `categories[${index}].name`, 'DUPLICATE');
    categoryNames.add(entry.name);
  });

  assertStringList(domain, 'units', data.units, PRODUCT_LIMITS.units, { nonEmpty: true });
  assertStringList(domain, 'storehouses', data.storehouses, PRODUCT_LIMITS.storehouses, { nonEmpty: true });
  if (own(data, 'storehouseEntities')) {
    if (!Array.isArray(data.storehouseEntities) || data.storehouseEntities.length === 0
      || data.storehouseEntities.length > PRODUCT_LIMITS.storehouses) {
      fail(domain, 'storehouseEntities', `CARDINALITY_MAX_${PRODUCT_LIMITS.storehouses}`);
    }
    const ids = new Set<string>();
    const names = new Set<string>();
    data.storehouseEntities.forEach((entry, index) => {
      if (!isRecord(entry)) fail(domain, `storehouseEntities[${index}]`, 'MAP_REQUIRED');
      assertKeys(domain, `storehouseEntities[${index}]`, entry,
        ['id', 'name', 'active', 'createdAt', 'updatedAt'], ['id', 'name', 'active']);
      assertString(domain, `storehouseEntities[${index}].id`, entry.id, PRODUCT_LIMITS.documentIdBytes);
      assertString(domain, `storehouseEntities[${index}].name`, entry.name);
      if (typeof entry.active !== 'boolean') fail(domain, `storehouseEntities[${index}].active`, 'BOOLEAN_REQUIRED');
      assertOptionalString(domain, entry, 'createdAt', PRODUCT_LIMITS.isoDateBytes);
      assertOptionalString(domain, entry, 'updatedAt', PRODUCT_LIMITS.isoDateBytes);
      if (ids.has(entry.id)) fail(domain, `storehouseEntities[${index}].id`, 'DUPLICATE');
      if (names.has(entry.name)) fail(domain, `storehouseEntities[${index}].name`, 'DUPLICATE');
      ids.add(entry.id);
      names.add(entry.name);
    });
    const activeNames = data.storehouseEntities
      .filter(entry => isRecord(entry) && entry.active === true)
      .map(entry => (entry as Record<string, unknown>).name);
    if (JSON.stringify(activeNames) !== JSON.stringify(data.storehouses)) {
      fail(domain, 'storehouses', 'ACTIVE_ENTITY_PROJECTION_MISMATCH');
    }
    assertStringList(domain, 'storehouseIds', data.storehouseIds, PRODUCT_LIMITS.storehouses, { nonEmpty: true });
    const projectedIds = data.storehouseEntities.map(entry => (entry as Record<string, unknown>).id);
    if (JSON.stringify(projectedIds) !== JSON.stringify(data.storehouseIds)) {
      fail(domain, 'storehouseIds', 'ENTITY_PROJECTION_MISMATCH');
    }
  } else if (own(data, 'storehouseIds')) {
    fail(domain, 'storehouseIds', 'ENTITIES_REQUIRED');
  }

  if (own(data, 'warehouseSchemaVersion') && data.warehouseSchemaVersion !== 2) fail(domain, 'warehouseSchemaVersion', 'VERSION_2_REQUIRED');
  for (const field of ['cloudSyncEnabled', 'firebaseInitialized', 'showStorekeeperSignature',
    'showSystemManagerSignature', 'showHealthDirectorSignature']) assertOptionalBoolean(domain, data, field);
  for (const field of ['storekeeperName', 'systemManagerName', 'healthDirectorName', 'storekeeperRole',
    'systemManagerRole', 'healthDirectorRole']) assertOptionalString(domain, data, field);

  assertTransactionCountersField(domain, data);

  if (own(data, 'partners')) {
    if (!Array.isArray(data.partners) || data.partners.length > PRODUCT_LIMITS.partners) {
      fail(domain, 'partners', `CARDINALITY_MAX_${PRODUCT_LIMITS.partners}`);
    }
    const ids = new Set<string>();
    data.partners.forEach((entry, index) => {
      if (!isRecord(entry)) fail(domain, `partners[${index}]`, 'MAP_REQUIRED');
      assertKeys(domain, `partners[${index}]`, entry, ['id', 'name', 'type', 'phone', 'notes'], ['id', 'name', 'type']);
      assertString(domain, `partners[${index}].id`, entry.id, PRODUCT_LIMITS.documentIdBytes);
      assertString(domain, `partners[${index}].name`, entry.name);
      if (!['مورد', 'جهة مستلمة', 'أخرى'].includes(String(entry.type))) fail(domain, `partners[${index}].type`, 'UNKNOWN_VALUE');
      assertOptionalString(domain, entry, 'phone');
      assertOptionalString(domain, entry, 'notes');
      if (ids.has(entry.id)) fail(domain, `partners[${index}].id`, 'DUPLICATE');
      ids.add(entry.id);
    });
  }

  assertOptionalString(domain, data, 'openingStockAttachment', PRODUCT_LIMITS.attachmentBytes);
  const hasAttachments = own(data, 'openingStockAttachments');
  const hasAttachmentKeys = own(data, 'openingStockAttachmentKeys');
  if (hasAttachments !== hasAttachmentKeys) fail(domain, 'openingStockAttachments', 'KEY_MANIFEST_REQUIRED');
  if (hasAttachments) {
    if (!isRecord(data.openingStockAttachments)) fail(domain, 'openingStockAttachments', 'MAP_REQUIRED');
    assertStringList(domain, 'openingStockAttachmentKeys', data.openingStockAttachmentKeys,
      PRODUCT_LIMITS.openingStockAttachments);
    const mapKeys = Object.keys(data.openingStockAttachments).sort();
    const manifest = [...(data.openingStockAttachmentKeys as string[])].sort();
    if (JSON.stringify(mapKeys) !== JSON.stringify(manifest)) fail(domain, 'openingStockAttachments', 'KEY_MANIFEST_MISMATCH');
    for (const key of mapKeys) {
      assertString(domain, 'openingStockAttachments.<key>', key);
      assertString(domain, `openingStockAttachments.${key}`, data.openingStockAttachments[key], PRODUCT_LIMITS.attachmentBytes);
    }
  }

  const totalBytes = bytes(JSON.stringify(data));
  if (totalBytes > PRODUCT_LIMITS.settingsDocumentBytes) {
    fail(domain, domain, `DOCUMENT_BYTES_${totalBytes}_MAX_${PRODUCT_LIMITS.settingsDocumentBytes}`);
  }
};

export const assertSettingsDocumentProof = (
  docId: string,
  data: Record<string, unknown>,
  options: { allowLegacyNestedBaseline?: boolean } = {},
): void => {
  if (docId === 'app_config') {
    if (data.settingsSchemaVersion === 3) {
      assertSlimSettingsRoot(data);
      return;
    }
    if (options.allowLegacyNestedBaseline) {
      assertComposedSettingsViewModel(data);
      return;
    }
    fail('settings', 'settingsSchemaVersion', 'VERSION_3_REQUIRED');
  }
  if (docId.startsWith('cat_')) {
    assertSettingsCategoryDoc(data);
    if (docId !== `cat_${String(data.id)}`) fail('settings', 'id', 'PATH_PAYLOAD_IDENTITY_MISMATCH');
    return;
  }
  if (docId.startsWith('wh_')) {
    assertSettingsWarehouseDoc(data);
    // Single-form only: docId == 'wh_' + payload.id
    if (docId !== `wh_${String(data.id)}`) {
      fail('settings', 'id', 'PATH_PAYLOAD_IDENTITY_MISMATCH');
    }
    return;
  }
  if (docId.startsWith('partner_')) {
    assertSettingsPartnerDoc(data);
    // Single-form only: docId == 'partner_' + payload.id
    if (docId !== `partner_${String(data.id)}`) {
      fail('settings', 'id', 'PATH_PAYLOAD_IDENTITY_MISMATCH');
    }
    return;
  }
  if (docId.startsWith('osa_')) {
    assertSettingsOpeningAttachmentDoc(data);
    if (docId !== `osa_${String(data.key)}`) fail('settings', 'key', 'PATH_PAYLOAD_IDENTITY_MISMATCH');
    return;
  }
  fail('settings', 'docId', 'UNKNOWN_SETTINGS_DOC_KIND');
};

const assertSettings = (data: Record<string, unknown>): void => {
  // Collection-only callers: slim root when versioned, else composed local view-model.
  if (data.settingsSchemaVersion === 3) {
    assertSlimSettingsRoot(data);
    return;
  }
  assertComposedSettingsViewModel(data);
};

const assertUser = (data: Record<string, unknown>): void => {
  const domain = 'users';
  assertKeys(domain, domain, data, USER_KEYS, USER_KEYS);
  assertString(domain, 'id', data.id, PRODUCT_LIMITS.documentIdBytes);
  assertString(domain, 'authUid', data.authUid, PRODUCT_LIMITS.documentIdBytes);
  assertString(domain, 'username', data.username);
  assertString(domain, 'fullName', data.fullName);
  assertString(domain, 'role', data.role);
  assertStringList(domain, 'permissions', data.permissions, PRODUCT_LIMITS.permissions, {
    nonEmpty: true,
    allowed: KNOWN_PERMISSION_IDS,
  });
  if (typeof data.active !== 'boolean') fail(domain, 'active', 'BOOLEAN_REQUIRED');
  assertString(domain, 'createdAt', data.createdAt, PRODUCT_LIMITS.isoDateBytes);
};

export function assertLegacyUserProofPayload(
  payload: unknown,
): asserts payload is Record<string, unknown> {
  const domain = 'users';
  if (!isRecord(payload)) fail(domain, domain, 'MAP_REQUIRED');
  assertKeys(domain, domain, payload, USER_KEYS, [
    'id', 'username', 'fullName', 'role', 'permissions', 'createdAt',
  ]);
  assertString(domain, 'id', payload.id, PRODUCT_LIMITS.documentIdBytes);
  if (own(payload, 'authUid')) assertString(domain, 'authUid', payload.authUid, PRODUCT_LIMITS.documentIdBytes);
  assertString(domain, 'username', payload.username);
  assertString(domain, 'fullName', payload.fullName);
  assertString(domain, 'role', payload.role);
  assertStringList(domain, 'permissions', payload.permissions, PRODUCT_LIMITS.permissions, {
    nonEmpty: true,
    allowed: KNOWN_PERMISSION_IDS,
  });
  if (own(payload, 'active') && typeof payload.active !== 'boolean') fail(domain, 'active', 'BOOLEAN_REQUIRED');
  assertString(domain, 'createdAt', payload.createdAt, PRODUCT_LIMITS.isoDateBytes);
}

const assertGeneratorLog = (data: Record<string, unknown>): void => {
  const domain = 'generator_logs';
  assertKeys(domain, domain, data, GENERATOR_KEYS, [
    'id', 'date', 'dayName', 'previousReading', 'currentReading', 'operatingHours', 'createdAt', 'updatedAt', 'createdBy',
  ]);
  assertString(domain, 'id', data.id, PRODUCT_LIMITS.documentIdBytes);
  assertString(domain, 'date', data.date, PRODUCT_LIMITS.isoDateBytes);
  assertString(domain, 'dayName', data.dayName);
  assertFiniteNumber(domain, 'previousReading', data.previousReading);
  assertFiniteNumber(domain, 'currentReading', data.currentReading);
  assertFiniteNumber(domain, 'operatingHours', data.operatingHours);
  assertOptionalString(domain, data, 'notes');
  assertString(domain, 'createdAt', data.createdAt, PRODUCT_LIMITS.isoDateBytes);
  assertString(domain, 'updatedAt', data.updatedAt, PRODUCT_LIMITS.isoDateBytes);
  assertString(domain, 'createdBy', data.createdBy);
};

const assertAudit = (data: Record<string, unknown>): void => {
  const domain = 'audit_logs';
  assertKeys(domain, domain, data, AUDIT_KEYS, [
    'schemaVersion', 'id', 'action', 'details', 'templateId', 'operationType', 'primaryEntity', 'outcome',
  ]);
  if (data.schemaVersion !== 3) fail(domain, 'schemaVersion', 'VERSION_3_REQUIRED');
  assertString(domain, 'id', data.id, 256);
  for (const field of ['action', 'details', 'templateId', 'operationType', 'primaryEntity', 'outcome']) {
    assertString(domain, field, data[field]);
  }
  assertOptionalString(domain, data, 'itemType');
};

export function assertDomainProofPayload(
  domain: string,
  payload: unknown,
): asserts payload is Record<string, unknown> {
  if (!isRecord(payload)) fail(domain, domain, 'MAP_REQUIRED');
  switch (domain as ReceiptProofDomain) {
    case 'materials': assertMaterial(payload); return;
    case 'transactions': assertTransaction(payload); return;
    case 'settings': assertSettings(payload); return;
    case 'users': assertUser(payload); return;
    case 'generator_logs': assertGeneratorLog(payload); return;
    case 'audit_logs': assertAudit(payload); return;
    default: fail(domain, domain, 'UNSUPPORTED_DOMAIN');
  }
}

export const withSettingsAttachmentManifest = <T extends { openingStockAttachments?: unknown; openingStockAttachmentKeys?: unknown }>(settings: T): T => {
  if (!isRecord(settings.openingStockAttachments)) {
    const { openingStockAttachmentKeys: _unused, ...withoutManifest } = settings;
    return withoutManifest as T;
  }
  return {
    ...settings,
    openingStockAttachmentKeys: Object.keys(settings.openingStockAttachments).sort(),
  };
};

/** Closed token class for the schema domain/field/reason segments (they come from code, never from user data). */
const SCHEMA_TOKEN = '[A-Za-z0-9_.\\[\\]-]{1,60}';
const MAX_ECHOED_SCHEMA_REASON = 48;
/**
 * PREPROD rework #3 (OBS-23 / R2-PP-16): the only user-controlled part of a rejected key path is a key taken from an imported object
 * (`<known base>.<unexpected key>`, `openingStockAttachments.<key>`, `transactionCounters.<key>`). The earlier "token-shape" heuristics
 * were dead for such short nested keys, so the echo is now a CLOSED allowlist: a path segment is shown only if it is one of the
 * schema's own field names (optionally with a numeric index); the first unknown segment, and everything after it, is replaced by `…`.
 * No imported key text is ever echoed, whatever its shape.
 */
export const KNOWN_SCHEMA_DOMAINS: ReadonlySet<string> = new Set(['materials', 'transactions', 'settings', 'users', 'generator_logs', 'audit_logs']);
export const KNOWN_SCHEMA_FIELD_NAMES: ReadonlySet<string> = new Set<string>([
  ...MATERIAL_KEYS, ...TRANSACTION_KEYS, ...SETTINGS_SLIM_ROOT_KEYS, ...SETTINGS_LEGACY_NESTED_KEYS, ...SETTINGS_CATEGORY_KEYS,
  ...SETTINGS_WAREHOUSE_KEYS, ...SETTINGS_PARTNER_KEYS, ...SETTINGS_OSA_KEYS, ...USER_KEYS, ...GENERATOR_KEYS, ...AUDIT_KEYS,
  'inbound', 'outbound', 'consumed', 'transfer', 'adjustment', 'opening',
  'attachment', 'categoryIds', 'createdBy', 'currentReading', 'data', 'date', 'dayName', 'docId', 'endRange', 'itemId', 'itemType',
  'key', 'operatingHours', 'partnerIds', 'phone', 'prefix', 'previousReading', 'quantity', 'schemaVersion', 'sortOrder', 'startRange',
  'transactionType', 'transferType', 'units', 'username', 'warehouseStocks', 'warehouseStocksById',
]);
const SCHEMA_INDEX_SUFFIX = /\[\d{1,4}\]$/;
/** Returns the schema key path with every non-schema segment masked, e.g. `materials.<imported key>` → `materials.…`. */
export const maskSchemaKeyPath = (field: string): string => {
  const out: string[] = [];
  for (const segment of field.split('.')) {
    if (KNOWN_SCHEMA_FIELD_NAMES.has(segment.replace(SCHEMA_INDEX_SUFFIX, '')) || (out.length === 0 && KNOWN_SCHEMA_DOMAINS.has(segment))) out.push(segment);
    else { out.push('…'); break; }
  }
  return out.join('.');
};
/** The reason is always built by this module (it may contain a byte/cardinality count such as `DOCUMENT_BYTES_1048577_MAX_1048576`), never from a key. */
const isOrdinarySchemaReason = (segment: string): boolean =>
  segment.length <= MAX_ECHOED_SCHEMA_REASON && /^[A-Za-z][A-Za-z0-9_-]*$/.test(segment);
const PRODUCT_SCHEMA_REJECTION = new RegExp(`^PRODUCT_SCHEMA_REJECTED:(${SCHEMA_TOKEN}):(${SCHEMA_TOKEN}):(${SCHEMA_TOKEN})$`);

/**
 * User-facing text for an import/save failure. A product-schema rejection keeps its readable Arabic explanation (only the closed
 * domain/field/reason tokens are echoed); EVERY other error (Firestore/SDK/queue/XLSX-library text, paths, e-mails, tokens)
 * is converted to fixed Arabic text by `safeUserMessage` and never returned raw (PREPROD rework #1, R2-PP-01).
 */
export const productLimitMessage = (error: unknown): string => {
  let raw: string | null = null;
  try {
    raw = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  } catch {
    raw = null;
  }
  const match = raw === null ? null : PRODUCT_SCHEMA_REJECTION.exec(raw);
  if (match) {
    const [, domain, field, reason] = match;
    // PREPROD rework #3 (OBS-23): domain/path are echoed only as schema-owned names (see maskSchemaKeyPath); imported key text never is.
    if (KNOWN_SCHEMA_DOMAINS.has(domain) && isOrdinarySchemaReason(reason)) {
      return `تجاوزت البيانات عقد P7 المعتمد (${domain}/${maskSchemaKeyPath(field)}: ${reason}). لم تُحفظ أو تُقتطع أي قيمة.`;
    }
    return 'تجاوزت البيانات عقد P7 المعتمد (تفاصيل الحقل غير معروضة). لم تُحفظ أو تُقتطع أي قيمة.';
  }
  return safeUserMessage(error, 'import', { allowAppText: true });
};
