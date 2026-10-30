/**
 * P7 settingsSchemaVersion 3 — targeted normalization helpers.
 * Local UI keeps a composed AppSettings view-model; cloud durability uses slim root + typed children.
 */
import type { AppSettings, CategoryConfig, PartnerEntity, Storehouse } from '../types';
import { PRODUCT_LIMITS } from './productSchema';

export const SETTINGS_SCHEMA_VERSION = 3 as const;
export const SETTINGS_ROOT_DOC_ID = 'app_config';

const DOC_ID_SAFE = /^[A-Za-z0-9._:-]{1,180}$/;

export type SettingsDocKind =
  | 'app_config'
  | 'category'
  | 'warehouse'
  | 'partner'
  | 'opening_attachment';

export const settingsDocKind = (docId: string): SettingsDocKind | null => {
  if (docId === SETTINGS_ROOT_DOC_ID) return 'app_config';
  if (docId.startsWith('cat_')) return 'category';
  if (docId.startsWith('wh_')) return 'warehouse';
  if (docId.startsWith('partner_')) return 'partner';
  if (docId.startsWith('osa_')) return 'opening_attachment';
  return null;
};

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/** Deterministic Rules-safe doc id under prefix (max 180). */
export const settingsChildDocId = (prefix: 'cat_' | 'wh_' | 'partner_' | 'osa_', raw: string): string => {
  const compact = String(raw || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 160);
  const body = compact && /[A-Za-z0-9]/.test(compact) ? compact : `h${fnv1a(String(raw || ''))}`;
  let id = `${prefix}${body}`;
  if (id.length > 180 || !DOC_ID_SAFE.test(id)) id = `${prefix}h${fnv1a(String(raw || ''))}`;
  if (!DOC_ID_SAFE.test(id)) throw new Error(`SETTINGS_DOC_ID_INVALID:${prefix}`);
  return id;
};

export const categoryDocId = (category: CategoryConfig | string): string => {
  if (typeof category === 'string') return settingsChildDocId('cat_', category);
  const named = (category as CategoryConfig & { id?: string }).id;
  return settingsChildDocId('cat_', named && named.trim() ? named : category.name);
};

export const warehouseDocId = (entity: Storehouse | string): string => {
  const id = typeof entity === 'string' ? entity : entity.id;
  // Single-form contract: docId is ALWAYS 'wh_' + logical payload.id (no early-return collapse).
  const generated = settingsChildDocId('wh_', id);
  // Path↔payload binding requires docId == 'wh_' + payload.id (no silent sanitize/hash).
  if (generated !== `wh_${id}`) {
    throw new Error(`SETTINGS_WAREHOUSE_ID_NOT_IDENTITY_SAFE:${id}`);
  }
  return generated;
};

export const partnerDocId = (partner: PartnerEntity | string): string => {
  const id = typeof partner === 'string' ? partner : partner.id;
  // Single-form contract: docId is ALWAYS 'partner_' + logical payload.id (no early-return collapse).
  const generated = settingsChildDocId('partner_', id);
  if (generated !== `partner_${id}`) {
    throw new Error(`SETTINGS_PARTNER_ID_NOT_IDENTITY_SAFE:${id}`);
  }
  return generated;
};

export const openingAttachmentDocId = (key: string): string => {
  const generated = settingsChildDocId('osa_', key);
  // Rules bind docId == 'osa_' + payload.key exactly; reject lossy sanitize/hash.
  if (generated !== `osa_${key}`) {
    throw new Error(`SETTINGS_OSA_KEY_NOT_IDENTITY_SAFE:${key}`);
  }
  return generated;
};

/**
 * Canonical matrix key for warehouse×category opening attachments.
 * Uses warehouse logical id + category doc-body so the key is Rules-safe and
 * satisfies docId == 'osa_' + key without Unicode/space sanitization.
 */
