import { describe, expect, it } from 'vitest';
import type { Material, Storehouse } from '../src/types';
import {
  attachTransferPairMetadata,
  compareInventoryTransactions,
  getTransferCompanion,
  validateAtomicWriteCount,
  validateInventoryDataset,
  validateTransferOperation,
  type IntegrityTransaction,
} from '../src/utils/inventoryIntegrity';

const warehouses: Storehouse[] = [
  { id: 'wh-a', name: 'A', active: true },
  { id: 'wh-b', name: 'B', active: true },
];

const materials: Material[] = [
  {
    id: 'mat-1', code: 'M-1', name: 'Material', category: 'General', unit: 'pc', minimumStock: 0,
    currentStock: 0, initialStock: 0, storageLocation: 'A', primaryStorehouseId: 'wh-a',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const tx = (overrides: Partial<IntegrityTransaction>): IntegrityTransaction => ({
  id: 'tx-1',
  transactionNumber: 'W-0001',
  date: '2026-01-01',
  itemId: 'mat-1',
  itemCode: 'M-1',
  itemName: 'Material',
  transactionType: 'وارد',
  transferType: 'in',
  quantity: 10,
  storehouse: 'A',
  storehouseId: 'wh-a',
  stockBefore: 0,
  stockAfter: 10,
  executedBy: 'tester',
  supplierOrReceiver: 'supplier',
  createdAt: '2026-01-01T08:00:00.000Z',
  updatedAt: '2026-01-01T08:00:00.000Z',
  ...overrides,
});

const context = { materials, storehouses: warehouses };

describe('P6 inventory integrity', () => {
  it('orders ledger events deterministically by date, createdAt, then id', () => {
    const rows = [
      tx({ id: 'b', date: '2026-01-02', createdAt: '2026-01-02T09:00:00.000Z' }),
      tx({ id: 'z', date: '2026-01-01', createdAt: '2026-01-01T09:00:00.000Z' }),
      tx({ id: 'a', date: '2026-01-01', createdAt: '2026-01-01T09:00:00.000Z' }),
      tx({ id: 'c', date: '2026-01-01', createdAt: '2026-01-01T08:00:00.000Z' }),
    ].sort(compareInventoryTransactions);
    expect(rows.map((row) => row.id)).toEqual(['c', 'a', 'z', 'b']);
  });

  it('rejects duplicate ids, duplicate transaction numbers, orphans and unknown warehouses', () => {
    const result = validateInventoryDataset([
      tx({ id: 'dup', transactionNumber: 'N-1' }),
      tx({ id: 'dup', transactionNumber: 'N-2' }),
      tx({ id: 'x', transactionNumber: 'N-2', itemId: 'missing' }),
      tx({ id: 'y', transactionNumber: 'N-3', storehouseId: 'missing-wh' }),
    ], context);

    const codes = result.errors.map((error) => error.code);
    expect(codes).toContain('DUPLICATE_TRANSACTION_ID');
    expect(codes).toContain('DUPLICATE_TRANSACTION_NUMBER');
    expect(codes).toContain('MATERIAL_REFERENCE_UNKNOWN');
    expect(codes).toContain('WAREHOUSE_REFERENCE_UNKNOWN');
  });

  it('rejects an intermediate negative balance even if later inbound stock repairs the final total', () => {
    const result = validateInventoryDataset([
      tx({ id: 'out-first', transactionNumber: 'O-1', transactionType: 'صادر', transferType: 'out', quantity: 5, createdAt: '2026-01-01T08:00:00.000Z' }),
      tx({ id: 'in-later', transactionNumber: 'W-2', transactionType: 'وارد', transferType: 'in', quantity: 10, createdAt: '2026-01-01T09:00:00.000Z' }),
    ], context);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'NEGATIVE_RUNNING_BALANCE' && error.transactionId === 'out-first')).toBe(true);
  });

  it('accepts a strictly paired transfer and rejects broken pair metadata', () => {
    const source = tx({
      id: 'transfer-out', transactionNumber: 'T-1-OUT', transactionType: 'تحويل', transferType: 'out', quantity: 4,
      storehouse: 'A', storehouseId: 'wh-a',
    });
    const destination = tx({
      id: 'transfer-in', transactionNumber: 'T-1-IN', transactionType: 'تحويل', transferType: 'in', quantity: 4,
      storehouse: 'B', storehouseId: 'wh-b',
    });
    const [pairedSource, pairedDestination] = attachTransferPairMetadata(source, destination, 'transfer-op-1');

    expect(validateTransferOperation([pairedSource, pairedDestination], 'transfer-op-1').valid).toBe(true);
    expect(getTransferCompanion(pairedSource, [pairedSource, pairedDestination])?.id).toBe('transfer-in');

    const broken = { ...pairedDestination, pairedTransactionId: 'wrong' };
    const brokenResult = validateTransferOperation([pairedSource, broken], 'transfer-op-1');
    expect(brokenResult.valid).toBe(false);
    expect(brokenResult.errors.some((error) => error.code === 'TRANSFER_PAIR_REFERENCE')).toBe(true);
  });

  it('infers one unambiguous legacy OUT/IN transfer companion without pretending ambiguous data is valid', () => {
    const legacyOut = tx({
      id: 'legacy-out', transactionNumber: 'T-0042-OUT', transactionType: 'تحويل', transferType: 'out', quantity: 2,
      storehouseId: 'wh-a',
    });
    const legacyIn = tx({
      id: 'legacy-in', transactionNumber: 'T-0042-IN', transactionType: 'تحويل', transferType: 'in', quantity: 2,
      storehouseId: 'wh-b',
    });
    expect(getTransferCompanion(legacyOut, [legacyOut, legacyIn])?.id).toBe('legacy-in');

    const duplicateLegacyIn = { ...legacyIn, id: 'legacy-in-2', transactionNumber: 'T-0042-IN' };
    expect(getTransferCompanion(legacyOut, [legacyOut, legacyIn, duplicateLegacyIn])).toBeUndefined();
  });

  it('rejects unpaired transfer events in the strict dataset contract', () => {
    const result = validateInventoryDataset([
      tx({ id: 'lonely-transfer', transactionNumber: 'T-9-OUT', transactionType: 'تحويل', transferType: 'out' }),
    ], context);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'TRANSFER_OPERATION_REQUIRED')).toBe(true);
  });

  it('uses legacy initial stock only when the material has no opening transaction', () => {
    const legacyContext = {
      storehouses: warehouses,
      materials: [{ ...materials[0], initialStock: 10 }],
    };
    const legacySpend = validateInventoryDataset([
      tx({ id: 'legacy-out', transactionNumber: 'O-legacy', transactionType: 'صادر', transferType: 'out', quantity: 8 }),
    ], legacyContext);
    expect(legacySpend.valid).toBe(true);

    const explicitOpeningThenSpend = validateInventoryDataset([
      tx({ id: 'opening', transactionNumber: 'OP-1', transactionType: 'افتتاحي', transferType: 'in', quantity: 5, createdAt: '2026-01-01T07:00:00.000Z' }),
      tx({ id: 'out', transactionNumber: 'O-1', transactionType: 'صادر', transferType: 'out', quantity: 8, createdAt: '2026-01-01T08:00:00.000Z' }),
    ], legacyContext);
    expect(explicitOpeningThenSpend.valid).toBe(false);
    expect(explicitOpeningThenSpend.errors.some((error) => error.code === 'NEGATIVE_RUNNING_BALANCE')).toBe(true);
  });

  it('fails closed before an operation can exceed the safe Firestore batch envelope', () => {
    expect(validateAtomicWriteCount(450).valid).toBe(true);
    expect(validateAtomicWriteCount(451).valid).toBe(false);
    expect(validateAtomicWriteCount(-1).valid).toBe(false);
  });
});
