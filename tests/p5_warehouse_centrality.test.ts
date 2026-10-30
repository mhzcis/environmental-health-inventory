import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AppSettings, InventoryTransaction, Material } from '../src/types';
import { buildStorehouseEntities, legacyWarehouseId, resolveWarehouseScope } from '../src/utils/warehouseDomain';
import { migrateWarehouseModel } from '../src/utils/warehouseMigration';
import { addOrReactivateWarehouse, renameWarehouseEntity, setWarehouseEntityActive } from '../src/utils/warehouseSettings';

const settings = (): AppSettings => ({
  organizationName: 'Org', departmentName: 'Dept', expiryWarningThresholdDays: 30,
  categories: [{ name: 'General', prefix: 'GEN', startRange: 1000, endRange: 1999 }],
  units: ['pcs'],
  storehouses: ['المخزن الرئيسي', 'مخزن ب'],
});

const material = (overrides: Partial<Material> = {}): Material => ({
  id: 'm1', code: 'M-1', name: 'Material', category: 'Cat', unit: 'pcs', minimumStock: 1,
  currentStock: 10, initialStock: 10, storageLocation: 'المخزن الرئيسي - الرف أ',
  warehouseStocks: { 'المخزن الرئيسي': 10 }, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...overrides,
});

const transaction = (overrides: Partial<InventoryTransaction> = {}): InventoryTransaction => ({
  id: 't1', date: '2026-01-01', itemId: 'm1', itemCode: 'M-1', itemName: 'Material',
  transactionType: 'افتتاحي', quantity: 10, stockBefore: 0, stockAfter: 10, executedBy: 'Tester',
  supplierOrReceiver: 'Opening', storehouse: 'المخزن الرئيسي', createdAt: '2026-01-01', updatedAt: '2026-01-01', ...overrides,
});

describe('P5-A stable warehouse identity and migration', () => {
  it('creates deterministic stable ids without using mutable display names as identity', () => {
    const first = buildStorehouseEntities(settings().storehouses);
    const second = buildStorehouseEntities(settings().storehouses);
    expect(first.map((x) => x.id)).toEqual(second.map((x) => x.id));
    expect(first[0].id).toBe(legacyWarehouseId('المخزن الرئيسي'));
  });

  it('migrates shelf-qualified legacy locations without losing the detail', () => {
    const result = migrateWarehouseModel({
      settings: settings(), materials: [material()], transactions: [transaction()], selectedStorehouse: 'المخزن الرئيسي',
    });
    expect(result.errors).toEqual([]);
    expect(result.settings.warehouseSchemaVersion).toBe(2);
    expect(result.materials[0].primaryStorehouseId).toBe(legacyWarehouseId('المخزن الرئيسي'));
    expect(result.materials[0].storageLocationDetail).toBe('الرف أ');
    expect(result.materials[0].warehouseStocksById?.[legacyWarehouseId('المخزن الرئيسي')]).toBe(10);
    expect(result.transactions[0].storehouseId).toBe(legacyWarehouseId('المخزن الرئيسي'));
    expect(result.selectedStorehouseId).toBe(legacyWarehouseId('المخزن الرئيسي'));
  });

  it('fails closed instead of inventing a warehouse for an unresolved positive balance', () => {
    const result = migrateWarehouseModel({
      settings: settings(), materials: [material({ storageLocation: 'موقع غير معرف', warehouseStocks: {} })],
      transactions: [], selectedStorehouse: 'all',
    });
    expect(result.errors.some((entry) => entry.startsWith('MATERIAL_WAREHOUSE_UNRESOLVED'))).toBe(true);
  });

  it('invalid active scope resolves safely to all', () => {
    const entities = buildStorehouseEntities(settings().storehouses).map((item, index) => ({ ...item, active: index === 0 }));
    const s = { ...settings(), storehouseEntities: entities, warehouseSchemaVersion: 2 as const };
    const inactive = resolveWarehouseScope(s, entities[1].id);
    expect(inactive.valid).toBe(false);
    expect(inactive.selectedStorehouseId).toBe('all');
  });
});