export const openingAttachmentMatrixKey = (
  warehouseId: string,
  category: CategoryConfig | string,
): string => {
  const wh = String(warehouseId || '').trim();
  const catBody = categoryDocId(category).slice('cat_'.length);
  const key = `${wh}--${catBody}`;
  return openingAttachmentDocId(key).slice('osa_'.length);
};

/** Fail-closed path↔payload identity check (mirrors firestore.rules binders). */
export const assertTypedSettingsPathPayloadBound = (
  docId: string,
  payload: Record<string, unknown>,
): void => {
  const kind = settingsDocKind(docId);
  if (kind === 'category') {
    if (docId !== `cat_${String(payload.id)}`) {
      throw new Error(`SETTINGS_IDENTITY_MISMATCH:category:${docId}:${String(payload.id)}`);
    }
    return;
  }
  if (kind === 'warehouse') {
    const id = String(payload.id);
    // Single-form only: docId == 'wh_' + payload.id (reject docId == id collapse).
    if (docId !== `wh_${id}`) {
      throw new Error(`SETTINGS_IDENTITY_MISMATCH:warehouse:${docId}:${id}`);
    }
    return;
  }
  if (kind === 'partner') {
    const id = String(payload.id);
    // Single-form only: docId == 'partner_' + payload.id (reject docId == id collapse).
    if (docId !== `partner_${id}`) {
      throw new Error(`SETTINGS_IDENTITY_MISMATCH:partner:${docId}:${id}`);
    }
    return;
  }
  if (kind === 'opening_attachment') {
    if (docId !== `osa_${String(payload.key)}`) {
      throw new Error(`SETTINGS_IDENTITY_MISMATCH:opening_attachment:${docId}:${String(payload.key)}`);
    }
    return;
  }
  throw new Error(`SETTINGS_IDENTITY_MISMATCH:unknown:${docId}`);
};

export const NESTED_SETTINGS_ROOT_FORBIDDEN = [
  'categories',
  'partners',
  'storehouseEntities',
  'openingStockAttachments',
  'openingStockAttachment',
] as const;

export const hasNestedLegacySettingsKeys = (data: Record<string, unknown>): boolean =>
  NESTED_SETTINGS_ROOT_FORBIDDEN.some(key => Object.prototype.hasOwnProperty.call(data, key));

export const SLIM_SETTINGS_ROOT_KEYS = [
  'settingsSchemaVersion',
  'organizationName', 'departmentName', 'expiryWarningThresholdDays', 'units',
  'storehouses', 'storehouseIds', 'warehouseSchemaVersion', 'cloudSyncEnabled',
  'firebaseInitialized', 'storekeeperName', 'systemManagerName', 'healthDirectorName',
  'storekeeperRole', 'systemManagerRole', 'healthDirectorRole', 'showStorekeeperSignature',
  'showSystemManagerSignature', 'showHealthDirectorSignature', 'transactionCounters',
  'openingStockAttachmentKeys', 'categoryIds', 'partnerIds',
] as const;

