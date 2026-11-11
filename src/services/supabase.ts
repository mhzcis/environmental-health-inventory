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
supabase?.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT' || (!session && event === 'TOKEN_REFRESHED')) {
    acceptSession(null);
    return;
  }
  acceptSession(session);
});
// QA-20261109 R8 Auth Token HTTP 400: if a stale refresh token is rejected on startup, clear local auth storage cleanly.
if (supabase && supabase.auth.getSession) {
  void supabase.auth.getSession().then(({ error }) => {
    if (error) {
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('refresh token') || msg.includes('invalid grant') || msg.includes('invalid_grant') || (error as { status?: number }).status === 400) {
        void supabase.auth.signOut({ scope: 'local' }).catch(() => {});
        acceptSession(null);
      }
    }
  }).catch(() => {});
}
export const getCurrentAuthUser = (): SupabaseAuthUser | null => currentUser;
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
const decode = <T>(_table: SupabaseTableName, row: Row): T => {
  return { ...row.data, id: row.id } as T;
};
export interface InventoryRpcOperation {
  collection: SupabaseTableName;
  docId: string;
  kind: 'set' | 'delete';
  value?: Record<string, unknown>;
  expected?: { kind: 'present' | 'missing'; data?: Record<string, unknown> };
}
export interface InventoryRpcPayload {
  /** 'correction' (QA-20261109 TX-03): cancel + replacement with an audit link; a server without correction support rejects it atomically. */
  mode: 'mutation' | 'audit' | 'restore' | 'correction';
  label: string;
  operations?: InventoryRpcOperation[];
  backup?: Record<string, unknown>;
  expectedState?: string;
}
export interface InventoryRpcAck {
  audit: Record<string, unknown>;
  replayed: boolean;
}
export interface InventoryRestorePreview {
  expectedState: string;
  diffs: Record<string, { current: number; backup: number; added: number; removed: number; changed: number }>;
  auditHistory: 'preserved';
  authIdentities: 'preserved';
}

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
    return data as InventoryRpcAck;
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
