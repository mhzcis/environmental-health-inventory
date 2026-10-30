import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import config from '../../supabase-config.json';

export type SupabaseTableName = 'users' | 'settings' | 'materials' | 'transactions' | 'generator_logs' | 'audit_logs';
export interface SupabaseAuthUser {
  uid: string;
  email: string | null;
  metadata: { creationTime?: string; lastSignInTime?: string };
}
const env = (import.meta.env || {}) as Record<string, string | undefined>;
const saved = config as Record<string, string>;
const url = env.VITE_SUPABASE_URL || saved.url || saved.supabaseUrl;
const key = env.VITE_SUPABASE_ANON_KEY || saved.anonKey || saved.supabaseAnonKey;
export const isSupabaseConfigured = (): boolean => Boolean(url && key);
export const supabase: SupabaseClient | null = isSupabaseConfigured()
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
// Password verification uses an isolated client so it cannot replace the active session.
export const secondarySupabase: SupabaseClient | null = isSupabaseConfigured()
  ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;

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
  currentUser = session?.user ? userShape(session.user) : null;
  const delivered = currentUser;
  // Never start an async Supabase call inside the auth lock.
  queueMicrotask(() => {
    if (currentUser !== delivered) return;
    for (const listener of authListeners) listener(delivered);
  });
};
supabase?.auth.onAuthStateChange((_event, session) => acceptSession(session));
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
  const redirectTo = typeof window === 'undefined' ? undefined : new URL(env.BASE_URL || './', window.location.href).href;
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
const decode = <T>(row: Row): T => ({ ...row.data, id: row.id }) as T;
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
    const { data, error } = await client().from(table).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? decode<T>(data) : null;
  },
  async getCollection<T = Record<string, unknown>>(table: SupabaseTableName): Promise<T[]> {
    assertTable(table);
    const rows: T[] = [];
    // Supabase caps each response: always fetch every page with a stable ordering.
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await client().from(table).select('*').order('id').range(offset, offset + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...(data || []).map(row => decode<T>(row)));
      if (!data || data.length < PAGE_SIZE) return rows;
    }
  },
  async upsertDoc(table: SupabaseTableName, id: string, payload: Record<string, unknown>): Promise<void> {
    await this.upsertDocs(table, [{ id, payload }]);
  },
  async upsertDocs(table: SupabaseTableName, entries: Array<{ id: string; payload: Record<string, unknown> }>): Promise<void> {
    assertTable(table);
    for (let offset = 0; offset < entries.length; offset += PAGE_SIZE) {
      const batch = entries.slice(offset, offset + PAGE_SIZE).map(entry => encode(table, entry.id, entry.payload));
      const { error } = await client().from(table).upsert(batch, { onConflict: 'id' });
      if (error) throw error;
    }
  },
  async deleteDocs(table: SupabaseTableName, ids: string[]): Promise<void> {
    assertTable(table);
    for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
      const { error } = await client().from(table).delete().in('id', ids.slice(offset, offset + PAGE_SIZE));
      if (error) throw error;
    }
  },
  subscribeTables(tables: SupabaseTableName[], onChange: (table: SupabaseTableName) => void | Promise<void>): () => void {
    let active = true;
    const sb = client();
    let channel = sb.channel(`inventory-${crypto.randomUUID()}`);
    for (const table of tables) {
      assertTable(table);
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        if (active) void Promise.resolve(onChange(table)).catch(error => console.error('Realtime reconciliation failed', error));
      });
    }
    channel.subscribe();
    return () => { active = false; void sb.removeChannel(channel); };
  },
};
