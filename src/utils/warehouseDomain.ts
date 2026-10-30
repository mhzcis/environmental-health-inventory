import type { AppSettings, Storehouse } from '../types';
import { safeUserMessage } from '../services/safeUserMessage';

export const WAREHOUSE_SCHEMA_VERSION = 2 as const;
export const ALL_WAREHOUSES_SCOPE = 'all' as const;

/**
 * Text for a warehouse-validation failure that ends up in a rendered report (`validateBackup().errors`, migration errors).
 * Only the bare `WAREHOUSE_*` domain code is kept (the user-supplied name/id suffix is dropped); any other error becomes fixed
 * Arabic text via `safeUserMessage` — never raw `Error.message` (PREPROD rework #1).
 */
export const safeWarehouseError = (error: unknown): string => {
  try {
    const head = error instanceof Error ? error.message.split(':', 1)[0] : '';
    if (/^WAREHOUSE_[A-Z_]{3,40}$/.test(head)) return head;
  } catch {
    // fall through to the generic sanitizer
  }
  return safeUserMessage(error, 'import', { allowAppText: true });
};

export const normalizeWarehouseName = (value: string): string =>
  String(value || '').trim().replace(/\s+/g, ' ');

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
};

export const legacyWarehouseId = (name: string): string =>
  `wh-${fnv1a(normalizeWarehouseName(name).toLocaleLowerCase('ar'))}`;

export const buildStorehouseEntities = (
  names: string[],
  existing: Storehouse[] = [],
): Storehouse[] => {
  const normalizedNames = names.map(normalizeWarehouseName);
  const seenNames = new Set<string>();
  const existingByName = new Map(
    existing
      .filter((item) => item?.id && normalizeWarehouseName(item.name))
      .map((item) => [normalizeWarehouseName(item.name), item] as const),
  );
  const result: Storehouse[] = [];
  const seenIds = new Set<string>();

  for (const name of normalizedNames) {
    if (!name) throw new Error('WAREHOUSE_NAME_EMPTY');
    if (seenNames.has(name)) throw new Error(`WAREHOUSE_NAME_DUPLICATE:${name}`);
    seenNames.add(name);
    const previous = existingByName.get(name);
    const entity: Storehouse = previous
      ? { ...previous, name, active: previous.active !== false }
      : { id: legacyWarehouseId(name), name, active: true };
    if (seenIds.has(entity.id)) throw new Error(`WAREHOUSE_ID_COLLISION:${entity.id}`);
    seenIds.add(entity.id);
    result.push(entity);
  }
  return result;
};

export const getStorehouseEntities = (settings: Pick<AppSettings, 'storehouses' | 'storehouseEntities'>): Storehouse[] => {
  const explicit = Array.isArray(settings.storehouseEntities)
    ? settings.storehouseEntities.filter((item) => item && typeof item.id === 'string' && normalizeWarehouseName(item.name))
    : [];
  if (explicit.length > 0) {
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    return explicit.map((item) => {
      const name = normalizeWarehouseName(item.name);
      if (!item.id.trim()) throw new Error('WAREHOUSE_ID_EMPTY');
      if (seenIds.has(item.id)) throw new Error(`WAREHOUSE_ID_DUPLICATE:${item.id}`);
      if (seenNames.has(name)) throw new Error(`WAREHOUSE_NAME_DUPLICATE:${name}`);
      seenIds.add(item.id);
      seenNames.add(name);
      return { ...item, name, active: item.active !== false };
    });
  }
  return buildStorehouseEntities(Array.isArray(settings.storehouses) ? settings.storehouses : []);
};

export const getActiveStorehouses = (settings: Pick<AppSettings, 'storehouses' | 'storehouseEntities'>): Storehouse[] =>
  getStorehouseEntities(settings).filter((item) => item.active);

export const getStorehouseByReference = (
  settings: Pick<AppSettings, 'storehouses' | 'storehouseEntities'>,
  reference: string | undefined,
  includeInactive = true,
): Storehouse | undefined => {
  if (!reference || reference === ALL_WAREHOUSES_SCOPE) return undefined;
  const ref = normalizeWarehouseName(reference);
  const entities = includeInactive ? getStorehouseEntities(settings) : getActiveStorehouses(settings);
  return entities.find((item) => item.id === reference || item.name === ref);
};

export const projectActiveStorehouseNames = (
  settings: Pick<AppSettings, 'storehouses' | 'storehouseEntities'>,
): string[] => getActiveStorehouses(settings).map((item) => item.name);

export interface ResolvedWarehouseScope {
  scope: 'all' | 'warehouse';
  selectedStorehouseId: 'all' | string;
  selectedStorehouseName: 'all' | string;
  valid: boolean;
}

export const resolveWarehouseScope = (
  settings: Pick<AppSettings, 'storehouses' | 'storehouseEntities'>,
  rawReference: string | undefined,
): ResolvedWarehouseScope => {
  if (!rawReference || rawReference === ALL_WAREHOUSES_SCOPE) {
    return { scope: 'all', selectedStorehouseId: 'all', selectedStorehouseName: 'all', valid: true };
  }
  const match = getStorehouseByReference(settings, rawReference, false);
  if (!match) {
    return { scope: 'all', selectedStorehouseId: 'all', selectedStorehouseName: 'all', valid: false };
  }
  return { scope: 'warehouse', selectedStorehouseId: match.id, selectedStorehouseName: match.name, valid: true };
};