/** Strip nested aggregates for cloud root durability (settingsSchemaVersion 3). */
export const toSlimSettingsRoot = (settings: AppSettings): Record<string, unknown> => {
  const keys = Array.isArray(settings.openingStockAttachmentKeys)
    ? [...settings.openingStockAttachmentKeys].sort()
    : (settings.openingStockAttachments
      ? Object.keys(settings.openingStockAttachments).sort()
      : undefined);
  const categoryIds = Array.isArray(settings.categories)
    ? settings.categories.map(category => categoryDocId(category))
    : undefined;
  const partnerIds = Array.isArray(settings.partners)
    ? settings.partners.map(partner => partnerDocId(partner))
    : undefined;
  const slim: Record<string, unknown> = {
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    organizationName: settings.organizationName,
    departmentName: settings.departmentName,
    expiryWarningThresholdDays: settings.expiryWarningThresholdDays,
    units: settings.units,
    storehouses: settings.storehouses,
    warehouseSchemaVersion: settings.warehouseSchemaVersion ?? 2,
  };
  if (Array.isArray(settings.storehouseIds)) slim.storehouseIds = settings.storehouseIds;
  if (settings.cloudSyncEnabled !== undefined) slim.cloudSyncEnabled = settings.cloudSyncEnabled;
  if (settings.firebaseInitialized !== undefined) slim.firebaseInitialized = settings.firebaseInitialized;
  for (const field of [
    'storekeeperName', 'systemManagerName', 'healthDirectorName',
    'storekeeperRole', 'systemManagerRole', 'healthDirectorRole',
  ] as const) {
    if (settings[field] !== undefined) slim[field] = settings[field];
  }
  for (const field of [
    'showStorekeeperSignature', 'showSystemManagerSignature', 'showHealthDirectorSignature',
  ] as const) {
    if (settings[field] !== undefined) slim[field] = settings[field];
  }
  if (settings.transactionCounters) slim.transactionCounters = settings.transactionCounters;
  if (keys && keys.length > 0) slim.openingStockAttachmentKeys = keys;
  if (categoryIds && categoryIds.length > 0) slim.categoryIds = categoryIds;
  if (partnerIds && partnerIds.length > 0) slim.partnerIds = partnerIds;
  return slim;
};

export const categoryCloudPayload = (category: CategoryConfig, sortOrder?: number): Record<string, unknown> => {
  const id = categoryDocId(category).slice('cat_'.length);
  const payload: Record<string, unknown> = {
    id,
    name: category.name,
    prefix: category.prefix,
    startRange: category.startRange,
    endRange: category.endRange,
    active: true,
  };
  if (sortOrder !== undefined) payload.sortOrder = sortOrder;
  return payload;
};

export const warehouseCloudPayload = (entity: Storehouse, sortOrder?: number): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    id: entity.id,
    name: entity.name,
    active: entity.active,
  };
  if (entity.createdAt) payload.createdAt = entity.createdAt;
  if (entity.updatedAt) payload.updatedAt = entity.updatedAt;
  if (sortOrder !== undefined) payload.sortOrder = sortOrder;
  return payload;
};

export const partnerCloudPayload = (partner: PartnerEntity): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    id: partner.id,
    name: partner.name,
    type: partner.type,
    active: true,
  };
  if (partner.phone !== undefined) payload.phone = partner.phone;
  if (partner.notes !== undefined) payload.notes = partner.notes;
  return payload;
};

export const openingAttachmentCloudPayload = (key: string, data: string): Record<string, unknown> => ({
  key,
  data,
});

export interface TypedSettingsChildren {
  categories: Array<{ docId: string; payload: Record<string, unknown> }>;
  warehouses: Array<{ docId: string; payload: Record<string, unknown> }>;
  partners: Array<{ docId: string; payload: Record<string, unknown> }>;
  attachments: Array<{ docId: string; payload: Record<string, unknown> }>;
}

