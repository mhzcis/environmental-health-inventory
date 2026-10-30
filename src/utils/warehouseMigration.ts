import type { AppSettings, InventoryTransaction, Material, Storehouse } from '../types';
import {
  ALL_WAREHOUSES_SCOPE,
  WAREHOUSE_SCHEMA_VERSION,
  buildStorehouseEntities,
  getStorehouseEntities,
  normalizeWarehouseName,
  safeWarehouseError,
} from './warehouseDomain';

export interface WarehouseMigrationInput {
  settings: AppSettings;
  materials: Material[];
  transactions: InventoryTransaction[];
  selectedStorehouse?: string;
}

export interface WarehouseMigrationResult {
  settings: AppSettings;
  materials: Material[];
  transactions: InventoryTransaction[];
  selectedStorehouseId: 'all' | string;
  errors: string[];
  warnings: string[];
  changed: boolean;
}

interface LocationResolution {
  storehouse?: Storehouse;
  detail?: string;
  ambiguous?: boolean;
}

const resolveLegacyLocation = (raw: string | undefined, entities: Storehouse[]): LocationResolution => {
  const value = normalizeWarehouseName(raw || '');
  if (!value) return {};
  const exact = entities.find((item) => item.name === value || item.id === raw);
  if (exact) return { storehouse: exact };

  const prefixMatches = entities
    .filter((item) => value.startsWith(`${item.name} -`) || value.startsWith(`${item.name} –`))
    .sort((a, b) => b.name.length - a.name.length);
  if (prefixMatches.length === 0) return {};
  if (prefixMatches.length > 1 && prefixMatches[0].name.length === prefixMatches[1].name.length) {
    return { ambiguous: true };
  }
  const match = prefixMatches[0];
  const detail = value.slice(match.name.length).replace(/^\s*[-–]\s*/, '').trim();
  return { storehouse: match, detail: detail || undefined };
};

const sameNumber = (a: number, b: number): boolean => {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Number.EPSILON * 32 * scale;
};

