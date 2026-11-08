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
  /** QA-20261108 SYNC-03: id of the rejected request this one depends on (kept pending, not sent). */
  waitingOn?: string;
  /** Server error code of the last definitive rejection (kept for review; never a secret). */
  lastErrorCode?: string;
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
  constructor(readonly mutationId: string, readonly blocked: boolean, message?: string) {
    super(message || (blocked ? 'حُفظ الطلب على الجهاز لكنه يحتاج مراجعة قبل الإرسال.' : 'حُفظ الطلب على الجهاز ولم يؤكد الخادم اكتماله بعد.'));
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
    delete row.waitingOn;
    if (row.status === 'blocked') {
      const code = String((error as { message?: string })?.message || (error as { code?: string })?.code || '').match(/INVENTORY_[A-Z_]+/)?.[0];
      if (code) row.lastErrorCode = code;
    }
    row.lastError = row.status === 'blocked'
      ? 'رفض الخادم هذا الطلب ولم يُعتمد؛ بقي محفوظًا للمراجعة. الطلبات المستقلة عنه تُرسل تلقائيًا.'
      : 'لم يصل إقرار الخادم؛ سيُعاد الإرسال تلقائيًا عند عودة الاتصال دون تكرار الحركة.';
    await store.put(row); emit();
    throw new InventoryPendingError(row.id, row.status === 'blocked');
  }
};

// QA-20261108 SYNC-03: dependency-aware outbox drain.
// A definitively rejected request is kept for review; later requests that touch
// the same records (or the same material) stay pending with a clear reason; all
// independent requests continue. A transport failure (uncertain ack) stops the
// drain so order is preserved; the server de-duplicates by mutation id.
const LABELS_AR: Record<string, string> = {
  'create-material': 'إضافة صنف', 'update-material': 'تعديل صنف', 'delete-material-with-ledger': 'حذف صنف',
  'create-material-with-opening-stock': 'إضافة صنف برصيد افتتاحي', 'save-transaction-batch': 'تسجيل حركة',
  'delete-transaction-batch': 'حذف حركة', 'save-settings-atomic': 'حفظ الإعدادات',
  'rename-reference-and-linked-records': 'إعادة تسمية مرجع', 'import-materials-with-opening-balances': 'استيراد أصناف',
};
export const inventoryRequestLabelAr = (row: { label?: string; rpcLabel?: string }): string =>
  LABELS_AR[row.rpcLabel || row.label || ''] || (/[\u0600-\u06FF]/.test(row.rpcLabel || row.label || '') ? (row.rpcLabel || row.label)! : 'طلب محفوظ');
const materialRefOf = (op: InventorySyncOperation): string | undefined => {
  if (op.collection === 'materials') return op.docId;
  if (op.collection !== 'transactions') return undefined;
  const value = (op.kind === 'set' ? op.value : undefined) as Record<string, unknown> | undefined;
  const before = op.expected.kind === 'present' ? op.expected.exactLegacyPayload as Record<string, unknown> | undefined : undefined;
  const ref = value?.materialId ?? before?.materialId;
  return typeof ref === 'string' && ref ? ref : undefined;
};
export const inventoryDependencyKeys = (row: Pick<Queued, 'operations' | 'transport'>): string[] => {
  if (row.transport === 'supabase-restore-v1') return ['*'];
  const keys = new Set<string>();
  for (const op of row.operations) {
    keys.add(`${op.collection}/${op.docId}`);
    const ref = materialRefOf(op); if (ref) keys.add(`material-ref/${ref}`);
  }
  return [...keys];
};
type Held = Map<string, Queued>;
const holdRow = (held: Held, row: Queued, root: Queued) => { for (const key of inventoryDependencyKeys(row)) if (!held.has(key)) held.set(key, root); };
const blockerFor = (held: Held, row: Queued): Queued | undefined => {
  if (!held.size) return undefined;
  if (row.transport === 'supabase-restore-v1') return held.values().next().value;
  for (const key of inventoryDependencyKeys(row)) { const root = held.get(key) || held.get('*'); if (root) return root; }
  return undefined;
};
export const dependentReasonAr = (root: { label?: string; rpcLabel?: string }) =>
  `معلّق: يعتمد على طلب مرفوض («${inventoryRequestLabelAr(root)}») يمس السجلات نفسها؛ لن يُرسل قبل مراجعة الطلب المرفوض أو التراجع عنه.`;