/** Deterministic extract of typed children from a composed (possibly nested v2) settings object. */
export const extractTypedSettingsChildren = (settings: AppSettings): TypedSettingsChildren => {
  const categories = (settings.categories || []).map((category, index) => ({
    docId: categoryDocId(category),
    payload: categoryCloudPayload(category, index),
  }));
  const warehouses = (settings.storehouseEntities || []).map((entity, index) => ({
    docId: warehouseDocId(entity),
    payload: warehouseCloudPayload(entity, index),
  }));
  const partners = (settings.partners || []).map(partner => ({
    docId: partnerDocId(partner),
    payload: partnerCloudPayload(partner),
  }));
  const map = settings.openingStockAttachments || {};
  const keys = Array.isArray(settings.openingStockAttachmentKeys)
    ? settings.openingStockAttachmentKeys
    : Object.keys(map);
  const attachments = keys
    .filter(key => typeof map[key] === 'string')
    .map(key => ({
      docId: openingAttachmentDocId(key),
      payload: openingAttachmentCloudPayload(key, map[key]),
    }));
  // Quarantine singular legacy blob into one osa_* when map is empty.
  if (
    attachments.length === 0
    && typeof settings.openingStockAttachment === 'string'
    && settings.openingStockAttachment.length > 0
  ) {
    const key = 'legacy-singular';
    attachments.push({
      docId: openingAttachmentDocId(key),
      payload: openingAttachmentCloudPayload(key, settings.openingStockAttachment),
    });
  }
  const allEntries = [...categories, ...warehouses, ...partners, ...attachments];
  const seenDocIds = new Map<string, string>();
  for (const entry of allEntries) {
    assertTypedSettingsPathPayloadBound(entry.docId, entry.payload);
    const logical = entry.docId.startsWith('osa_')
      ? `key:${String(entry.payload.key)}`
      : `id:${String(entry.payload.id)}`;
    const prior = seenDocIds.get(entry.docId);
    if (prior !== undefined) {
      throw new Error(
        `SETTINGS_TYPED_DOC_ID_COLLISION:${entry.docId}:${prior}:${logical}`,
      );
    }
    seenDocIds.set(entry.docId, logical);
  }
  if (categories.length > PRODUCT_LIMITS.categories) {
    throw new Error(`SETTINGS_MIGRATE_REJECTED:categories:CARDINALITY_${categories.length}`);
  }
  if (warehouses.length > PRODUCT_LIMITS.storehouses) {
    throw new Error(`SETTINGS_MIGRATE_REJECTED:warehouses:CARDINALITY_${warehouses.length}`);
  }
  if (partners.length > PRODUCT_LIMITS.partners) {
    throw new Error(`SETTINGS_MIGRATE_REJECTED:partners:CARDINALITY_${partners.length}`);
  }
  if (attachments.length > PRODUCT_LIMITS.openingStockAttachments) {
    throw new Error(`SETTINGS_MIGRATE_REJECTED:attachments:CARDINALITY_${attachments.length}`);
  }
  return { categories, warehouses, partners, attachments };
};

