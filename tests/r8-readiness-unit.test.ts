// R8 unit coverage: warehouse-migration root cause (REQ-1), server-owned field parity (DATA-01/ARC-01),
// reader preset (RBAC-01) and permission catalogue.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AppSettings, InventoryTransaction, Material } from '../src/types';
import { migrateWarehouseModel } from '../src/utils/warehouseMigration';
import { SERVER_OWNED_MATERIAL_KEYS, KNOWN_PERMISSION_IDS, assertDomainProofPayload } from '../src/utils/productSchema';
import { READER_FORBIDDEN_PERMISSIONS, READER_PERMISSION_PRESET, readerPermissions } from '../src/security/rbacPresets';
import { isMaterialArchived, activeMaterialsOnly } from '../src/utils/materialLifecycle';

const settings = (): AppSettings => ({
  organizationName: 'Org', departmentName: 'Dept', expiryWarningThresholdDays: 30,
  categories: [{ name: 'QA', prefix: 'QA', startRange: 1000, endRange: 2000 }], units: ['قطعة'],
  storehouses: ['QA-A', 'QA-B'], storehouseIds: ['qa-a', 'qa-b'],
  storehouseEntities: [{ id: 'qa-a', name: 'QA-A', active: true }, { id: 'qa-b', name: 'QA-B', active: true }],
  warehouseSchemaVersion: 2,
} as AppSettings);
const material = (over: Partial<Material> = {}): Material => ({
  id: 'qa-m1', code: 'QA-1001', name: 'QA مادة', category: 'QA', unit: 'قطعة', minimumStock: 0, currentStock: 5,
  initialStock: 0, storageLocation: 'QA-A', primaryStorehouseId: 'qa-a', createdAt: '2026-11-04', updatedAt: '2026-11-04', ...over,
} as Material);
const tx = (): InventoryTransaction => ({
  id: 'qa-t1', date: '2026-11-04', itemId: 'qa-m1', itemCode: 'QA-1001', itemName: 'QA مادة', transactionType: 'وارد', quantity: 5,
  stockBefore: 0, stockAfter: 5, executedBy: 'QA', supplierOrReceiver: 'QA', storehouse: 'QA-A', storehouseId: 'qa-a',
  createdAt: '2026-11-04', updatedAt: '2026-11-04',
} as InventoryTransaction);

describe('R8-REQ1 root cause of WAREHOUSE_MIGRATION_BLOCKED: MATERIAL_STOCK_CONFLICT:qa-m1:qa-a:5:8', () => {
  for (const [label, stale] of [['5:8', 8], ['5:10', 10]] as const) {
    it(`R8-REQ1-U${label} ledger-backed material: two stale caches warn, never block`, () => {
      const result = migrateWarehouseModel({ settings: settings(), selectedStorehouse: 'all', transactions: [tx()],
        materials: [material({ warehouseStocksById: { 'qa-a': 5 }, warehouseStocks: { 'QA-A': stale } })] });
      expect(result.errors).toEqual([]);
      expect(result.warnings).toContain(`MATERIAL_STOCK_CACHE_SUPERSEDED_BY_LEDGER:qa-m1:qa-a:5:${stale}`);
      expect(result.materials[0].warehouseStocksById).toEqual({ 'qa-a': 5 });
    });
  }
  it('R8-REQ1-U3 server-projected material (ledgerTotalStock present, no local ledger rows) is also derived-only', () => {
    const result = migrateWarehouseModel({ settings: settings(), selectedStorehouse: 'all', transactions: [],
      materials: [material({ ledgerTotalStock: 5, warehouseStocksById: { 'qa-a': 5 }, warehouseStocks: { 'QA-A': 8 } })] });
    expect(result.errors).toEqual([]);
  });
  it('R8-REQ1-U4 legacy pre-ledger material keeps strict conflict detection (no silent pick)', () => {
    const result = migrateWarehouseModel({ settings: settings(), selectedStorehouse: 'all', transactions: [],
      materials: [material({ warehouseStocksById: { 'qa-a': 5 }, warehouseStocks: { 'QA-A': 8 } })] });
    expect(result.errors).toContain('MATERIAL_STOCK_CONFLICT:qa-m1:qa-a:5:8');
  });
});

describe('R8 server-owned material fields (DATA-01 / ARC-01)', () => {
  it('R8-DATA-U1 client list equals the server derived_material_keys() || lifecycle_material_keys()', () => {
    const sql = fs.readFileSync('database/inventory_atomic.sql', 'utf8');
    const list = (fn: string) => JSON.parse(`[${sql.match(new RegExp(`${fn}\\(\\) RETURNS text\\[\\][\\s\\S]*?ARRAY\\[([^\\]]*)\\]`))![1].replace(/'/g, '"')}]`);
    expect([...SERVER_OWNED_MATERIAL_KEYS]).toEqual([...list('derived_material_keys'), ...list('lifecycle_material_keys')]);
  });
  it('R8-ARC-U1 backups/reads accept lifecycle fields with strict types', () => {
    const archived = { id: 'm', name: 'n', lifecycleStatus: 'archived', lifecycleVersion: 1, archivePurpose: 'qa_test_data', archiveReason: 'r', ledgerTotalStock: 12 };
    expect(() => assertDomainProofPayload('materials', archived)).not.toThrow();
    expect(() => assertDomainProofPayload('materials', { ...archived, lifecycleStatus: 'deleted' })).toThrow();
    expect(() => assertDomainProofPayload('materials', { ...archived, archivePurpose: 'other' })).toThrow();
    expect(() => assertDomainProofPayload('materials', { ...archived, syncPending: true })).toThrow();
    expect(isMaterialArchived(archived as never)).toBe(true);
    expect(activeMaterialsOnly([archived, { lifecycleStatus: 'active' }, {}] as never[])).toHaveLength(2);
  });
});

describe('R8-RBAC-01 reader preset', () => {
  it('R8-RBAC-U1 preset is view-only, known, and export/print are an explicit opt-in', () => {
    for (const permission of READER_PERMISSION_PRESET) expect(KNOWN_PERMISSION_IDS.has(permission)).toBe(true);
    for (const forbidden of READER_FORBIDDEN_PERMISSIONS) expect(readerPermissions({ allowExport: true })).not.toContain(forbidden);
    expect(readerPermissions()).not.toContain('reports_export');
    expect(readerPermissions()).not.toContain('reports_print');
    expect(readerPermissions({ allowExport: true })).toEqual([...READER_PERMISSION_PRESET, 'reports_export', 'reports_print']);
    expect(KNOWN_PERMISSION_IDS.has('materials_archive')).toBe(true);
  });
  it('R8-RBAC-U2 Settings uses the preset for the reader role (no audit/settings/users/write permissions)', () => {
    const source = fs.readFileSync('src/pages/Settings.tsx', 'utf8');
    expect(source).toMatch(/val === 'مراجع\/مُشاهد'\) \{\s*\/\/[^\n]*\n\s*setUserPermissions\(readerPermissions\(\)\);/);
  });
});
