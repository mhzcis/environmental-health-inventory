/**
 * Low-stock rule (owner decision 2026-11-06 19:23 Asia/Jerusalem, QA REP-02):
 * an item is "low stock" when its TOTAL balance across ALL warehouses is at or below its
 * minimumStock. A single warehouse holding little stock does not make the item low on its own,
 * and the warehouse scope only limits which rows are listed, not how the rule is evaluated.
 */
export interface LowStockMaterialLike {
  id: string;
  _originalId?: string;
  currentStock: number;
  minimumStock: number;
}

/** Map material id → total balance across all warehouses (raw materials carry the all-warehouse total). */
export const buildTotalStockIndex = (materials: ReadonlyArray<LowStockMaterialLike>): Map<string, number> => {
  const totals = new Map<string, number>();
  for (const m of materials) totals.set(m._originalId || m.id, Number(m.currentStock) || 0);
  return totals;
};

/** Total balance for a (possibly warehouse-scoped or sub-) row; falls back to the row's own value. */
export const totalStockOf = (row: LowStockMaterialLike, totals: ReadonlyMap<string, number>): number => {
  const total = totals.get(row._originalId || row.id);
  return total === undefined ? Number(row.currentStock) || 0 : total;
};

export const isLowStockByTotal = (row: LowStockMaterialLike, totals: ReadonlyMap<string, number>): boolean =>
  totalStockOf(row, totals) <= (Number(row.minimumStock) || 0);
