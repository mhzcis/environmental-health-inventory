import { describe, it, expect } from 'vitest';
import { buildMaterialWarehouseView } from '../src/utils/inventoryLogic';
import { buildTotalStockIndex, isLowStockByTotal, totalStockOf } from '../src/utils/lowStock';
import type { Material } from '../src/types';

// Owner decision 2026-11-06 19:23 Asia/Jerusalem (QA REP-02): minimum stock is evaluated against the
// TOTAL across all warehouses, not per warehouse.
const WH = ['CX-A', 'CX-B'];
const mat = (id: string, code: string, a: number, b: number, min: number): Material => ({
  id, code, name: code, category: 'CX', unit: 'unit', minimumStock: min, initialStock: 0,
  currentStock: a + b, storageLocation: 'CX-A', warehouseStocks: { 'CX-A': a, 'CX-B': b },
} as unknown as Material);

const cx1001 = mat('CX_local_material', 'CX-1001', 9, 1, 2); // total 10 ≥ 2, cx-b holds 1 ≤ 2
const lowTotal = mat('cx-low', 'CX-1101', 1, 1, 2);          // total 2 ≤ 2 → low
const above = mat('cx-above', 'CX-1103', 10, 0, 2);
const materials = [cx1001, lowTotal, above];
const totals = buildTotalStockIndex(materials as any);

describe('low stock is decided by the all-warehouse total', () => {
  it('CX-1001: total 10 ≥ min 2 is NOT low even though warehouse CX-B holds 1', () => {
    const rows = buildMaterialWarehouseView(materials, 'all', WH).filter(r => (r._originalId || r.id) === 'CX_local_material');
    expect(rows.length).toBeGreaterThan(1); // group row + per-warehouse sub rows
    expect(rows.some(r => r.isSubRow && r.currentStock === 1)).toBe(true);
    for (const r of rows) expect(isLowStockByTotal(r as any, totals)).toBe(false);
  });
  it('CX-1001 under the CX-B warehouse scope (row stock 1) is still NOT low', () => {
    const rows = buildMaterialWarehouseView(materials, 'CX-B', WH).filter(r => (r._originalId || r.id) === 'CX_local_material');
    expect(rows[0].currentStock).toBe(1);
    expect(totalStockOf(rows[0] as any, totals)).toBe(10);
    expect(isLowStockByTotal(rows[0] as any, totals)).toBe(false);
  });
  it('an item whose total equals the minimum is low (boundary ≤)', () => {
    const rows = buildMaterialWarehouseView(materials, 'all', WH).filter(r => (r._originalId || r.id) === 'cx-low');
    expect(rows.every(r => isLowStockByTotal(r as any, totals))).toBe(true);
  });
  it('an item above its minimum in total is not low', () => {
    const rows = buildMaterialWarehouseView(materials, 'all', WH).filter(r => (r._originalId || r.id) === 'cx-above');
    expect(rows.some(r => isLowStockByTotal(r as any, totals))).toBe(false);
  });
  it('falls back to the row value when the material is unknown to the index', () => {
    expect(isLowStockByTotal({ id: 'x', currentStock: 1, minimumStock: 2 }, new Map())).toBe(true);
  });
});