export interface InventoryDrainResult { sent: number; held: number; stoppedUncertain: boolean; acks: Map<string, InventoryRpcAck> }
let ackPublisher: ((ack: InventoryRpcAck) => void) | null = null;
export const registerInventoryAckPublisher = (fn: (ack: InventoryRpcAck) => void) => { ackPublisher = fn; };
const drainLocked = async (uid: string, options: { includeBlocked: boolean; onAck?: (ack: InventoryRpcAck) => void }): Promise<InventoryDrainResult> => {
  const held: Held = new Map(); const acks = new Map<string, InventoryRpcAck>();
  let sent = 0; let heldCount = 0;
  for (const row of await listInventoryOutbox()) {
    assertOwner(uid);
    if (row.status === 'quarantined') { holdRow(held, row, row); heldCount++; continue; }
    const rejected = row.status === 'blocked' || row.status === 'conflict';
    if (rejected && !options.includeBlocked) { holdRow(held, row, row); heldCount++; continue; }
    const root = blockerFor(held, row);
    if (root) {
      const reason = dependentReasonAr(root);
      if (row.waitingOn !== root.id || row.lastError !== reason || row.status !== 'pending') {
        row.status = 'pending'; row.waitingOn = root.id; row.lastError = reason; row.updatedAt = Date.now();
        await store.put(row); emit();
      }
      holdRow(held, row, root); heldCount++; continue;
    }
    try {
      const ack = await once(row); acks.set(row.id, ack); sent++;
      (options.onAck || ackPublisher)?.(ack);
    } catch (error) {
      if (error instanceof InventoryPendingError && error.blocked) { holdRow(held, row, row); heldCount++; continue; }
      return { sent, held: heldCount, stoppedUncertain: true, acks };
    }
  }
  return { sent, held: heldCount, stoppedUncertain: false, acks };
};
export async function drainInventoryOutbox(options: { includeBlocked?: boolean; onAck?: (ack: InventoryRpcAck) => void } = {}): Promise<InventoryDrainResult> {
  const uid = owner();
  return exclusive(uid, () => drainLocked(uid, { includeBlocked: !!options.includeBlocked, onAck: options.onAck }));
}
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
    if (!previous.length) return once(row);
    const result = await drainLocked(uid, { includeBlocked: false });
    const ack = result.acks.get(row.id);
    if (ack) return ack;
    const current = await store.get(row.id) as Queued | undefined;
    if (current?.status === 'blocked' || current?.status === 'conflict') throw new InventoryPendingError(row.id, true);
    if (current?.waitingOn) throw new InventoryPendingError(row.id, true, current.lastError);
    throw new InventoryPendingError(row.id, false);
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
    const result = await drainLocked(uid, { includeBlocked: true, onAck });
    const rows = await listInventoryOutbox();
    if (rows.length) {
      const first = rows.find(row => row.status === 'blocked' || row.status === 'conflict');
      throw new InventoryPendingError((first || rows[0]).id, !!first || rows.some(row => !!row.waitingOn));
    }
    return result.sent;
  });
}
/** First definitively rejected request plus every later request that depends on it (QA-20261108). */
export const rejectedGroup = <R extends Pick<Queued, 'id' | 'status' | 'operations' | 'transport'>>(rows: R[]): R[] => {
  const index = rows.findIndex(row => row.status === 'blocked' || row.status === 'conflict');
  if (index < 0) return [];
  const root = rows[index] as unknown as Queued; const held: Held = new Map(); holdRow(held, root, root);
  const group: R[] = [rows[index]];
  for (const row of rows.slice(index + 1)) {
    if (blockerFor(held, row as unknown as Queued)) { group.push(row); holdRow(held, row as unknown as Queued, root); }
  }
  return group;
};
export async function cancelRejectedInventoryOutbox(applyProjection: (operations: InventorySyncOperation[]) => void): Promise<number> {
  const uid = owner();
  return exclusive(uid, async () => {
    const all = await listInventoryOutbox();
    // A transport timeout is uncertain; cancellation is only for a definitive atomic NACK.
    const rows = rejectedGroup(all);
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

// QA-20261108 SYNC-03: automatic resume after reconnect, tab focus, sign-in/app reopen,
// and a bounded backoff timer. Rejected requests are never auto-resent.
let autoTimer: ReturnType<typeof setTimeout> | undefined; let autoRunning = false; let autoBackoff = 5_000;
let autoStarted = false;
export function startInventoryOutboxAutoResume(after?: (result: InventoryDrainResult) => void): void {
  if (autoStarted || typeof window === 'undefined') return; autoStarted = true;
  const kick = (delay = 0) => { if (autoTimer) clearTimeout(autoTimer); autoTimer = setTimeout(() => { void run(); }, delay); };
  const run = async () => {
    if (autoRunning) { kick(1_000); return; }
    const uid = getCurrentAuthUser()?.uid;
    if (!uid || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    autoRunning = true;
    try {
      const rows = await store.listForUser(uid);
      const sendable = rows.filter(row => row.status === 'pending' || row.status === 'processing' || row.status === 'retrying');
      if (!sendable.length) return;
      const result = await drainInventoryOutbox({});
      after?.(result);
      if (result.stoppedUncertain) { autoBackoff = Math.min(autoBackoff * 2, 120_000); kick(autoBackoff); }
      else autoBackoff = 5_000;
    } catch { autoBackoff = Math.min(autoBackoff * 2, 120_000); kick(autoBackoff); }
    finally { autoRunning = false; }
  };
  window.addEventListener('online', () => { autoBackoff = 5_000; kick(300); });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(300); });
  subscribeAuthState(user => { if (user) kick(2_000); });
  setInterval(() => { if (cachedCounts.pending > 0 && !autoRunning) kick(0); }, 30_000);
  kick(2_000);
}
export const __testing = { drainLocked, blockerFor, holdRow };
