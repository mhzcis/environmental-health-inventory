import { describe, expect, it } from 'vitest';
import { validateInventoryDataset } from './inventoryIntegrity';

const tx = { id: 't1', transactionNumber: 'W-0001', itemId: 'm1', storehouseId: 'wh-a', date: '2026-11-05', transactionType: 'وارد', quantity: 3 };
const storehouses = [{ id: 'wh-a', name: 'A', active: true }];

describe('QA-20261106 transactions_view without materials_view', () => {
  it('still rejects unknown material references when materials are readable', () => {
    const r = validateInventoryDataset([tx] as never, { materials: [], storehouses });
    expect(r.errors.map(e => e.code)).toContain('MATERIAL_REFERENCE_UNKNOWN');
  });
  it('does not lock out an account whose RLS hides materials (server remains authoritative)', () => {
    const r = validateInventoryDataset([tx] as never, { materials: [], storehouses, materialReferencesUnreadable: true });
    expect(r.valid).toBe(true);
  });
  it('keeps the other identity checks when materials are unreadable', () => {
    const r = validateInventoryDataset([tx, { ...tx, id: 't2' }] as never, { materials: [], storehouses, materialReferencesUnreadable: true });
    expect(r.errors.map(e => e.code)).toContain('DUPLICATE_TRANSACTION_NUMBER');
  });
});
