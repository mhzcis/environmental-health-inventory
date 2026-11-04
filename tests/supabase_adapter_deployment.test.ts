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
  for (const method of ['select', 'eq', 'order', 'delete', 'update']) fake.query[method] = vi.fn(() => fake.query);
  fake.query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  fake.query.range = vi.fn(async () => ({ data: [], error: null }));
  fake.query.upsert = vi.fn(async () => ({ error: null }));
  fake.query.insert = vi.fn(async () => ({ error: null }));
  fake.query.single = vi.fn(async () => ({ data: { id: 'app_config' }, error: null }));
  fake.query.in = vi.fn(async () => ({ error: null }));
  fake.channel = {
    on: vi.fn((_event, _filter, callback) => { fake.realtimeCallback = callback; return fake.channel; }),
    subscribe: vi.fn(),
  };
  fake.client = {
    from: vi.fn(() => fake.query),
    rpc: vi.fn(async (_name, args) => ({ data: { audit: { id: args.p_mutation_id, actorUserId: 'synthetic' }, replayed: false }, error: null })),
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
  it('appends authoritative audit through RPC without direct table writes', async () => {
    const { supabaseDb } = await import('../src/services/supabase');
    const receipts = await supabaseDb.appendAuditLogs([{ id: 'receipt-001', payload: { details: 'synthetic' } }]);
    expect(receipts[0].id).toBe('receipt-001');
    expect(fake.client.rpc).toHaveBeenCalledWith('inventory_commit', expect.objectContaining({ p_mutation_id: 'receipt-001', p_payload: expect.objectContaining({mode:'audit'}) }));
    expect(fake.client.from).not.toHaveBeenCalled();
    const denied = {code:'42501'}; fake.client.rpc.mockResolvedValueOnce({data:null,error:denied});
    await expect(supabaseDb.appendAuditLogs([{id:'receipt-denied',payload:{}}])).rejects.toBe(denied);
  });
  it('requires a settings baseline and a matching central acknowledgement', async () => {
    const { supabaseDb } = await import('../src/services/supabase');
    await expect(supabaseDb.updateExistingSettings({})).rejects.toThrow('INVENTORY_BASELINE_REQUIRED');
    const previous={id:'app_config',transactionCounters:{inbound:1}};
    fake.query.maybeSingle.mockResolvedValueOnce({data:{id:'app_config',data:previous},error:null});
    await supabaseDb.getDoc('settings','app_config');
    await supabaseDb.updateExistingSettings({...previous,transactionCounters:{inbound:2}});
    expect(fake.client.rpc.mock.calls[0][1].p_payload.operations[0]).toMatchObject({collection:'settings',expected:{kind:'present',data:previous}});
    fake.client.rpc.mockResolvedValueOnce({data:{audit:{id:'wrong-receipt'}},error:null});
    await expect(supabaseDb.updateExistingSettings(previous)).rejects.toThrow('INVENTORY_ACK_INVALID');
    expect(fake.query.upsert).not.toHaveBeenCalled(); expect(fake.query.update).not.toHaveBeenCalled();
  });
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
  it('sends canonical user data through the validated RPC, preserving disabled state', async () => {
    const {supabaseDb}=await import('../src/services/supabase');
    await supabaseDb.upsertDoc('users','employee-uid',{authUid:'employee-uid',username:'employee@example.com',fullName:'موظف',role:'موظف',permissions:['materials_view'],active:false});
    expect(fake.client.rpc.mock.calls[0][1].p_payload.operations[0]).toMatchObject({collection:'users',docId:'employee-uid',kind:'set',expected:{kind:'missing'},value:{id:'employee-uid',active:false}});
    expect(fake.query.upsert).not.toHaveBeenCalled();
  });
  it('uses the privileged server function for user creation without signing up on the current client', async () => {
    const { supabaseAdminCreateAuthUser } = await import('../src/services/supabase');
    const created = await supabaseAdminCreateAuthUser('employee@example.com', 'synthetic-test-password', 'موظف');
    expect(created.uid).toBe('created-uid');
    expect(fake.client.functions.invoke).toHaveBeenCalledWith('inventory-manage-users', {
      body: { email: 'employee@example.com', password: 'synthetic-test-password', fullName: 'موظف' },
    });
  });
  it('coalesces a row burst and drops queued realtime callbacks after unsubscribe', async () => {
    vi.useFakeTimers();
    try {
      const {supabaseDb}=await import('../src/services/supabase'); const listener=vi.fn();
      const stop=supabaseDb.subscribeTables(['materials'],listener);
      for(let i=0;i<100;i++) fake.realtimeCallback!();
      expect(listener).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(250); expect(listener).toHaveBeenCalledOnce();
      fake.realtimeCallback!(); stop(); await vi.advanceTimersByTimeAsync(500); expect(listener).toHaveBeenCalledOnce();
      expect(fake.client.removeChannel).toHaveBeenCalledWith(fake.channel);
    } finally {vi.useRealTimers();}
  });
  it('does not replace an optimistic baseline with a stale in-flight read',async()=>{
    const {supabaseDb}=await import('../src/services/supabase'); let release:any;
    fake.query.range.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const fetch=supabaseDb.getCollection('materials');
    supabaseDb.rememberOperations([{collection:'materials',docId:'m1',kind:'set',value:{id:'m1',name:'new'}}]);
    release({data:[{id:'m1',data:{id:'m1',name:'old'}}],error:null});
    await expect(fetch).rejects.toThrow('INVENTORY_SNAPSHOT_CHANGED');
    expect(supabaseDb.prepareOperations([{collection:'materials',docId:'m1',kind:'set',value:{name:'next'},expected:{kind:'missing'}}])[0].expected?.data?.name).toBe('new');
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

// A real app_config row carries transport identity and the historical composed-root marker.
// Neither belongs to the local settings schema validated during authenticated bootstrap.
describe('Supabase app_config projection', () => {
  it('loads a composed row without leaking cloud metadata and preserves warehouse identity', async () => {
    const { composeSupabaseAppSettings } = await import('../src/services/supabaseSettings');
    const defaults = {
      organizationName: 'Default', departmentName: 'Default department', expiryWarningThresholdDays: 30,
      categories: [{ name: 'General', prefix: 'GEN', startRange: 1, endRange: 99 }],
      units: ['pcs'], storehouses: ['Default warehouse'],
    };
    const remote = {
      ...defaults, id: 'app_config', settingsSchemaVersion: 3,
      organizationName: 'Cloud organization', storehouses: ['Remote warehouse'],
      storehouseEntities: [{ id: 'wh-remote', name: 'Remote warehouse', active: true }],
      storehouseIds: ['wh-remote'], warehouseSchemaVersion: 2,
      transactionCounters: { inbound: 4, outbound: 2, consumed: 1 },
      partners: [], openingStockAttachments: {}, openingStockAttachmentKeys: [],
    };
    const result = composeSupabaseAppSettings(remote, defaults);
    expect(result.organizationName).toBe('Cloud organization');
    expect(result.storehouseIds).toEqual(['wh-remote']);
    expect(result.transactionCounters).toEqual(remote.transactionCounters);
    expect(result.categories).toEqual(remote.categories);
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('settingsSchemaVersion');
    expect(result.cloudSyncEnabled).toBe(true);
    expect(remote).toHaveProperty('id', 'app_config');
  });
  it('still rejects unknown versions and unrelated unexpected fields', async () => {
    const { composeSupabaseAppSettings } = await import('../src/services/supabaseSettings');
    const defaults = {
      organizationName: 'Org', departmentName: 'Dept', expiryWarningThresholdDays: 30,
      categories: [{ name: 'General', prefix: 'GEN', startRange: 1, endRange: 99 }],
      units: ['pcs'], storehouses: ['Warehouse'],
    };
    expect(() => composeSupabaseAppSettings({ ...defaults, settingsSchemaVersion: 99 }, defaults)).toThrow();
    expect(() => composeSupabaseAppSettings({ ...defaults, injected: true }, defaults)).toThrow();
  });
});