/** Compose UI AppSettings from slim root + typed child payloads (no silent truncation). */
export const composeAppSettingsFromNormalized = (
  root: Record<string, unknown>,
  children: TypedSettingsChildren,
): AppSettings => {
  const categories = children.categories
    .filter(entry => entry.payload.active !== false)
    .map(entry => ({
      name: String(entry.payload.name),
      prefix: String(entry.payload.prefix),
      startRange: Number(entry.payload.startRange),
      endRange: Number(entry.payload.endRange),
    }));
  const storehouseEntities = children.warehouses.map(entry => ({
    id: String(entry.payload.id),
    name: String(entry.payload.name),
    active: Boolean(entry.payload.active),
    ...(entry.payload.createdAt ? { createdAt: String(entry.payload.createdAt) } : {}),
    ...(entry.payload.updatedAt ? { updatedAt: String(entry.payload.updatedAt) } : {}),
  }));
  const partners = children.partners
    .filter(entry => entry.payload.active !== false)
    .map(entry => ({
      id: String(entry.payload.id),
      name: String(entry.payload.name),
      type: entry.payload.type as PartnerEntity['type'],
      ...(entry.payload.phone !== undefined ? { phone: String(entry.payload.phone) } : {}),
      ...(entry.payload.notes !== undefined ? { notes: String(entry.payload.notes) } : {}),
    }));
  const openingStockAttachments = Object.fromEntries(
    children.attachments
      .filter(entry => typeof entry.payload.data === 'string' && String(entry.payload.data).length > 0)
      .map(entry => [String(entry.payload.key), String(entry.payload.data)]),
  );
  const openingStockAttachmentKeys = Object.keys(openingStockAttachments).sort();
  const composed: AppSettings = {
    organizationName: String(root.organizationName || ''),
    departmentName: String(root.departmentName || ''),
    expiryWarningThresholdDays: Number(root.expiryWarningThresholdDays || 0),
    categories,
    units: Array.isArray(root.units) ? root.units.map(String) : [],
    storehouses: Array.isArray(root.storehouses) ? root.storehouses.map(String) : [],
    storehouseEntities,
    storehouseIds: Array.isArray(root.storehouseIds)
      ? root.storehouseIds.map(String)
      : storehouseEntities.map(entity => entity.id),
    warehouseSchemaVersion: 2,
    cloudSyncEnabled: root.cloudSyncEnabled === undefined ? true : Boolean(root.cloudSyncEnabled),
    transactionCounters: root.transactionCounters as AppSettings['transactionCounters'],
    partners,
    ...(openingStockAttachmentKeys.length > 0
      ? { openingStockAttachments, openingStockAttachmentKeys }
      : {}),
  };
  if (root.firebaseInitialized !== undefined) composed.firebaseInitialized = Boolean(root.firebaseInitialized);
  if (root.storekeeperName !== undefined) composed.storekeeperName = String(root.storekeeperName);
  if (root.systemManagerName !== undefined) composed.systemManagerName = String(root.systemManagerName);
  if (root.healthDirectorName !== undefined) composed.healthDirectorName = String(root.healthDirectorName);
  if (root.storekeeperRole !== undefined) composed.storekeeperRole = String(root.storekeeperRole);
  if (root.systemManagerRole !== undefined) composed.systemManagerRole = String(root.systemManagerRole);
  if (root.healthDirectorRole !== undefined) composed.healthDirectorRole = String(root.healthDirectorRole);
  if (root.showStorekeeperSignature !== undefined) {
    composed.showStorekeeperSignature = Boolean(root.showStorekeeperSignature);
  }
  if (root.showSystemManagerSignature !== undefined) {
    composed.showSystemManagerSignature = Boolean(root.showSystemManagerSignature);
  }
  if (root.showHealthDirectorSignature !== undefined) {
    composed.showHealthDirectorSignature = Boolean(root.showHealthDirectorSignature);
  }
  return composed;
};

/** Strip nested + singular attachment from a composed object for local post-migration root mirror. */
export const stripNestedSettingsForLocalRootMirror = (settings: AppSettings): AppSettings => {
  const {
    openingStockAttachment: _singular,
    ...rest
  } = settings;
  return rest;
};

/** Backup export stays composed AppSettings (UI view-model). Import extracts/quarantines safely. */
export const composeSettingsForBackupExport = (settings: AppSettings): AppSettings => {
  const { openingStockAttachment: _singular, ...rest } = settings;
  return rest;
};

export const prepareSettingsForBackupImport = (settings: AppSettings): AppSettings => {
  const next: AppSettings = { ...settings };
  // Quarantine singular blob into map without truncation when map lacks the key.
  if (typeof next.openingStockAttachment === 'string' && next.openingStockAttachment.length > 0) {
    const map = { ...(next.openingStockAttachments || {}) };
    if (!Object.prototype.hasOwnProperty.call(map, 'legacy-singular')) {
      map['legacy-singular'] = next.openingStockAttachment;
    }
    next.openingStockAttachments = map;
    next.openingStockAttachmentKeys = Object.keys(map).sort();
  }
  delete (next as AppSettings).openingStockAttachment;
  // Fail closed on over-limit rather than truncate.
  const children = extractTypedSettingsChildren(next);
  void children;
  return next;
};

/** Access-safe business-doc ceiling for one audited settings envelope (set or delete). */
export const SETTINGS_ATOMIC_BUSINESS_DOC_LIMIT = 8;

/** Tombstone payload: zeros attachment bytes while keeping schema-required `data` field. */
export const openingAttachmentTombstonePayload = (key: string): Record<string, unknown> => ({
  key,
  data: '',
});

