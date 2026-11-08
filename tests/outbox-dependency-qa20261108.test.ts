// @vitest-environment jsdom
// QA-20261108 SYNC-03: dependency-aware outbox (unit level; live proof is in the QA evidence pack).
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ uid: 'u-qa-1', reject: new Set<string>(), offline: false, server: new Map<string, any>(), calls: [] as string[] }));
vi.mock('../src/services/supabase', () => ({
  subscribeAuthState: () => () => {},
  getCurrentAuthUser: () => (fake.uid ? { uid: fake.uid } : null),
  supabaseDb: {
    prepareOperations: (ops: any[]) => ops.map(op => ({ ...op, expected: op.expected.kind === 'present' ? { kind: 'present', data: op.expected.exactLegacyPayload } : { kind: 'missing' } })),
    rememberOperations: () => {},
    commitMutation: async (id: string, p: any) => {
      fake.calls.push(id);
      if (fake.offline) throw new TypeError('Failed to fetch');
      if (fake.server.has(id)) return { audit: { id }, replayed: true };
      if (p.operations.some((op: any) => fake.reject.has(op.docId))) throw Object.assign(new Error('INVENTORY_MATERIAL_INVALID'), { code: 'P0001', status: 400 });
      fake.server.set(id, p); return { audit: { id }, replayed: false };
    },
  },
}));
import { enqueueInventoryMutation, InventoryPendingError, listInventoryOutbox, cancelRejectedInventoryOutbox, drainInventoryOutbox, rejectedGroup } from '../src/services/supabaseOutbox';
const mat = (id: string) => [{ kind: 'set', collection: 'materials', docId: id, value: { id, name: 'x' }, expected: { kind: 'missing' } }] as any;
const tx = (id: string, materialId: string, settingsBefore?: any) => [
  ...(settingsBefore ? [{ kind: 'set', collection: 'settings', docId: 'app_config', value: { c: settingsBefore.c + 1 }, expected: { kind: 'present', exactLegacyPayload: settingsBefore } }] : []),
  { kind: 'set', collection: 'transactions', docId: id, value: { id, itemId: materialId }, expected: { kind: 'missing' } }] as any;
const enqueue = (ops: any, id: string) => enqueueInventoryMutation(ops, ops[0].collection === 'materials' ? 'create-material' : 'save-transaction-batch', id, () => {});
beforeEach(async () => {
  fake.reject.clear(); fake.offline = false; fake.server.clear(); fake.calls.length = 0;
  fake.uid = 'u-qa-' + Math.random().toString(36).slice(2);
});
describe('QA-20261108 outbox', () => {
  it('rejected request is kept; an independent later request is sent; a dependent one stays pending with an Arabic reason', async () => {
    fake.reject.add('mat-bad');
    await expect(enqueue(mat('mat-bad'), 'mut-bad-0001')).rejects.toBeInstanceOf(InventoryPendingError);
    const ok = await enqueue(tx('tx-indep', 'mat-existing'), 'mut-ind-0001');
    expect(ok.audit.id).toBe('mut-ind-0001');
    await expect(enqueue(tx('tx-dep', 'mat-bad'), 'mut-dep-0001')).rejects.toThrow(/يعتمد على طلب مرفوض/);
    const rows = await listInventoryOutbox();
    expect(rows.map(r => [r.id, r.status, !!r.waitingOn])).toEqual([['mut-bad-0001', 'blocked', false], ['mut-dep-0001', 'pending', true]]);
    expect(rows[0].lastErrorCode).toBe('INVENTORY_MATERIAL_INVALID');
    expect(fake.calls).not.toContain('mut-dep-0001');
    expect(rejectedGroup(rows).map(r => r.id)).toEqual(['mut-bad-0001', 'mut-dep-0001']);
  });
  it('undo removes only the rejected request and its dependents, never independent ones', async () => {
    fake.reject.add('mat-bad'); fake.offline = false;
    await expect(enqueue(mat('mat-bad'), 'mut-bad-0002')).rejects.toBeInstanceOf(InventoryPendingError);
    fake.offline = true;
    await expect(enqueue(tx('tx-indep2', 'mat-other'), 'mut-ind-0002')).rejects.toBeInstanceOf(InventoryPendingError);
    await expect(enqueue(tx('tx-dep2', 'mat-bad'), 'mut-dep-0002')).rejects.toBeInstanceOf(InventoryPendingError);
    expect((await listInventoryOutbox()).length).toBe(3);
    const n = await cancelRejectedInventoryOutbox(() => {});
    expect(n).toBe(2);
    expect((await listInventoryOutbox()).map(r => r.id)).toEqual(['mut-ind-0002']);
    fake.offline = false;
    const res = await drainInventoryOutbox();
    expect(res.sent).toBe(1); expect(await listInventoryOutbox()).toEqual([]);
  });
  it('lost acknowledgement: resend uses the same mutation id and the server records it once', async () => {
    fake.offline = true;
    await expect(enqueue(tx('tx-ack', 'mat-a'), 'mut-ack-0001')).rejects.toBeInstanceOf(InventoryPendingError);
    fake.offline = false; fake.server.set('mut-ack-0001', { committedBeforeAckLost: true });
    const res = await drainInventoryOutbox();
    expect(res.sent).toBe(1); expect(res.acks.get('mut-ack-0001')?.replayed).toBe(true);
    expect(await listInventoryOutbox()).toEqual([]);
  });
  it('transport failure stops the drain (order preserved) and a later drain resumes', async () => {
    fake.offline = true;
    await expect(enqueue(tx('tx-1', 'mat-a', { c: 1 }), 'mut-ord-0001')).rejects.toBeInstanceOf(InventoryPendingError);
    await expect(enqueue(tx('tx-2', 'mat-b', { c: 2 }), 'mut-ord-0002')).rejects.toBeInstanceOf(InventoryPendingError);
    expect((await drainInventoryOutbox()).stoppedUncertain).toBe(true);
    fake.offline = false;
    const res = await drainInventoryOutbox();
    expect(res.sent).toBe(2); expect([...fake.server.keys()]).toEqual(['mut-ord-0001', 'mut-ord-0002']);
  });
});
