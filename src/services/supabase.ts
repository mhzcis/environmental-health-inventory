import type { InventorySyncOperation } from './supabaseOutbox';
import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import { isSupabaseConfigured, passwordRecoveryUrl, supabasePublicKey as key, supabaseUrl as url } from './supabaseConfig';
export { isSupabaseConfigured } from './supabaseConfig';

export type SupabaseTableName = 'users' | 'settings' | 'materials' | 'transactions' | 'generator_logs' | 'audit_logs';
export interface SupabaseAuthUser {
  uid: string;
  email: string | null;
  metadata: { creationTime?: string; lastSignInTime?: string };
}
export const supabase: SupabaseClient | null = isSupabaseConfigured()
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
// Password verification uses an isolated client so it cannot replace the active session.
export const secondarySupabase: SupabaseClient | null = isSupabaseConfigured()
  ? createClient(url, key, { auth: { storageKey: 'inventory-password-verification-v1', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;

const remoteBaselines = new Map<string, Record<string, unknown>>();
let baselineRevision = 0;
let currentUser: SupabaseAuthUser | null = null;
let initialized = false;
let token: string | null = null;
const authListeners = new Set<(user: SupabaseAuthUser | null) => void>();
const userShape = (user: User): SupabaseAuthUser => ({
  uid: user.id,
  email: user.email || null,
  metadata: { creationTime: user.created_at, lastSignInTime: user.last_sign_in_at },
});
const acceptSession = (session: Session | null) => {
  const nextToken = session?.access_token || null;
  const changed = !initialized || nextToken !== token;
  initialized = true;
  token = nextToken;
  if (!changed) return;
  if (currentUser?.uid !== session?.user?.id) { remoteBaselines.clear(); baselineRevision++; }
  currentUser = session?.user ? userShape(session.user) : null;
  const delivered = currentUser;
  // Never start an async Supabase call inside the auth lock.
  queueMicrotask(() => {
    if (currentUser !== delivered) return;
    for (const listener of authListeners) listener(delivered);
  });
};
// R8-R1 (R2-R8-06): guarded like getSession below; a client/test double without auth never throws at module load.
if (typeof supabase?.auth?.onAuthStateChange === 'function') supabase.auth.onAuthStateChange((_event, session) => acceptSession(session));
// R8-AUTH-01: read the persisted session explicitly at start (works offline from storage). Guarded because some
// SDK builds/test doubles have no getSession; a failure leaves the onAuthStateChange path unchanged.
if (supabase && typeof supabase.auth?.getSession === 'function') {
  void Promise.resolve()
    .then(() => supabase.auth.getSession())
    .then(result => { const session = result?.data?.session; if (!initialized && session) acceptSession(session); })
    .catch(() => { /* the auth state listener remains the source of truth */ });
}
export const getCurrentAuthUser = (): SupabaseAuthUser | null => currentUser;
/**
 * R8-R1 (R2-R8-09): "retry now" from the online-required state when no user was delivered (offline cold start with an
 * expired token). Asks the SDK to refresh the persisted session; a delivered session re-runs the normal live
 * revalidation through the auth listeners. Never throws; resolves false when no session could be obtained.
 */
export const refreshAuthSession = async (): Promise<boolean> => {
  try {
    const auth = supabase?.auth as unknown as {
      refreshSession?: () => Promise<{ data?: { session?: Session | null } }>;
      getSession?: () => Promise<{ data?: { session?: Session | null } }>;
    } | undefined;
    const result = typeof auth?.refreshSession === 'function' ? await auth.refreshSession()
      : typeof auth?.getSession === 'function' ? await auth.getSession() : null;
    const session = result?.data?.session ?? null;
    if (!session) return false;
    acceptSession(session);
    return true;
  } catch { return false; }
};
/** R8-AUTH-01: whether this device still holds a persisted Supabase session (presence only; the token is never read). */
export const hasPersistedAuthSession = (): boolean => {
  try {
    if (typeof localStorage === 'undefined') return false;
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);
      if (name && /^sb-[^-]+(?:-[^-]+)*-auth-token$/.test(name) && localStorage.getItem(name)) return true;
    }
  } catch { /* storage unavailable */ }
  return false;
};
export const subscribeAuthState = (listener: (user: SupabaseAuthUser | null) => void): (() => void) => {
  authListeners.add(listener);
  if (initialized || !supabase) queueMicrotask(() => { if (authListeners.has(listener)) listener(currentUser); });
  return () => { authListeners.delete(listener); };
};
const client = (): SupabaseClient => {
  if (!supabase) throw new Error('SUPABASE_NOT_CONFIGURED');
  return supabase;
};
export async function supabaseAuthSignIn(email: string, password: string): Promise<SupabaseAuthUser> {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error('AUTH_SESSION_MISSING');
  acceptSession(data.session);
  return currentUser!;
}
export async function supabaseAuthSignOut(): Promise<void> {
  const { error } = await client().auth.signOut({ scope: 'local' });
  if (error) throw error;
  acceptSession(null);
}
export async function supabaseAuthVerifyPassword(email: string, password: string): Promise<void> {
  if (!secondarySupabase) throw new Error('SUPABASE_NOT_CONFIGURED');
  const { error } = await secondarySupabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const result = await secondarySupabase.auth.signOut({ scope: 'local' });
  if (result.error) throw result.error;
}
export async function supabaseSendPasswordReset(email: string): Promise<void> {
  const redirectTo = typeof window === 'undefined' ? undefined : passwordRecoveryUrl(window.location.href);
  const { error } = await client().auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}
export async function supabaseAdminCreateAuthUser(email: string, password: string, fullName: string): Promise<SupabaseAuthUser> {
  const { data, error } = await client().functions.invoke('inventory-manage-users', {
    body: { email, password, fullName },
  });
  if (error) throw error;
  if (!data?.user?.id) throw new Error(data?.error || 'USER_CREATION_FAILED');
  return userShape(data.user);
}

const allowedTables = new Set<SupabaseTableName>(['users', 'settings', 'materials', 'transactions', 'generator_logs', 'audit_logs']);
const assertTable = (table: SupabaseTableName) => {
  if (!allowedTables.has(table)) throw new Error('UNSUPPORTED_SUPABASE_TABLE');
};
type Row = { id: string; data: Record<string, unknown>; [key: string]: unknown };
const decode = <T>(table: SupabaseTableName, row: Row): T => {
  return { ...row.data, id: row.id } as T;
};
export interface InventoryRpcOperation {
  collection: SupabaseTableName;
  docId: string;
  kind: 'set' | 'delete';
  value?: Record<string, unknown>;
  expected?: { kind: 'present' | 'missing'; data?: Record<string, unknown> };
}
export interface InventoryLifecycleRequest {
  action: 'archive' | 'reactivate';
  materialId: string;
  expectedLifecycleVersion: number;
  reason: string;
  purpose?: 'qa_test_data' | 'discontinued';
}
export interface InventoryRpcPayload {
  /** 'correction' (QA-20261109 TX-03): cancel + replacement with an audit link; a server without correction support rejects it atomically.
   *  'lifecycle' (R8-ARC-01): archive/reactivate one material; an older server rejects it atomically (INVENTORY_OPERATIONS_INVALID). */
  mode: 'mutation' | 'audit' | 'restore' | 'correction' | 'lifecycle';
  label: string;
  operations?: InventoryRpcOperation[];
  backup?: Record<string, unknown>;
  expectedState?: string;
  lifecycle?: InventoryLifecycleRequest;
}
export interface InventoryRpcAck {
  audit: Record<string, unknown>;
  replayed: boolean;
  /** R8-DATA-01: server-confirmed material rows (ledger projection recomputed inside the same transaction). Absent on older servers. */
  materials?: Record<string, unknown>[];
}
export interface InventoryNextCode { code: string; prefix: string; number: number; category: string; provisional: true }
export interface InventoryRestorePreview {
  expectedState: string;
  diffs: Record<string, { current: number; backup: number; added: number; removed: number; changed: number }>;
  auditHistory: 'preserved';
  authIdentities: 'preserved';
  registry?: {
    ok: boolean; missingCodeRegistry: boolean; error?: string | null; warnings: unknown;
    rejected: unknown; newReservations: unknown; tailReservations: unknown;
    maxReferenced: unknown; conservativeMax: unknown; willRefuse?: boolean;
  };
}

const encode = (table: SupabaseTableName, id: string, payload: Record<string, unknown>): Row => {
  const data = { ...payload, id };
  const row: Row = { id, data, updated_at: new Date().toISOString() };
  if (table === 'users') Object.assign(row, {
    auth_uid: payload.authUid || id,
    username: payload.username,
    full_name: payload.fullName,
    role: payload.role,
    permissions: payload.permissions,
    active: payload.active !== false,
    created_at: payload.createdAt,
  });
  return row;
};
const PAGE_SIZE = 500;
export const supabaseDb = {
  async getDoc<T = Record<string, unknown>>(table: SupabaseTableName, id: string): Promise<T | null> {
    assertTable(table);
    const revision = baselineRevision; const uid = currentUser?.uid;
    const { data, error } = await client().from(table).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (uid !== currentUser?.uid) throw new Error('INVENTORY_SESSION_CHANGED');
    if (revision !== baselineRevision) throw new Error('INVENTORY_SNAPSHOT_CHANGED');
    if (data) remoteBaselines.set(`${table}/${id}`, structuredClone(data.data));
    if (!data) remoteBaselines.delete(`${table}/${id}`);
    return data ? decode<T>(table, data) : null;
  },
  async getCollection<T = Record<string, unknown>>(table: SupabaseTableName): Promise<T[]> {
    assertTable(table);
    const revision = baselineRevision; const uid = currentUser?.uid;
    const rows: T[] = []; const rawRows: Row[] = [];
    // Supabase caps each response: always fetch every page with a stable ordering.
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await client().from(table).select('*').order('id').range(offset, offset + PAGE_SIZE - 1);
      if (error) throw error;
      if (uid !== currentUser?.uid) throw new Error('INVENTORY_SESSION_CHANGED');
      if (revision !== baselineRevision) throw new Error('INVENTORY_SNAPSHOT_CHANGED');
      rawRows.push(...(data || []));
      rows.push(...(data || []).map(row => decode<T>(table, row)));
      if (!data || data.length < PAGE_SIZE) {
        for (const row of rawRows) remoteBaselines.set(`${table}/${row.id}`, structuredClone(row.data));
        const ids = new Set(rows.map(row => (row as { id: string }).id));
        for (const cacheKey of remoteBaselines.keys()) if (cacheKey.startsWith(`${table}/`) && !ids.has(cacheKey.slice(table.length + 1))) remoteBaselines.delete(cacheKey);
        return rows;
      }
    }
  },
  prepareOperations(operations: InventorySyncOperation[]): InventoryRpcOperation[] {
    return operations.map(op => {
      const table = op.collection as SupabaseTableName;
      assertTable(table);
      const cached = remoteBaselines.get(`${table}/${op.docId}`);
      const baseline = cached ?? (op.expected.kind === 'present' ? op.expected.exactLegacyPayload : undefined);
      if (!baseline && op.expected.kind === 'present') throw new Error('INVENTORY_BASELINE_REQUIRED');
      return {
        collection: table, docId: op.docId, kind: op.kind,
        ...(op.kind === 'set' ? { value: { ...op.value, id: op.docId } } : {}),
        expected: baseline ? { kind: 'present', data: structuredClone(baseline) } : { kind: 'missing' },
      };
    });
  },
  rememberOperations(operations: InventoryRpcOperation[]): void {
    baselineRevision++;
    for (const op of operations) {
      const key = `${op.collection}/${op.docId}`;
      if (op.kind === 'delete') remoteBaselines.delete(key);
      else if (op.value) remoteBaselines.set(key, structuredClone(op.value));
    }
  },
  async commitMutation(mutationId: string, payload: InventoryRpcPayload): Promise<InventoryRpcAck> {
    const uid = currentUser?.uid;
    const { data, error } = await client().rpc('inventory_commit', { p_mutation_id: mutationId, p_payload: payload });
    if (error) throw error;
    if (uid !== currentUser?.uid) throw new Error('INVENTORY_SESSION_CHANGED');
    if (!data || data.audit?.id !== mutationId) throw new Error('INVENTORY_ACK_INVALID');
    if (payload.operations) this.rememberOperations(payload.operations);
    // R8-DATA-01: the server row (with recomputed projections) is the next expected baseline.
    if (Array.isArray(data.materials)) {
      baselineRevision++;
      for (const row of data.materials as Record<string, unknown>[]) {
        if (row && typeof row.id === 'string') remoteBaselines.set(`materials/${row.id}`, structuredClone(row));
      }
    }
    return data as InventoryRpcAck;
  },
  /** R8-CODE-01: central next-code read (provisional until commit_inventory reserves it). */
  /** R8-R1 (RT-R8-04): the permanent code registry (live, archived and deleted reservations) for a full backup. Admin only. */
  async codeRegistry(): Promise<{ code: string; materialId: string; deleted: boolean }[]> {
    const { data, error } = await client().rpc('inventory_code_registry');
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('INVENTORY_CODE_REGISTRY_INVALID');
    return data.map((row: Record<string, unknown>) => ({ code: String(row.code), materialId: String(row.materialId), deleted: row.deleted === true }));
  },
  async nextMaterialCode(category: string): Promise<InventoryNextCode> {
    const { data, error } = await client().rpc('inventory_next_material_code', { p_category: category });
    if (error) throw error;
    if (!data?.code) throw new Error('INVENTORY_CODE_INVALID_RESPONSE');
    return data as InventoryNextCode;
  },
  /** R8-DATA-01: read-only drift check (no write). */
  async projectionDrift(): Promise<{ materials: number; drift: number; rows: Record<string, unknown>[] }> {
    const { data, error } = await client().rpc('inventory_projection_drift', {});
    if (error) throw error;
    return data;
  },
  async previewRestore(backup: Record<string, unknown>): Promise<InventoryRestorePreview> {
    const { data, error } = await client().rpc('inventory_restore_preview', { p_backup: backup });
    if (error) throw error;
    if (!data?.expectedState || !data.diffs) throw new Error('INVENTORY_RESTORE_PREVIEW_INVALID');
    return data as InventoryRestorePreview;
  },
  async upsertDoc(table: SupabaseTableName, id: string, payload: Record<string, unknown>): Promise<void> {
    await this.upsertDocs(table, [{ id, payload }]);
  },
  async upsertDocs(table: SupabaseTableName, entries: Array<{ id: string; payload: Record<string, unknown> }>): Promise<void> {
    assertTable(table);
    if (entries.length === 0) return;
    const operations = entries.map(entry => {
      const data = remoteBaselines.get(`${table}/${entry.id}`);
      return { collection: table, docId: entry.id, kind: 'set' as const, value: { ...entry.payload, id: entry.id }, expected: data ? { kind: 'present' as const, data } : { kind: 'missing' as const } };
    });
    await this.commitMutation(crypto.randomUUID(), { mode: 'mutation', label: 'حفظ بيانات التطبيق', operations });
  },
  async appendAuditLogs(entries: Array<{ id: string; payload: Record<string, unknown> }>): Promise<Record<string, unknown>[]> {
    const receipts: Record<string, unknown>[] = [];
    for (const entry of entries) {
      const ack = await this.commitMutation(entry.id, { mode: 'audit', label: 'حدث في التطبيق', operations: [{ collection: 'audit_logs', docId: entry.id, kind: 'set', value: entry.payload }] });
      receipts.push(ack.audit);
    }
    return receipts;
  },
  async updateExistingSettings(payload: Record<string, unknown>): Promise<void> {
    if (!remoteBaselines.has('settings/app_config')) throw new Error('INVENTORY_BASELINE_REQUIRED');
    await this.upsertDoc('settings', 'app_config', payload);
  },
  async deleteDocs(table: SupabaseTableName, ids: string[]): Promise<void> {
    assertTable(table);
    if (ids.length === 0) return;
    const operations = ids.map(id => {
      const data = remoteBaselines.get(`${table}/${id}`);
      if (!data) throw new Error('INVENTORY_BASELINE_REQUIRED');
      return { collection: table, docId: id, kind: 'delete' as const, expected: { kind: 'present' as const, data } };
    });
    await this.commitMutation(crypto.randomUUID(), { mode: 'mutation', label: 'حذف سجلات محددة', operations });
  },
  subscribeTables(tables: SupabaseTableName[], onChange: (table: SupabaseTableName) => void | Promise<void>): () => void {
    let active = true;
    const sb = client();
    const timers = new Map<SupabaseTableName, ReturnType<typeof setTimeout>>();
    const running = new Set<SupabaseTableName>();
    const dirty = new Set<SupabaseTableName>();
    const schedule = (table: SupabaseTableName) => {
      if (!active) return;
      dirty.add(table);
      if (running.has(table) || timers.has(table)) return;
      timers.set(table, setTimeout(async () => {
        timers.delete(table); if (!active) return;
        running.add(table); dirty.delete(table);
        try { await onChange(table); }
        catch (error) {
          // Retry only a read invalidated by a newer local ACK, without waiting
          // for another row event. Network/permission failures are not polled.
          if (error instanceof Error && error.message === 'INVENTORY_SNAPSHOT_CHANGED') dirty.add(table);
          else console.error('Realtime reconciliation failed');
        }
        finally { running.delete(table); if (dirty.has(table)) schedule(table); }
      }, 250));
    };
    let channel = sb.channel(`inventory-${crypto.randomUUID()}`);
    for (const table of tables) {
      assertTable(table);
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => schedule(table));
    }
    channel.subscribe();
    return () => { active = false; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); dirty.clear(); void sb.removeChannel(channel); };
  },
};