export const isOpeningAttachmentTombstone = (payload: Record<string, unknown> | undefined | null): boolean =>
  !!payload && typeof payload.data === 'string' && payload.data.length === 0;

/**
 * Cloud typed docs that compose intentionally omits from the live view-model:
 * OSA empty-data tombstones and category/partner active:false husks.
 * Warehouses with active:false are NOT omitted — compose/project keep them in
 * storehouseEntities/storehouseIds (deactivate-in-place / reactivation contract).
 * Backup/compare must treat compose-omitted rows as intentional presence, not missingLocally.
 */
export const isTypedSettingsCloudInactiveOrTombstone = (
  docId: string,
  payload: Record<string, unknown> | undefined | null,
): boolean => {
  if (!payload) return false;
  const kind = settingsDocKind(docId);
  if (kind === 'opening_attachment') return isOpeningAttachmentTombstone(payload);
  if (kind === 'category' || kind === 'partner') {
    return payload.active === false;
  }
  return false;
};

/** Typed-child projection for confirmed-fingerprint / OCC (strip __sync; never composed VM). */
export const settingsChildSyncProjection = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = { ...(value as Record<string, unknown>) };
  delete record.__sync;
  return record;
};

/** Slim projection used for confirmed-fingerprint / conflict compare (never composed VM). */
export const settingsRootSyncProjection = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = { ...(value as Record<string, unknown>) };
  delete record.__sync;
  if (hasNestedLegacySettingsKeys(record)) {
    return toSlimSettingsRoot(record as unknown as AppSettings);
  }
  // Already-slim cloud root: re-emit allowlisted keys only (stable vs composed→slim).
  const slim: Record<string, unknown> = { settingsSchemaVersion: SETTINGS_SCHEMA_VERSION };
  for (const key of SLIM_SETTINGS_ROOT_KEYS) {
    if (key === 'settingsSchemaVersion') continue;
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) {
      slim[key] = record[key];
    }
  }
  return slim;
};

export interface RemovedTypedSettingsDocs {
  categories: Array<{ docId: string; payload: Record<string, unknown> }>;
  warehouses: Array<{ docId: string; payload: Record<string, unknown> }>;
  partners: Array<{ docId: string; payload: Record<string, unknown> }>;
  attachments: Array<{ docId: string; payload: Record<string, unknown> }>;
}

/** Typed children present in previous composed settings but absent from next (orphan candidates). */
export const listRemovedTypedSettingsDocs = (
  previous: AppSettings,
  next: AppSettings,
): RemovedTypedSettingsDocs => {
  const prev = extractTypedSettingsChildren(previous);
  const curr = extractTypedSettingsChildren(next);
  const nextIds = new Set<string>([
    ...curr.categories.map(e => e.docId),
    ...curr.warehouses.map(e => e.docId),
    ...curr.partners.map(e => e.docId),
    ...curr.attachments.map(e => e.docId),
  ]);
  return {
    categories: prev.categories.filter(e => !nextIds.has(e.docId)),
    warehouses: prev.warehouses.filter(e => !nextIds.has(e.docId)),
    partners: prev.partners.filter(e => !nextIds.has(e.docId)),
    attachments: prev.attachments.filter(e => !nextIds.has(e.docId)),
  };
};

/** Manifest-derived typed doc ids that must be fetched to compose a slim root. */
export const listSettingsChildDocIdsFromRoot = (root: Record<string, unknown>): string[] => {
  const ids: string[] = [];
  if (Array.isArray(root.categoryIds)) {
    for (const id of root.categoryIds) ids.push(String(id));
  }
  if (Array.isArray(root.partnerIds)) {
    for (const id of root.partnerIds) ids.push(String(id));
  }
  if (Array.isArray(root.storehouseIds)) {
    for (const id of root.storehouseIds) ids.push(warehouseDocId(String(id)));
  }
  const keys = Array.isArray(root.openingStockAttachmentKeys)
    ? root.openingStockAttachmentKeys.map(String)
    : [];
  for (const key of keys) ids.push(openingAttachmentDocId(key));
  return [...new Set(ids)];
};

