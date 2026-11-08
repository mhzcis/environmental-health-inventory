import { IndexedDbSyncQueueStore } from './syncQueueStore';
import type { DurableSyncMutation, SyncOperation } from './syncCoordinator';
import { fingerprintDocument } from '../utils/syncProtocol';
import { getCurrentAuthUser, subscribeAuthState, supabaseDb, type InventoryRpcPayload, type InventoryRpcAck, type SupabaseTableName } from './supabase';

export type InventorySyncOperation = (Omit<Extract<SyncOperation, {kind:'set'}>, 'collection'> | Omit<Extract<SyncOperation, {kind:'delete'}>, 'collection'>) & {collection: SupabaseTableName};
type Queued = Omit<DurableSyncMutation, 'operations'> & {
  operations: InventorySyncOperation[];
  transport: 'supabase-v1' | 'supabase-restore-v1';
  rpcLabel: string;
  restorePayload?: InventoryRpcPayload;
};
const store = new IndexedDbSyncQueueStore<Queued>();
const listeners = new Set<() => void>();
let serial: Promise<unknown> = Promise.resolve();
const channel = typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'
  ? new window.BroadcastChannel('inventory-outbox') : null;
let cachedCounts = { pending: 0, blocked: 0, quarantined: 0, processing: 0, ready: false };
export const getInventoryOutboxCounts = () => ({ ...cachedCounts });
let readGeneration = 0;
const refreshCounts = async () => {
  const generation = ++readGeneration; const uid = getCurrentAuthUser()?.uid;
  cachedCounts.ready = false;
  try {
    const rows = uid ? await store.listForUser(uid) : [];
    if (generation !== readGeneration || getCurrentAuthUser()?.uid !== uid) return;
    cachedCounts = { pending: rows.filter(r => r.status === 'pending').length,
      blocked: rows.filter(r => r.status === 'blocked' || r.status === 'conflict').length,
      quarantined: rows.filter(r => r.status === 'quarantined').length,
      processing: rows.filter(r => r.status === 'processing').length, ready: true };
  } catch { cachedCounts = { pending: 0, blocked: 0, quarantined: 1, processing: 0, ready: true }; }
  for (const listener of listeners) listener();
};
subscribeAuthState(() => { void refreshCounts(); });
const notify = () => { void refreshCounts(); for (const listener of listeners) listener(); };
if (channel) channel.onmessage = notify;
const emit = () => { notify(); channel?.postMessage('changed'); };
export class InventoryPendingError extends Error {
  readonly code = 'INVENTORY_PENDING';
  constructor(readonly mutationId: string, readonly blocked: boolean) {
    super(blocked ? 'حُفظ الطلب على الجهاز لكنه يحتاج مراجعة قبل الإرسال.' : 'حُفظ الطلب على الجهاز ولم يؤكد الخادم اكتماله بعد.');
  }
}
export const subscribeInventoryOutbox = (listener: () => void): (() => void) => {
  listeners.add(listener); return () => listeners.delete(listener);
};
const owner = (): string => {
  const uid = getCurrentAuthUser()?.uid;
  if (!uid) throw new Error('INVENTORY_AUTH_REQUIRED');
  return uid;
};
const assertOwner = (uid: string) => {
  if (getCurrentAuthUser()?.uid !== uid) throw new Error('INVENTORY_SESSION_CHANGED');
};
// The browser lock covers stage/send/cancel across tabs; the promise also serializes
// callers in runtimes without Web Locks. The server independently serializes commits.
const exclusive = <T>(uid: string, work: () => Promise<T>): Promise<T> => {
  const run = async () => {
    assertOwner(uid);
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request('inventory-device-data', {mode:'shared'}, () =>
        navigator.locks.request(`inventory-outbox:${uid}`, async () => { assertOwner(uid); return work(); }));
    }
    return work();
  };
  const task = serial.then(run, run);
  serial = task.then(() => undefined, () => undefined);
  return task;
};
export const runInventoryDeviceReset = <T>(work: () => Promise<T>): Promise<T> => {
  const uid = getCurrentAuthUser()?.uid;
  const run = async () => {
    if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('المتصفح لا يدعم قفل بيانات الجهاز الآمن؛ استخدم متصفحًا حديثًا لإعادة الضبط.');
    return navigator.locks.request('inventory-device-data', {mode:'exclusive'}, async () => {
      if (getCurrentAuthUser()?.uid !== uid) throw new Error('INVENTORY_SESSION_CHANGED');
      return work();
    });
  };
  const task = serial.then(run,run); serial = task.then(() => undefined, () => undefined); return task;
};
const isPermanent = (error: unknown) => {
  const e = error as { code?: string; status?: number };
  return /^(22|23|40|42|PGRST)/.test(e?.code || '')
    || !!e?.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
};
export const listInventoryOutbox = async (): Promise<Queued[]> =>
  (await store.listForUser(owner())).filter(row =>
    ['supabase-v1', 'supabase-restore-v1'].includes((row as Queued).transport));