export const migrateWarehouseModel = (input: WarehouseMigrationInput): WarehouseMigrationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const existingEntities = Array.isArray(input.settings.storehouseEntities) ? input.settings.storehouseEntities : [];
  let entities: Storehouse[];
  try {
    entities = existingEntities.length > 0
      ? getStorehouseEntities(input.settings)
      : buildStorehouseEntities(input.settings.storehouses || []);
  } catch (error) {
    return {
      ...input,
      selectedStorehouseId: 'all',
      errors: [safeWarehouseError(error)],
      warnings,
      changed: false,
    };
  }

  if (entities.filter((item) => item.active).length === 0) errors.push('WAREHOUSE_NO_ACTIVE_ENTITY');

  const byId = new Map(entities.map((item) => [item.id, item] as const));
  const materials = input.materials.map((material) => {
    let changed = false;
    let primary = material.primaryStorehouseId ? byId.get(material.primaryStorehouseId) : undefined;
    let detail = material.storageLocationDetail;

    if (material.primaryStorehouseId && !primary) {
      errors.push(`MATERIAL_PRIMARY_WAREHOUSE_ID_UNRESOLVED:${material.id}:${material.primaryStorehouseId}`);
    }

    if (!primary) {
      const resolved = resolveLegacyLocation(material.storageLocation, entities);
      if (resolved.ambiguous) {
        errors.push(`MATERIAL_WAREHOUSE_AMBIGUOUS:${material.id}:${material.storageLocation}`);
      } else if (resolved.storehouse) {
        primary = resolved.storehouse;
        detail = detail || resolved.detail;
        changed = true;
      } else if (material.currentStock > 0 || (material.initialStock || 0) > 0) {
        errors.push(`MATERIAL_WAREHOUSE_UNRESOLVED:${material.id}:${material.storageLocation || ''}`);
      }
    } else {
      // A valid stable id owns warehouse identity. Preserve shelf/bin text only as detail and
      // keep storageLocation as a compatibility display label, never as the identity itself.
      const legacyDisplay = resolveLegacyLocation(material.storageLocation, entities);
      if (legacyDisplay.storehouse?.id === primary.id && legacyDisplay.detail && !detail) {
        detail = legacyDisplay.detail;
        changed = true;
      }
      if (material.storageLocation !== primary.name) changed = true;
    }

    const canonicalStocks: Record<string, number> = {};
    for (const [warehouseId, rawQuantity] of Object.entries(material.warehouseStocksById || {})) {
      const quantity = Number(rawQuantity);
      if (!byId.has(warehouseId)) {
        errors.push(`MATERIAL_STOCK_WAREHOUSE_ID_UNRESOLVED:${material.id}:${warehouseId}`);
        continue;
      }
      if (!Number.isFinite(quantity) || quantity < 0) {
        errors.push(`MATERIAL_STOCK_INVALID:${material.id}:${warehouseId}`);
        continue;
      }
      canonicalStocks[warehouseId] = quantity;
    }

    for (const [reference, rawQuantity] of Object.entries(material.warehouseStocks || {})) {
      const quantity = Number(rawQuantity);
      if (!Number.isFinite(quantity) || quantity < 0) {
        errors.push(`MATERIAL_STOCK_INVALID:${material.id}:${reference}`);
        continue;
      }
      const direct = byId.get(reference);
      const resolved = direct ? { storehouse: direct } : resolveLegacyLocation(reference, entities);
      if (resolved.ambiguous) {
        errors.push(`MATERIAL_STOCK_WAREHOUSE_AMBIGUOUS:${material.id}:${reference}`);
        continue;
      }
      if (!resolved.storehouse) {
        errors.push(`MATERIAL_STOCK_WAREHOUSE_UNRESOLVED:${material.id}:${reference}`);
        continue;
      }
      const previous = canonicalStocks[resolved.storehouse.id];
      if (previous !== undefined && !sameNumber(previous, quantity)) {
        errors.push(`MATERIAL_STOCK_CONFLICT:${material.id}:${resolved.storehouse.id}:${previous}:${quantity}`);
        continue;
      }
      canonicalStocks[resolved.storehouse.id] = quantity;
      if (!material.warehouseStocksById || material.warehouseStocksById[resolved.storehouse.id] !== quantity) changed = true;
    }

    const canonicalLocation = primary?.name || material.storageLocation;
    if (
      !changed &&
      primary?.id === material.primaryStorehouseId &&
      detail === material.storageLocationDetail &&
      canonicalLocation === material.storageLocation &&
      Object.keys(canonicalStocks).length === Object.keys(material.warehouseStocksById || {}).length
    ) return material;

    return {
      ...material,
      primaryStorehouseId: primary?.id,
      storageLocation: canonicalLocation,
      storageLocationDetail: detail,
      warehouseStocksById: canonicalStocks,
    };
  });

  const migratedMaterialById = new Map(materials.map((item) => [item.id, item] as const));
  const transactions = input.transactions.map((transaction) => {
    if (transaction.storehouseId) {
      const canonical = byId.get(transaction.storehouseId);
      if (!canonical) {
        errors.push(`TRANSACTION_WAREHOUSE_ID_UNRESOLVED:${transaction.id}:${transaction.storehouseId}`);
        return transaction;
      }
      return transaction.storehouse === canonical.name
        ? transaction
        : { ...transaction, storehouse: canonical.name };
    }

    const explicitReference = normalizeWarehouseName(transaction.storehouse || '');
    if (explicitReference) {
      const resolved = resolveLegacyLocation(transaction.storehouse, entities);
      if (resolved.ambiguous) {
        errors.push(`TRANSACTION_WAREHOUSE_AMBIGUOUS:${transaction.id}:${transaction.storehouse || ''}`);
        return transaction;
      }
      if (!resolved.storehouse) {
        // Never reinterpret a wrong explicit reference as the material's primary warehouse.
        errors.push(`TRANSACTION_WAREHOUSE_UNRESOLVED:${transaction.id}:${transaction.storehouse || ''}`);
        return transaction;
      }
      return { ...transaction, storehouseId: resolved.storehouse.id, storehouse: resolved.storehouse.name };
    }

    // Legacy records that genuinely omitted the warehouse may inherit the material primary
    // warehouse because there is no contradictory user-supplied reference to override.
    const fallbackId = migratedMaterialById.get(transaction.itemId)?.primaryStorehouseId;
    const fallback = fallbackId ? byId.get(fallbackId) : undefined;
    if (!fallback) {
      errors.push(`TRANSACTION_WAREHOUSE_UNRESOLVED:${transaction.id}:`);
      return transaction;
    }
    warnings.push(`TRANSACTION_WAREHOUSE_INFERRED_FROM_MATERIAL:${transaction.id}:${fallback.id}`);
    return { ...transaction, storehouseId: fallback.id, storehouse: fallback.name };
  });

  let selectedStorehouseId: 'all' | string = 'all';
  const rawSelected = input.selectedStorehouse || ALL_WAREHOUSES_SCOPE;
  if (rawSelected !== ALL_WAREHOUSES_SCOPE) {
    const selected = byId.get(rawSelected) || resolveLegacyLocation(rawSelected, entities).storehouse;
    if (selected?.active) selectedStorehouseId = selected.id;
    else warnings.push(`SELECTED_WAREHOUSE_INVALID:${rawSelected}`);
  }

  const settings: AppSettings = {
    ...input.settings,
    storehouseEntities: entities,
    warehouseSchemaVersion: WAREHOUSE_SCHEMA_VERSION,
    storehouses: entities.filter((item) => item.active).map((item) => item.name),
  };

  const changed = input.settings.warehouseSchemaVersion !== WAREHOUSE_SCHEMA_VERSION
    || !Array.isArray(input.settings.storehouseEntities)
    || materials.some((item, index) => item !== input.materials[index])
    || transactions.some((item, index) => item !== input.transactions[index])
    || selectedStorehouseId !== rawSelected;

  return { settings, materials, transactions, selectedStorehouseId, errors, warnings, changed };
};