export type SettingsCloudMutationOp =
  | { kind: 'set'; docId: string; value: Record<string, unknown>; previous?: Record<string, unknown> }
  | { kind: 'delete'; docId: string; previous: Record<string, unknown> };

/**
 * Build the durable cloud plan for a composed settings save:
 * changed typed upserts, osa tombstones, warehouse deactivations, cat/partner deletes, then slim root.
 * Caller enforces atomic envelope capacity / children-before-root staging.
 */
export const buildSettingsCloudMutationPlan = (
  next: AppSettings,
  previous: AppSettings,
  options: { childConfirmed?: (docId: string) => boolean; rootConfirmed?: boolean } = {},
): SettingsCloudMutationOp[] => {
  const children = extractTypedSettingsChildren(next);
  const previousChildren = extractTypedSettingsChildren(previous);
  const previousById = new Map<string, Record<string, unknown>>();
  for (const group of [
    previousChildren.categories, previousChildren.warehouses,
    previousChildren.partners, previousChildren.attachments,
  ]) {
    for (const entry of group) previousById.set(entry.docId, entry.payload);
  }
  const childOps: SettingsCloudMutationOp[] = [];
  for (const entry of [
    ...children.categories, ...children.warehouses, ...children.partners, ...children.attachments,
  ]) {
    const prev = previousById.get(entry.docId);
    const confirmed = options.childConfirmed?.(entry.docId) === true;
    if (prev && JSON.stringify(prev) === JSON.stringify(entry.payload) && confirmed) continue;
    childOps.push({
      kind: 'set',
      docId: entry.docId,
      value: entry.payload,
      previous: confirmed ? prev : undefined,
    });
  }
  const removed = listRemovedTypedSettingsDocs(previous, next);
  for (const entry of removed.attachments) {
    childOps.push({
      kind: 'set',
      docId: entry.docId,
      value: openingAttachmentTombstonePayload(String(entry.payload.key)),
      previous: entry.payload,
    });
  }
  for (const entry of removed.warehouses) {
    childOps.push({
      kind: 'set',
      docId: entry.docId,
      value: { ...entry.payload, active: false },
      previous: entry.payload,
    });
  }
  for (const entry of [...removed.categories, ...removed.partners]) {
    childOps.push({
      kind: 'set',
      docId: entry.docId,
      value: { ...entry.payload, active: false },
      previous: entry.payload,
    });
  }
  const rootNext = toSlimSettingsRoot(next);
  const rootPrev = toSlimSettingsRoot(previous);
  const rootConfirmed = options.rootConfirmed ?? true;
  childOps.push({
    kind: 'set',
    docId: SETTINGS_ROOT_DOC_ID,
    value: rootNext,
    previous: rootConfirmed ? rootPrev : undefined,
  });
  return childOps;
};

/** Split plan into access-safe chunks with root last (fail-closed staging). */
export const stageSettingsCloudMutationPlan = (
  plan: SettingsCloudMutationOp[],
  limit: number = SETTINGS_ATOMIC_BUSINESS_DOC_LIMIT,
): SettingsCloudMutationOp[][] => {
  if (plan.length === 0) return [];
  if (plan.length <= limit) return [plan];
  const root = plan[plan.length - 1];
  if (root.docId !== SETTINGS_ROOT_DOC_ID) {
    throw new Error('SETTINGS_STAGE_ROOT_MISSING');
  }
  const children = plan.slice(0, -1);
  const chunks: SettingsCloudMutationOp[][] = [];
  for (let i = 0; i < children.length; i += limit) {
    chunks.push(children.slice(i, i + limit));
  }
  chunks.push([root]);
  return chunks;
};
