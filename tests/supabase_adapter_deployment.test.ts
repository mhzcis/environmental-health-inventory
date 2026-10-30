import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  query: {} as Record<string, any>,
  client: {} as Record<string, any>,
  authCallback: null as null | ((event: string, session: any) => void),
  realtimeCallback: null as null | (() => void),
  channel: {} as Record<string, any>,
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => fake.client) }));

beforeEach(() => {
  vi.resetModules();
  fake.query = {};
  for (const method of ['select', 'eq', 'order', 'delete']) fake.query[method] = vi.fn(() => fake.query);
  fake.query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  fake.query.range = vi.fn(async () => ({ data: [], error: null }));
  fake.query.upsert = vi.fn(async () => ({ error: null }));
  fake.query.in = vi.fn(async () => ({ error: null }));
  fake.channel = {
    on: vi.fn((_event, _filter, callback) => { fake.realtimeCallback = callback; return fake.channel; }),
    subscribe: vi.fn(),
  };
  fake.client = {
    from: vi.fn(() => fake.query),
    channel: vi.fn(() => fake.channel),
    removeChannel: vi.fn(async () => undefined),
    functions: { invoke: vi.fn(async () => ({ data: { user: { id: 'created-uid', email: 'employee@example.com' } }, error: null })) },
    auth: {
      onAuthStateChange: vi.fn(callback => { fake.authCallback = callback; }),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(async () => ({ error: null })),
    },
  };
});

describe('Supabase deployment adapter', () => {
  it('loads every page, including more than the default server limit, in stable ID order', async () => {
    const first = Array.from({ length: 500 }, (_, i) => ({ id: `row-${i}`, data: { name: `${i}` } }));
    fake.query.range.mockResolvedValueOnce({ data: first, error: null })
      .mockResolvedValueOnce({ data: [{ id: 'last', data: { name: 'last item' } }], error: null });
    const { supabaseDb } = await import('../src/services/supabase');
    const rows = await supabaseDb.getCollection('materials');
    expect(rows).toHaveLength(501);
    expect(rows[500]).toEqual({ id: 'last', name: 'last item' });
    expect(fake.query.order).toHaveBeenCalledWith('id');
    expect(fake.query.range.mock.calls).toEqual([[0, 499], [500, 999]]);
  });
  it('does not turn permission/network errors into an empty collection', async () => {
    const error = { code: '42501' };
    fake.query.range.mockResolvedValue({ data: null, error });
    const { supabaseDb } = await import('../src/services/supabase');
    await expect(supabaseDb.getCollection('materials')).rejects.toBe(error);
  });
  it('serializes both user columns and canonical JSON, preserving disabled state', async () => {
    const { supabaseDb } = await import('../src/services/supabase');
    await supabaseDb.upsertDoc('users', 'employee-uid', {
      authUid: 'employee-uid', username: 'employee@example.com', fullName: 'موظف',
      role: 'موظف', permissions: ['materials_view'], active: false,
    });
    expect(fake.query.upsert).toHaveBeenCalledWith([expect.objectContaining({
      id: 'employee-uid', auth_uid: 'employee-uid', username: 'employee@example.com',
      full_name: 'موظف', active: false,
      data: expect.objectContaining({ id: 'employee-uid', active: false }),
    })], { onConflict: 'id' });
  });
  it('uses the privileged server function for user creation without signing up on the current client', async () => {
    const { supabaseAdminCreateAuthUser } = await import('../src/services/supabase');
    const created = await supabaseAdminCreateAuthUser('employee@example.com', 'synthetic-test-password', 'موظف');
    expect(created.uid).toBe('created-uid');
    expect(fake.client.functions.invoke).toHaveBeenCalledWith('inventory-manage-users', {
      body: { email: 'employee@example.com', password: 'synthetic-test-password', fullName: 'موظف' },
    });
  });
  it('drops queued realtime callbacks after unsubscribe', async () => {
    const { supabaseDb } = await import('../src/services/supabase');
    const listener = vi.fn();
    const stop = supabaseDb.subscribeTables(['materials'], listener);
    fake.realtimeCallback!();
    expect(listener).toHaveBeenCalledOnce();
    stop();
    fake.realtimeCallback!();
    expect(listener).toHaveBeenCalledOnce();
    expect(fake.client.removeChannel).toHaveBeenCalledWith(fake.channel);
  });
  it('publishes auth changes outside the auth callback and clears state on sign-out', async () => {
    const adapter = await import('../src/services/supabase');
    const listener = vi.fn();
    const stop = adapter.subscribeAuthState(listener);
    fake.authCallback!('SIGNED_IN', { access_token: 'synthetic-token', user: { id: 'uid-1', email: 'one@example.com' } });
    expect(adapter.getCurrentAuthUser()?.uid).toBe('uid-1');
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenLastCalledWith(adapter.getCurrentAuthUser());
    await adapter.supabaseAuthSignOut();
    expect(adapter.getCurrentAuthUser()).toBeNull();
    stop();
  });
});
