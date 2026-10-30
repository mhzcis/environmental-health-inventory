import type { AppSettings, InventoryTransaction, Material, Storehouse } from '../types';
import { getStorehouseEntities, resolveWarehouseScope, safeWarehouseError } from './warehouseDomain';
import { migrateWarehouseModel } from './warehouseMigration';

export interface WarehouseBackupProjectionInput {
  settings: AppSettings;
  materials: Material[];
  transactions: InventoryTransaction[];
  selectedStorehouse?: string;
}

export interface WarehouseBackupProjectionResult {
  settings: AppSettings;
  materials: Material[];
  transactions: InventoryTransaction[];
  selectedStorehouseId: 'all' | string;
  selectedStorehouseName: 'all' | string;
  errors: string[];
  warnings: string[];
}

const isOpening = (tx: InventoryTransaction): boolean =>
  tx.id.startsWith('tr-init') || tx.transactionType === 'افتتاحي';

const isInbound = (tx: InventoryTransaction): boolean =>
  tx.transactionType === 'وارد' ||
  tx.transactionType === 'افتتاحي' ||
  (tx.transactionType === 'تحويل' && tx.transferType === 'in') ||
  (tx.transactionType === 'تسوية' && (tx.transferType === 'in' || tx.quantity >= 0));

const nearlyEqual = (a: number, b: number): boolean => {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Number.EPSILON * 32 * scale;
};

/**
 * Produces the canonical warehouse representation used by backup/export/restore boundaries.
 * It preserves every warehouse entity and every ID-based historical balance, while the
 * compatibility name projection/currentStock contains active warehouses only.
 */
export const buildWarehouseBackupProjection = (
  input: WarehouseBackupProjectionInput,
): WarehouseBackupProjectionResult => {
  const migrated = migrateWarehouseModel(input);
  const errors = [...migrated.errors];
  const warnings = [...migrated.warnings];

  let entities: Storehouse[];
  try {
    entities = getStorehouseEntities(migrated.settings);
  } catch (error) {
    return {
      settings: migrated.settings,
      materials: migrated.materials,
      transactions: migrated.transactions,
      selectedStorehouseId: 'all',
      selectedStorehouseName: 'all',
      errors: [...errors, safeWarehouseError(error)],
      warnings,
    };
  }

  const byId = new Map(entities.map((entity) => [entity.id, entity] as const));
  const activeIds = new Set(entities.filter((entity) => entity.active).map((entity) => entity.id));
  const txByMaterial = new Map<string, InventoryTransaction[]>();

  for (const tx of migrated.transactions) {
    const warehouse = tx.storehouseId ? byId.get(tx.storehouseId) : undefined;
    if (!warehouse) {
      errors.push(`BACKUP_TRANSACTION_WAREHOUSE_UNRESOLVED:${tx.id}:${tx.storehouseId || tx.storehouse || ''}`);
      continue;
    }
    if (!Number.isFinite(Number(tx.quantity)) || Number(tx.quantity) < 0) {
      errors.push(`BACKUP_TRANSACTION_QUANTITY_INVALID:${tx.id}`);
      continue;
    }
    const canonicalTx = tx.storehouse === warehouse.name ? tx : { ...tx, storehouse: warehouse.name };
    const list = txByMaterial.get(tx.itemId) || [];
    list.push(canonicalTx);
    txByMaterial.set(tx.itemId, list);
  }

  const canonicalTransactions = migrated.transactions.map((tx) => {
    const warehouse = tx.storehouseId ? byId.get(tx.storehouseId) : undefined;
    return warehouse ? { ...tx, storehouse: warehouse.name } : tx;
  });

  const materials = migrated.materials.map((material) => {
    const primary = material.primaryStorehouseId ? byId.get(material.primaryStorehouseId) : undefined;
    if (!primary && ((material.initialStock || 0) > 0 || material.currentStock > 0)) {
      errors.push(`BACKUP_MATERIAL_PRIMARY_WAREHOUSE_UNRESOLVED:${material.id}`);
    }

    const itemTransactions = txByMaterial.get(material.id) || [];
    const hasAnyTransactions = itemTransactions.length > 0;
    const hasOpeningTransactions = itemTransactions.some(isOpening);
    const balances: Record<string, number> = {};

    // If no transaction history exists, preserve the canonical stored ID balances. This is
    // required for legacy datasets that predate the transaction ledger.
    if (!hasAnyTransactions && material.warehouseStocksById) {
      for (const [warehouseId, rawStock] of Object.entries(material.warehouseStocksById)) {
        const stock = Number(rawStock);
        if (!byId.has(warehouseId)) {
          errors.push(`BACKUP_MATERIAL_STOCK_WAREHOUSE_UNRESOLVED:${material.id}:${warehouseId}`);
          continue;
        }
        if (!Number.isFinite(stock) || stock < 0) {
          errors.push(`BACKUP_MATERIAL_STOCK_INVALID:${material.id}:${warehouseId}`);
          continue;
        }
        balances[warehouseId] = stock;
      }
    }

    if (!hasOpeningTransactions && (material.initialStock || 0) > 0) {
      if (primary) balances[primary.id] = (balances[primary.id] || 0) + Number(material.initialStock || 0);
    }

    for (const tx of itemTransactions) {
      const warehouseId = tx.storehouseId;
      if (!warehouseId || !byId.has(warehouseId)) continue;
      const quantity = Number(tx.quantity);
      balances[warehouseId] = (balances[warehouseId] || 0) + (isInbound(tx) ? quantity : -quantity);
    }

    for (const [warehouseId, stock] of Object.entries(balances)) {
      if (stock < 0 && !nearlyEqual(stock, 0)) {
        errors.push(`BACKUP_NEGATIVE_WAREHOUSE_BALANCE:${material.id}:${warehouseId}:${stock}`);
      }
    }

    const warehouseStocks: Record<string, number> = {};
    let currentStock = 0;
    for (const [warehouseId, stock] of Object.entries(balances)) {
      const entity = byId.get(warehouseId);
      if (!entity) continue;
      if (activeIds.has(warehouseId)) {
        warehouseStocks[entity.name] = stock;
        currentStock += stock;
      }
    }

    return {
      ...material,
      primaryStorehouseId: primary?.id,
      storageLocation: primary?.name || material.storageLocation,
      warehouseStocksById: balances,
      warehouseStocks,
      currentStock,
    };
  });

  const scope = resolveWarehouseScope(
    migrated.settings,
    migrated.selectedStorehouseId || input.selectedStorehouse || 'all',
  );

  return {
    settings: migrated.settings,
    materials,
    transactions: canonicalTransactions,
    selectedStorehouseId: scope.selectedStorehouseId,
    selectedStorehouseName: scope.selectedStorehouseName,
    errors,
    warnings: scope.valid ? warnings : [...warnings, `BACKUP_SELECTED_WAREHOUSE_INVALID:${input.selectedStorehouse || ''}`],
  };
};