const payloadFor = (row: Queued): InventoryRpcPayload => row.restorePayload || ({
  mode: 'mutation', label: row.rpcLabel,
  operations: row.operations.map(op => ({
    collection: op.collection as SupabaseTableName, docId: op.docId, kind: op.kind,
    ...(op.kind === 'set' ? { value: op.value } : {}),
    expected: op.expected.kind === 'present'
      ? { kind: 'present', data: op.expected.exactLegacyPayload } : { kind: 'missing' },
  })),
});
const once = async (row: Queued): Promise<InventoryRpcAck> => {
  assertOwner(row.userId);
  try {
    row.status = 'processing'; row.updatedAt = Date.now();
    await store.put(row); assertOwner(row.userId); emit();
    const ack = await supabaseDb.commitMutation(row.id, payloadFor(row));
    assertOwner(row.userId);
    await store.delete(row.id); emit();
    return ack;
  } catch (error) {
    assertOwner(row.userId);
    row.attempts++; row.updatedAt = Date.now(); row.status = isPermanent(error) ? 'blocked' : 'pending';
    row.lastError = row.status === 'blocked'
      ? 'الطلب مرفوض أو متعارض؛ راجعه قبل المتابعة.' : 'لم يصل إقرار الخادم؛ أعد المحاولة عند استقرار الاتصال.';
    await store.put(row); emit();
    throw new InventoryPendingError(row.id, row.status === 'blocked');
  }
};
// QA-20261108 rollback-safe patch (minimal, on top of 35861b7): a rejected request holds back only the
// requests that touch the same records; independent requests are still sent and undo never discards them.
const materialRefOf = (op: InventorySyncOperation): string | undefined => {
  if (op.collection === 'materials') return op.docId;
  if (op.collection !== 'transactions') return undefined;
  const value = (op.kind === 'set' ? op.value : undefined) as Record<string, unknown> | undefined;
  const before = op.expected.kind === 'present' ? op.expected.exactLegacyPayload as Record<string, unknown> | undefined : undefined;
  const ref = value?.itemId ?? value?.materialId ?? before?.itemId ?? before?.materialId;
  return typeof ref === 'string' && ref ? ref : undefined;
};
const dependencyKeys = (row: Queued): string[] => {
  if (row.transport === 'supabase-restore-v1') return ['*'];
  const keys = new Set<string>();
  for (const op of row.operations) { keys.add(`${op.collection}/${op.docId}`); const ref = materialRefOf(op); if (ref) keys.add(`material-ref/${ref}`); }
  return [...keys];
};
const isRejected = (row: Queued) => row.status === 'blocked' || row.status === 'conflict' || row.status === 'quarantined';
const touches = (held: Set<string>, row: Queued) => held.has('*') || (row.transport === 'supabase-restore-v1' && held.size > 0) || dependencyKeys(row).some(k => held.has(k));
const rejectedGroupOf = (rows: Queued[]): Queued[] => {
  const index = rows.findIndex(row => row.status === 'blocked' || row.status === 'conflict');
  if (index < 0) return [];
  const held = new Set(dependencyKeys(rows[index])); const group = [rows[index]];
  for (const row of rows.slice(index + 1)) if (touches(held, row)) { group.push(row); dependencyKeys(row).forEach(k => held.add(k)); }
  return group;
};
export const rollbackSafeRejectedGroup = (rows: Queued[]) => rejectedGroupOf(rows);
export async function enqueueInventoryMutation(
  operations: InventorySyncOperation[], label: string, mutationId: string,
  applyProjection: (operations: InventorySyncOperation[]) => void,
): Promise<InventoryRpcAck> {
  const uid = owner();
  return exclusive(uid, async () => {
    const previous = await listInventoryOutbox(); assertOwner(uid);
    if (previous.some(row => row.transport === 'supabase-restore-v1')) throw new Error('INVENTORY_RESTORE_PENDING_WORK');
    const prepared = supabaseDb.prepareOperations(operations);
    const durable = prepared.map(op => ({
      kind: op.kind, collection: op.collection, docId: op.docId,
      ...(op.kind === 'set' ? { value: op.value! } : {}),
      expected: op.expected?.kind === 'present'
        ? { kind: 'present', fingerprint: fingerprintDocument(op.expected.data!), exactLegacyPayload: op.expected.data! }
        : { kind: 'missing' },
    } as InventorySyncOperation));
    const now = Math.max(Date.now(), ...previous.map(row => row.createdAt + 1));
    const existing = await store.get(mutationId); assertOwner(uid);
    if (existing && (existing.userId !== uid || fingerprintDocument(existing.operations) !== fingerprintDocument(durable))) throw new Error('INVENTORY_MUTATION_ID_REUSED');
    const row: Queued = existing as Queued || {
      id: mutationId, userId: uid, operations: durable, label, rpcLabel: label, transport: 'supabase-v1',
      status: 'pending', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
    };
    if (!existing) await store.insert(row);
    assertOwner(uid);
    supabaseDb.rememberOperations(prepared);
    try { applyProjection(row.operations); }
    catch {
      row.status = 'quarantined'; row.lastError = 'الطلب محفوظ لكن تعذر تحديث عرض الجهاز؛ لا تمسح البيانات.';
      await store.put(row); emit(); throw new InventoryPendingError(row.id, true);
    }
    emit();
    const earlier = previous.filter(r => r.id !== row.id);
    if (earlier.some(r => !isRejected(r))) throw new InventoryPendingError(row.id, false);
    const held = new Set(earlier.flatMap(dependencyKeys));
    if (earlier.length && touches(held, row)) throw new InventoryPendingError(row.id, true);
    return once(row);
  });
}
export async function resumeInventoryProjection(applyProjection: (operations: InventorySyncOperation[]) => void): Promise<number> {
  const uid = owner();
  return exclusive(uid, async () => {
    const rows = await listInventoryOutbox();
    for (const row of rows) {
      assertOwner(uid);
      if (row.transport === 'supabase-v1') {
        applyProjection(row.operations);
        supabaseDb.rememberOperations(payloadFor(row).operations!);
      }
    }
    return rows.length;
  });
}
export async function retryInventoryOutbox(onAck: (ack: InventoryRpcAck) => void): Promise<number> {
  const uid = owner();
  return exclusive(uid, async () => {
    let count = 0;
    const held = new Set<string>(); let firstError: unknown;
    for (const row of await listInventoryOutbox()) {
      assertOwner(uid);
      if (touches(held, row)) { dependencyKeys(row).forEach(k => held.add(k)); continue; }
      try { onAck(await once(row)); count++; }
      catch (error) {
        firstError ??= error; dependencyKeys(row).forEach(k => held.add(k));
        if (!(error instanceof InventoryPendingError && error.blocked)) break; // uncertain transport: keep order, stop
      }
    }
    if (firstError && !count) throw firstError;
    return count;
  });
}
export async function cancelRejectedInventoryOutbox(applyProjection: (operations: InventorySyncOperation[]) => void): Promise<number> {
  const uid = owner();
  return exclusive(uid, async () => {
    // A transport timeout is uncertain; cancellation is only for a definitive atomic NACK, and only for
    // the rejected request plus the requests that depend on it (same records). Independent requests stay.
    const rows = rejectedGroupOf(await listInventoryOutbox());
    if (!rows.length) throw new Error('INVENTORY_UNCERTAIN_CANNOT_CANCEL');
    for (const row of [...rows].reverse()) {
      assertOwner(uid);
      const inverse = [...row.operations].reverse().map(op => op.expected.kind === 'present'
        ? { kind: 'set', collection: op.collection, docId: op.docId, value: op.expected.exactLegacyPayload!, expected: { kind: 'missing' } }
        : { kind: 'delete', collection: op.collection, docId: op.docId, expected: { kind: 'missing' } });
      applyProjection(inverse as InventorySyncOperation[]);
      supabaseDb.rememberOperations(inverse.map(op => ({ ...op, collection: op.collection as SupabaseTableName })) as Parameters<typeof supabaseDb.rememberOperations>[0]);
    }
    for (const row of rows) { assertOwner(uid); await store.delete(row.id); }
    emit(); return rows.length;
  });
}
export async function enqueueInventoryRestore(backup: Record<string, unknown>, expectedState: string): Promise<InventoryRpcAck> {
  const uid = owner();
  return exclusive(uid, async () => {
    if ((await listInventoryOutbox()).length) throw new Error('INVENTORY_RESTORE_PENDING_WORK');
    const now = Date.now();
    const row: Queued = {
      id: `restore-${crypto.randomUUID()}`, userId: uid, operations: [], label: 'استعادة بيانات التطبيق', rpcLabel: 'استعادة بيانات التطبيق',
      transport: 'supabase-restore-v1', status: 'pending', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
      restorePayload: { mode: 'restore', label: 'استعادة بيانات التطبيق', backup, expectedState },
    };
    await store.insert(row); assertOwner(uid); emit();
    return once(row);
  });
}
