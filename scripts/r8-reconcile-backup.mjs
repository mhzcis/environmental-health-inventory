#!/usr/bin/env node
// R8-LIVE-01/02: OFFLINE, read-only reconciliation of an application backup file (no network, no writes).
// For every material: ledger projection per warehouse (same rules as inventory_private.material_projection) vs the
// stored cache; opening entered once (never both an opening movement and an initialStock effect); codes against the
// approved category policy (prefix + range, duplicates); archived items listed separately (history kept).
// Usage: node scripts/r8-reconcile-backup.mjs <backup.json>   -> JSON report; exit 1 on any finding.
import fs from 'node:fs';

export const OWNER_POLICY = Object.freeze([
  { prefix: 'PES', startRange: 1001, endRange: 1999 }, { prefix: 'SAN', startRange: 2001, endRange: 2999 },
  { prefix: 'EQP', startRange: 3001, endRange: 3999 }, { prefix: 'ROD', startRange: 4001, endRange: 4999 },
  { prefix: 'CHM', startRange: 5001, endRange: 5999 },
]);
const IN_TYPES = new Set(['وارد', 'افتتاحي']);
const sign = (t) => (IN_TYPES.has(t.transactionType) || (['تسوية', 'تحويل'].includes(t.transactionType) && t.transferType === 'in') ? 1 : -1);
const isOpening = (t) => t.transactionType === 'افتتاحي' || String(t.id || '').startsWith('tr-init');
const round = (n) => Math.round(n * 1e6) / 1e6;

export function reconcileBackup(backup, policy = OWNER_POLICY) {
  const findings = [];
  const settings = backup.settings || {};
  const warehouses = new Map((settings.storehouseEntities || []).map(w => [w.id, w]));
  const materials = Array.isArray(backup.materials) ? backup.materials : [];
  const transactions = Array.isArray(backup.transactions) ? backup.transactions : [];
  const byItem = new Map();
  for (const t of transactions) { if (!byItem.has(t.itemId)) byItem.set(t.itemId, []); byItem.get(t.itemId).push(t); }
  const known = new Set(materials.map(m => m.id));
  for (const itemId of byItem.keys()) if (!known.has(itemId)) findings.push({ kind: 'ORPHAN_LEDGER', itemId });
  // Category policy (owner decision): the configured categories must equal the approved prefixes/ranges.
  const cats = (settings.categories || []).map(c => ({ name: c.name, prefix: String(c.prefix || '').toUpperCase(), startRange: Number(c.startRange), endRange: Number(c.endRange) }));
  const policyKey = (rows) => rows.map(r => `${r.prefix}:${r.startRange}-${r.endRange}`).sort().join('|');
  if (policyKey(cats) !== policyKey(policy)) findings.push({ kind: 'CATEGORY_POLICY_MISMATCH', configured: policyKey(cats), approved: policyKey(policy) });
  const seenCodes = new Map();
  const rows = materials.map(m => {
    const ledger = byItem.get(m.id) || [];
    const byId = {};
    for (const t of ledger) if (t.storehouseId) byId[t.storehouseId] = round((byId[t.storehouseId] || 0) + sign(t) * Number(t.quantity));
    const openingRows = ledger.filter(isOpening).length;
    if (Number(m.initialStock) > 0 && openingRows === 0 && m.primaryStorehouseId) byId[m.primaryStorehouseId] = round((byId[m.primaryStorehouseId] || 0) + Number(m.initialStock));
    const ledgerTotal = round(Object.values(byId).reduce((a, b) => a + b, 0));
    const activeTotal = round(Object.entries(byId).filter(([id]) => warehouses.get(id)?.active).reduce((a, [, q]) => a + q, 0));
    const storedById = m.warehouseStocksById || {};
    const drift = Number(m.currentStock ?? NaN) !== activeTotal || JSON.stringify(Object.entries(storedById).sort()) !== JSON.stringify(Object.entries(byId).sort());
    if (drift) findings.push({ kind: 'PROJECTION_DRIFT', id: m.id, code: m.code, storedCurrentStock: m.currentStock, ledgerActiveTotal: activeTotal, storedById, ledgerById: byId });
    if (openingRows > 1) findings.push({ kind: 'OPENING_DUPLICATED', id: m.id, code: m.code, openingRows });
    for (const [wid, q] of Object.entries(byId)) if (q < 0) findings.push({ kind: 'NEGATIVE_BALANCE', id: m.id, warehouseId: wid, quantity: q });
    const key = String(m.code || '').trim().toUpperCase();
    if (seenCodes.has(key)) findings.push({ kind: 'DUPLICATE_CODE', code: m.code, ids: [seenCodes.get(key), m.id] }); else seenCodes.set(key, m.id);
    const match = key.match(/^([A-Z]{2,6})-([1-9][0-9]*)$/);
    const category = cats.find(c => c.name === m.category);
    if (!match) findings.push({ kind: 'CODE_NOT_CANONICAL', id: m.id, code: m.code });
    else if (!category || category.prefix !== match[1] || Number(match[2]) < category.startRange || Number(match[2]) > category.endRange) {
      findings.push({ kind: 'CODE_OUTSIDE_CATEGORY_RANGE', id: m.id, code: m.code, category: m.category });
    }
    return { id: m.id, code: m.code, archived: m.lifecycleStatus === 'archived', ledgerRows: ledger.length, openingRows, ledgerById: byId, ledgerTotal, activeTotal };
  });
  const active = rows.filter(r => !r.archived);
  return {
    counts: { materials: materials.length, activeMaterials: active.length, archivedMaterials: rows.length - active.length, transactions: transactions.length },
    totals: { activeStock: round(active.reduce((a, r) => a + r.activeTotal, 0)), archivedHistoricalStock: round(rows.filter(r => r.archived).reduce((a, r) => a + r.ledgerTotal, 0)) },
    materials: rows, findings, ok: findings.length === 0,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/r8-reconcile-backup.mjs <backup.json>'); process.exit(2); }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const backup = parsed.data && !parsed.materials ? parsed.data : parsed;
  const report = reconcileBackup(backup);
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.ok ? 0 : 1);
}
