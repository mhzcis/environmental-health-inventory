// R8-LIVE-01/02: offline backup reconciliation (read-only) used by the restore drill and the controlled opening entry.
import { describe, expect, it } from 'vitest';
import { OWNER_POLICY, reconcileBackup } from '../scripts/r8-reconcile-backup.mjs';

const WA = 'wh-0ulyoh6', WB = 'wh-0ek8571';
const cats = [['مبيدات حشرية', 'PES', 1001, 1999], ['معقمات ومطهرات', 'SAN', 2001, 2999], ['معدات رش ومكافحة', 'EQP', 3001, 3999], ['طعوم قوارض', 'ROD', 4001, 4999], ['كلور ومواد كيميائية', 'CHM', 5001, 5999]]
  .map(([name, prefix, startRange, endRange]) => ({ name, prefix, startRange, endRange }));
const settings = { categories: cats, storehouseEntities: [{ id: WA, name: 'المخزن الرئيسي', active: true }, { id: WB, name: 'مخزن ب', active: true }] };
const t = (id: string, type: string, q: number, wh: string, more = {}) => ({ id, itemId: 'mat-1793795662160', transactionType: type, quantity: q, storehouseId: wh, ...more });
const pesLedger = [t('tr-init-mat-1793795662160', 'افتتاحي', 10, WA), t('a', 'وارد', 5, WA), t('b', 'صادر', 3, WA), t('c', 'تحويل', 2, WA, { transferType: 'out' }), t('d', 'تحويل', 2, WB, { transferType: 'in' }), t('e', 'مستهلك', 1, WA), t('f', 'صادر', 1, WB)];
const pes = (more = {}) => ({ id: 'mat-1793795662160', code: 'PES-1001', category: 'مبيدات حشرية', initialStock: 10, primaryStorehouseId: WA, ...more });

describe('R8-LIVE reconciliation report', () => {
  it('R8-LIVE-T1 production-shaped PES: stale 12 is reported against ledger 10 (9/1); no write', () => {
    const backup = { settings, materials: [pes({ currentStock: 12, warehouseStocks: { 'المخزن الرئيسي': 12 } })], transactions: pesLedger };
    const r = reconcileBackup(backup);
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual(expect.objectContaining({ kind: 'PROJECTION_DRIFT', storedCurrentStock: 12, ledgerActiveTotal: 10, ledgerById: { [WA]: 9, [WB]: 1 } }));
    expect(r.materials[0]).toMatchObject({ ledgerRows: 7, openingRows: 1, ledgerTotal: 10 });
  });
  it('R8-LIVE-T2 reconciled + archived PES: no drift, archived total reported separately from active stock', () => {
    const r = reconcileBackup({ settings, transactions: pesLedger, materials: [pes({ currentStock: 10, warehouseStocksById: { [WA]: 9, [WB]: 1 }, lifecycleStatus: 'archived' })] });
    expect(r.ok).toBe(true); expect(r.totals).toEqual({ activeStock: 0, archivedHistoricalStock: 10 }); expect(r.counts.archivedMaterials).toBe(1);
  });
  it('R8-LIVE-T3 opening entered twice, negative balance, duplicate/out-of-range codes and policy drift are findings', () => {
    const r = reconcileBackup({
      settings: { ...settings, categories: cats.map(c => (c.prefix === 'ROD' ? { ...c, prefix: 'TRP' } : c)) },
      materials: [pes({ currentStock: 0 }), { id: 'x', code: 'pes-1001', category: 'مبيدات حشرية', currentStock: 0 }, { id: 'y', code: 'SAN-3005', category: 'معقمات ومطهرات', currentStock: -1, warehouseStocksById: { [WA]: -1 } }],
      transactions: [t('o1', 'افتتاحي', 1, WA), t('o2', 'افتتاحي', 1, WA), { id: 'n', itemId: 'y', transactionType: 'صادر', quantity: 1, storehouseId: WA }, { id: 'orph', itemId: 'gone', transactionType: 'وارد', quantity: 1, storehouseId: WA }],
    });
    const kinds = r.findings.map((f: { kind: string }) => f.kind);
    for (const kind of ['OPENING_DUPLICATED', 'NEGATIVE_BALANCE', 'DUPLICATE_CODE', 'CODE_OUTSIDE_CATEGORY_RANGE', 'CATEGORY_POLICY_MISMATCH', 'ORPHAN_LEDGER']) expect(kinds).toContain(kind);
  });
  it('R8-LIVE-T4 the encoded owner policy is exactly the five approved prefixes/ranges', () => {
    expect(OWNER_POLICY.map((p: { prefix: string; startRange: number; endRange: number }) => `${p.prefix}:${p.startRange}-${p.endRange}`)).toEqual(['PES:1001-1999', 'SAN:2001-2999', 'EQP:3001-3999', 'ROD:4001-4999', 'CHM:5001-5999']);
  });
});
