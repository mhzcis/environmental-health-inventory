// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemUser } from '../src/types';
import { canonicalizeWarehouseSettings } from '../src/utils/warehouseSettings';

const fake = vi.hoisted(() => ({
  getDoc: vi.fn(), getCollection: vi.fn(), upsertDoc: vi.fn(), upsertDocs: vi.fn(),
  appendAuditLogs: vi.fn(), updateExistingSettings: vi.fn(), deleteDocs: vi.fn(),
  subscribeTables: vi.fn(() => () => {}),
  prepareOperations: vi.fn((ops:any[])=>ops.map(op=>({...op,expected:op.expected.kind==='present'?{kind:'present',data:op.expected.exactLegacyPayload}:{kind:'missing'}}))),
  rememberOperations: vi.fn(), commitMutation: vi.fn(async(id:string,_payload?:unknown)=>({audit:{id,timestamp:new Date().toISOString(),user:'Synthetic employee',action:'اعتماد',details:'QA',itemType:'حركة'},replayed:false})),
}));
vi.mock('../src/services/supabase', () => ({
  supabase: null, secondarySupabase: null, subscribeAuthState: () => () => {},
  isSupabaseConfigured: () => true,
  getCurrentAuthUser: () => ({ uid: 'synthetic-employee', email: 'employee@example.invalid' }),
  supabaseDb: fake,
  supabaseAuthSignIn: vi.fn(), supabaseAuthSignOut: vi.fn(),
  supabaseAdminCreateAuthUser: vi.fn(), supabaseSendPasswordReset: vi.fn(),
}));
import { dataService, __p10EnqueueFenceTestApi } from '../src/services/dataService';

const employee: SystemUser = {
  id: 'synthetic-employee', authUid: 'synthetic-employee', username: 'employee@example.invalid',
  fullName: 'Synthetic employee', role: 'أمين مستودع', active: true, createdAt: '2026-11-01T00:00:00Z',
  permissions: ['materials_view', 'materials_create', 'materials_edit', 'transactions_view', 'transactions_create', 'reports_view'],
};
beforeEach(async () => {
  const {IndexedDbSyncQueueStore}=await import('../src/services/syncQueueStore'); await new IndexedDbSyncQueueStore().clearForUser(employee.id);
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  __p10EnqueueFenceTestApi.clear();
  fake.getCollection.mockResolvedValue([]);
  fake.upsertDoc.mockResolvedValue(undefined); fake.upsertDocs.mockResolvedValue(undefined);
  fake.appendAuditLogs.mockImplementation(async(entries:any[])=>entries.map(e=>({...e.payload,id:e.id}))); fake.updateExistingSettings.mockResolvedValue(undefined);
});

const cloudSettings = () => canonicalizeWarehouseSettings({
  ...JSON.parse(JSON.stringify(dataService.getSettings())),
  organizationName: 'Synthetic cloud organization', cloudSyncEnabled: true,
  storehouses: ['Synthetic cloud warehouse'], storehouseIds: ['wh-synthetic-cloud'],
  storehouseEntities: [{ id: 'wh-synthetic-cloud', name: 'Synthetic cloud warehouse', active: true }],
  warehouseSchemaVersion: 2, transactionCounters: { inbound: 17, outbound: 0, consumed: 0 },
});

describe('Employee operational cloud dependencies', () => {
  it('loads authoritative warehouses and counters without granting access to settings or audit pages', async () => {
    const remote = cloudSettings();
    fake.getDoc.mockResolvedValue(remote);
    expect((await dataService.bootstrapFreshDeviceData(employee)).success).toBe(true);
    dataService.setCurrentUser(employee.id);
    expect(dataService.getSettings().storehouseEntities?.[0].id).toBe('wh-synthetic-cloud');
    expect(dataService.getSettings().transactionCounters?.inbound).toBe(17);
    expect(dataService.hasPermission('settings_view')).toBe(false);
    expect(dataService.hasPermission('audit_view')).toBe(false);
    expect(fake.getCollection).not.toHaveBeenCalledWith('audit_logs');
    expect(fake.upsertDoc).not.toHaveBeenCalled();
  });
  it('refuses employee bootstrap when no operational settings exist instead of seeding local defaults', async () => {
    fake.getDoc.mockResolvedValue(null);
    expect(await dataService.bootstrapFreshDeviceData(employee)).toMatchObject({ success: false, status: 'missing-settings' });
    expect(fake.upsertDoc).not.toHaveBeenCalled();
  });
  it('routes an operational command through one acknowledged RPC and never direct DML', async () => {
    const remote=cloudSettings(); fake.getDoc.mockResolvedValue(remote);
    await dataService.bootstrapFreshDeviceData(employee); dataService.setCurrentUser(employee.id);
    const next={...remote,transactionCounters:{...remote.transactionCounters!,inbound:18}};
    await __p10EnqueueFenceTestApi.queueCloudMutation([{kind:'set',collection:'settings',docId:'app_config',value:next as unknown as Record<string,unknown>,expected:{kind:'present',fingerprint:'synthetic',exactLegacyPayload:remote as unknown as Record<string,unknown>}}],'synthetic-command');
    expect(fake.commitMutation).toHaveBeenCalledOnce();
    expect(fake.commitMutation.mock.calls[0][1]).toMatchObject({mode:'mutation',operations:[{collection:'settings',expected:{kind:'present',data:remote},value:expect.objectContaining({transactionCounters:expect.objectContaining({inbound:18})})}]});
    expect(fake.upsertDocs).not.toHaveBeenCalled(); expect(fake.updateExistingSettings).not.toHaveBeenCalled();
    await dataService.logAudit('Synthetic employee action','Synthetic receipt'); expect(fake.appendAuditLogs).toHaveBeenCalledOnce();
    expect(dataService.getLastCloudWriteError()).toBeNull();
  });
});
