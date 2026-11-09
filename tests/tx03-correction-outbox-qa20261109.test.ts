// @vitest-environment jsdom
// QA-20261109 TX-03: corrections are sent with mode 'correction' (stored with the request), so a server without
// correction support (the #8 rollback target) rejects them atomically and the request is kept, never half-applied.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ uid: 'u', supportsCorrection: false, server: new Map<string, any>(), calls: [] as any[] }));
vi.mock('../src/services/supabase', () => ({
  subscribeAuthState: () => () => {},
  getCurrentAuthUser: () => (fake.uid ? { uid: fake.uid } : null),
  supabaseDb: {
    prepareOperations: (ops: any[]) => ops.map(op => ({ ...op, expected: op.expected.kind === 'present' ? { kind: 'present', data: op.expected.exactLegacyPayload } : { kind: 'missing' } })),
    rememberOperations: () => {},
    commitMutation: async (id: string, p: any) => {
      fake.calls.push({ id, mode: p.mode });
      if (!['mutation', 'audit', 'restore', ...(fake.supportsCorrection ? ['correction'] : [])].includes(p.mode))
        throw Object.assign(new Error('INVENTORY_OPERATIONS_INVALID'), { code: '22023', status: 400 });
      if (fake.server.has(id)) return { audit: { id }, replayed: true };
      fake.server.set(id, p); return { audit: { id, removedTransactions: [{ id: 't-orig' }], corrections: [{}] }, replayed: false };
    },
  },
}));
import { enqueueInventoryMutation, InventoryPendingError, isCorrectionRequest, listInventoryOutbox, retryInventoryOutbox } from '../src/services/supabaseOutbox';
const original = { id: 't-orig', transactionNumber: 'W-1', quantity: 19 };
const correctionOps = () => [
  { kind: 'delete', collection: 'transactions', docId: 't-orig', expected: { kind: 'present', exactLegacyPayload: original } },
  { kind: 'set', collection: 'transactions', docId: 't-repl', value: { id: 't-repl', quantity: 18, correctionOf: { id: 't-orig', transactionNumber: 'W-1', quantity: 19 } }, expected: { kind: 'missing' } },
] as any;
const plainOps = (id: string) => [{ kind: 'set', collection: 'transactions', docId: id, value: { id, quantity: 1 }, expected: { kind: 'missing' } }] as any;
beforeEach(() => { fake.supportsCorrection = false; fake.server.clear(); fake.calls.length = 0; fake.uid = 'u-' + Math.random().toString(36).slice(2); });
describe('QA-20261109 TX-03 correction outbox', () => {
  it('detects correction requests only from a correctionOf link on a transaction set', () => {
    expect(isCorrectionRequest(correctionOps())).toBe(true);
    expect(isCorrectionRequest(plainOps('t-x'))).toBe(false);
    expect(isCorrectionRequest([{ kind: 'set', collection: 'materials', value: { correctionOf: {} } }] as any)).toBe(false);
  });
  it('server without correction support: request is blocked and kept with an Arabic reason, nothing committed', async () => {
    const err = await enqueueInventoryMutation(correctionOps(), 'correct-transaction', 'mut-corr-0001', () => {}).catch(e => e);
    expect(err).toBeInstanceOf(InventoryPendingError);
    expect(err.blocked).toBe(true);
    expect(fake.calls).toEqual([{ id: 'mut-corr-0001', mode: 'correction' }]);
    expect(fake.server.size).toBe(0);
    const [row] = await listInventoryOutbox();
    expect(row.id).toBe('mut-corr-0001'); expect(row.status).toBe('blocked');
    expect(row.lastErrorCode).toBe('INVENTORY_OPERATIONS_INVALID');
    expect(row.lastError).toMatch(/لا يدعم تصحيح الحركات/);
    expect((row as any).restorePayload.mode).toBe('correction');
  });
  it('after the server upgrade the SAME request is resent in correction mode and recorded once', async () => {
    await enqueueInventoryMutation(correctionOps(), 'correct-transaction', 'mut-corr-0002', () => {}).catch(() => {});
    fake.supportsCorrection = true;
    const acks: any[] = [];
    expect(await retryInventoryOutbox(a => acks.push(a))).toBe(1);
    expect(fake.calls.map(c => c.mode)).toEqual(['correction', 'correction']);
    expect(fake.server.size).toBe(1); expect(acks[0].audit.removedTransactions.length).toBe(1);
    expect(await listInventoryOutbox()).toEqual([]);
  });
  it('plain requests keep mode mutation', async () => {
    fake.supportsCorrection = true;
    await enqueueInventoryMutation(plainOps('t-p'), 'save-transaction-batch', 'mut-plain-0001', () => {});
    expect(fake.calls).toEqual([{ id: 'mut-plain-0001', mode: 'mutation' }]);
  });
});