describe('P5-B lifecycle and central scope', () => {
  it('renames display label without changing stable warehouse id', () => {
    const base = { ...settings(), storehouseEntities: buildStorehouseEntities(settings().storehouses), warehouseSchemaVersion: 2 as const };
    const beforeId = base.storehouseEntities![0].id;
    const renamed = renameWarehouseEntity(base, beforeId, 'المستودع المركزي');
    expect(renamed.storehouseEntities![0].id).toBe(beforeId);
    expect(renamed.storehouses[0]).toBe('المستودع المركزي');
  });

  it('deactivation removes a warehouse from all-active projection but preserves the entity', () => {
    const base = { ...settings(), storehouseEntities: buildStorehouseEntities(settings().storehouses), warehouseSchemaVersion: 2 as const };
    const id = base.storehouseEntities![1].id;
    const disabled = setWarehouseEntityActive(base, id, false);
    expect(disabled.storehouses).toEqual(['المخزن الرئيسي']);
    expect(disabled.storehouseEntities!.find((x) => x.id === id)?.active).toBe(false);
    const reactivated = addOrReactivateWarehouse(disabled, 'مخزن ب');
    expect(reactivated.storehouseEntities!.find((x) => x.id === id)?.active).toBe(true);
  });

  it('refuses to deactivate the final active warehouse', () => {
    const base = { ...settings(), storehouseEntities: buildStorehouseEntities(settings().storehouses), warehouseSchemaVersion: 2 as const };
    const first = setWarehouseEntityActive(base, base.storehouseEntities![1].id, false);
    expect(() => setWarehouseEntityActive(first, first.storehouseEntities![0].id, false)).toThrow(/آخر مستودع فعال/);
  });
});


describe('P5-C write-boundary, stock and simulation guards', () => {
  it('never defaults an all-scope transaction write to the first warehouse', () => {
    const source = fs.readFileSync('src/components/CreateTransactionModal.tsx', 'utf8');
    expect(source).not.toContain("settings().storehouses[0]");
    expect(source).not.toContain("getSettings().storehouses[0]");
    expect(source).toContain("globalStorehouseScope !== 'all' ? globalStorehouseScope : ''");
  });

  it('requires canonical warehouse ids at service write boundaries', () => {
    const source = fs.readFileSync('src/services/dataService.ts', 'utf8');
    expect(source).toContain('ensureWarehouseLocalMigration()');
    expect(source).toContain('transaction.storehouseId = resolvedWarehouse.id');
    expect(source).toContain('tx.storehouseId || getStorehouseByReference');
    expect(source).toContain('targetId ? id === targetId');
    expect(source).toContain("scope.selectedStorehouseId !== sourceEntity.id");
  });

  it('binds new material warehouse selection to the central scope when one warehouse is active', () => {
    const source = fs.readFileSync('src/components/MaterialFormDialog.tsx', 'utf8');
    expect(source).toContain("selectedStorehouse !== 'all'");
    expect(source).toContain("setValue('storageLocation', selectedStorehouse)");
  });

  it('does not simulate a warehouse balance until an actual source warehouse is selected', () => {
    const source = fs.readFileSync('src/components/CreateTransactionModal.tsx', 'utf8');
    expect(source).toContain('if (!watchItem || !watchStorehouse) return null;');
    expect(source).not.toContain("watchStorehouse || 'المخزن الرئيسي'");
  });
});


describe('P5-D active-scope UI consistency', () => {
  it('does not synthesize main warehouse or re-filter by name substring', () => {
    const dashboard = fs.readFileSync('src/pages/Dashboard.tsx', 'utf8');
    const reports = fs.readFileSync('src/pages/Reports.tsx', 'utf8');
    const transactions = fs.readFileSync('src/pages/Transactions.tsx', 'utf8');
    expect(dashboard).not.toContain('warehouseInOut["المخزن الرئيسي"]');
    expect(reports).not.toContain("(t.storehouse || 'المخزن الرئيسي').includes(selectedStorehouse)");
    expect(transactions).not.toContain("(t.storehouse || 'المخزن الرئيسي').includes(selectedStorehouse)");
  });
  it('exports selected movements from the scoped ledger and clears selections on scope change', () => {
    const source = fs.readFileSync('src/pages/Transactions.tsx', 'utf8');
    expect(source.match(/const selectedItems = ledgerTransactions.filter/g)?.length).toBe(2);
    expect(source).toContain('setSelectedTransactionIds([])');
  });
  it('global selector is backed by active warehouse entities', () => {
    const source = fs.readFileSync('src/layouts/AppLayout.tsx', 'utf8');
    expect(source).toContain('activeStorehouses.map((warehouse)');
    expect(source).toContain('setSelectedStorehouse(warehouse.id)');
  });
});
