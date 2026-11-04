// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {TextEncoder,TextDecoder} from 'node:util';
const fake=vi.hoisted(()=>({uid:'11111111-1111-4111-8111-111111111111',failTable:'',offline:false,backend:{} as Record<string,Map<string,any>>,calls:[] as any[]}));
const clone=(v:any)=>JSON.parse(JSON.stringify(v));
const write=(table:string,entries:any[],append=false)=>{
 fake.calls.push({table,ids:entries.map(x=>x.id)});
 if(fake.offline||fake.failTable===table) throw new Error('QA_SIMULATED_TRANSPORT_FAILURE');
 for(const e of entries) if(!append||!fake.backend[table].has(e.id)) fake.backend[table].set(e.id,clone({...e.payload,id:e.id}));
};
vi.mock('../src/services/supabase',()=>({
 supabase:null,secondarySupabase:null,subscribeAuthState:()=>()=>{},isSupabaseConfigured:()=>true,
 getCurrentAuthUser:()=>fake.uid?({uid:fake.uid,email:fake.uid+'@qa.invalid'}):null,
 supabaseAuthSignIn:vi.fn(),supabaseAuthSignOut:vi.fn(async()=>{fake.uid='';}),
 supabaseAdminCreateAuthUser:vi.fn(),supabaseSendPasswordReset:vi.fn(),
 supabaseDb:{
  prepareOperations:vi.fn((ops:any[])=>ops.map(op=>({...op,expected:op.expected.kind==='present'?{kind:'present',data:op.expected.exactLegacyPayload}:{kind:'missing'}}))),
  rememberOperations:vi.fn(),
  commitMutation:vi.fn(async(id:string,p:any)=>{
    fake.calls.push({table:'rpc',id});
    if(fake.offline || p.operations.some((op:any)=>fake.failTable===op.collection)) throw new Error('QA_SIMULATED_TRANSPORT_FAILURE');
    if(fake.backend.audit_logs.has(id)) return {audit:fake.backend.audit_logs.get(id),replayed:true};
    for(const op of p.operations){if(op.kind==='delete')fake.backend[op.collection].delete(op.docId);else fake.backend[op.collection].set(op.docId,clone(op.value));}
    const receipt={id,timestamp:new Date().toISOString(),user:'QA admin',actorUserId:fake.uid,action:'اعتماد',details:'QA',itemType:'حركة'};
    fake.backend.audit_logs.set(id,receipt);return {audit:receipt,replayed:false};
  }),
  getDoc:vi.fn(async(t:string,id:string)=>{if(fake.offline)throw new Error('QA_OFFLINE');return clone(fake.backend[t]?.get(id)??null);}),
  getCollection:vi.fn(async(t:string)=>{if(fake.offline)throw new Error('QA_OFFLINE');return clone([...fake.backend[t].values()]);}),
  upsertDoc:vi.fn(async(t:string,id:string,payload:any)=>write(t,[{id,payload}])),
  upsertDocs:vi.fn(async(t:string,entries:any[])=>write(t,entries)),
  appendAuditLogs:vi.fn(async(entries:any[])=>{write('audit_logs',entries,true);return entries.map(e=>({...e.payload,id:e.id}));}),
  updateExistingSettings:vi.fn(async(payload:any)=>write('settings',[{id:'app_config',payload}])),
  deleteDocs:vi.fn(async(t:string,ids:string[])=>{if(fake.offline||fake.failTable===t)throw new Error('QA_DELETE_FAILURE');for(const id of ids)fake.backend[t].delete(id);}),
  subscribeTables:vi.fn(()=>()=>{}),
 }
}));
import {dataService,stopCloudSync,__p10EnqueueFenceTestApi} from '../src/services/dataService';
import {canonicalizeWarehouseSettings} from '../src/utils/warehouseSettings';
import {buildMaterialWarehouseView,buildTransactionLedger} from '../src/utils/inventoryLogic';
import {createBackup,validateBackup,applyBackupLocally,compareLocalAndCloudData} from '../src/services/backupService';
import {validateInventoryDataset} from '../src/utils/inventoryIntegrity';
const adminId='11111111-1111-4111-8111-111111111111';
const allPermissions=['dashboard_view','materials_view','materials_create','materials_edit','materials_delete','materials_stocktake','transactions_view','transactions_create','transactions_delete','reports_view','reports_export','reports_print','audit_view','generator_log','settings_view','settings_edit','users_manage','system_reset'];
let settings:any,user:any,counter=0;
const k={materials:'remix_materials_v1',transactions:'remix_transactions_v1',settings:'remix_settings_v1',users:'remix_users_v1',audit:'remix_audit_logs_v1',generator:'remix_generator_logs_v1'};
function setRole(permissions:string[]){user={...user,permissions};localStorage.setItem(k.users,JSON.stringify([user]));dataService.setCurrentUser(user.id);}
function material(overrides:any={}){return {id:'qa-m1',code:'QA-1001',name:'QA صنف مرجعي',category:'QA',type:'QA',unit:'قطعة',minimumStock:10,currentStock:0,initialStock:0,storageLocation:'QA-A',primaryStorehouseId:'qa-a',createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z',...overrides};}
function tx(type:string,quantity:number,warehouse='qa-a',overrides:any={}){counter++;return {id:'qa-t'+counter,transactionNumber:'',date:'2026-11-01',itemId:'qa-m1',itemCode:'QA-1001',itemName:'QA صنف مرجعي',itemCategory:'QA',itemType:'مادة',transactionType:type,quantity,unit:'قطعة',storehouseId:warehouse,storehouse:warehouse==='qa-a'?'QA-A':'QA-B',stockBefore:0,stockAfter:0,executedBy:'QA admin',supplierOrReceiver:'QA جهة مصطنعة',notes:'QA_FULL_ISOLATED',createdAt:`2026-11-01T00:00:${String(counter).padStart(2,'0')}Z`,updatedAt:'2026-11-01T00:00:00Z',...overrides} as any;}
async function save(t:any){const r=await dataService.saveTransaction(t);expect(r.success,r.message).toBe(true);return r;}
async function reference(){
 localStorage.setItem(k.materials,JSON.stringify([material()]));fake.backend.materials.set('qa-m1',material());
 await save(tx('افتتاحي',100,'qa-a'));
 await save(tx('افتتاحي',10,'qa-b'));
 await save(tx('وارد',40,'qa-a',{date:'2026-11-02'}));
 await save(tx('صادر',25,'qa-a',{date:'2026-11-03'}));
 await save(tx('مستهلك',5,'qa-a',{date:'2026-11-04'}));
 const r=await dataService.saveTransfer('qa-m1',20,'qa-a','qa-b','QA admin','QA_FULL_ISOLATED','2026-11-05');expect(r.success,r.message).toBe(true);
}
beforeEach(async()=>{Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name:string,options:any,callback?:any)=>(callback||options)()}});
 await new IndexedDbSyncQueueStore().clearForUser(adminId);
 vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('TextEncoder',TextEncoder);vi.stubGlobal('TextDecoder',TextDecoder);
 localStorage.clear();sessionStorage.clear();stopCloudSync();__p10EnqueueFenceTestApi.clear();counter=0;
 fake.uid=adminId;fake.offline=false;fake.failTable='';fake.calls=[];
 fake.backend=Object.fromEntries(['users','materials','transactions','settings','audit_logs','generator_logs'].map(t=>[t,new Map()]));
 const defaults=clone(dataService.getSettings());
 settings=canonicalizeWarehouseSettings({...defaults,organizationName:'QA معزول',departmentName:'QA اختبار',cloudSyncEnabled:true,
 categories:[{name:'QA',prefix:'QA',startRange:1000,endRange:2000}],units:['قطعة','لتر'],
 storehouses:['QA-A','QA-B'],storehouseIds:['qa-a','qa-b'],storehouseEntities:[{id:'qa-a',name:'QA-A',active:true},{id:'qa-b',name:'QA-B',active:true}],warehouseSchemaVersion:2,
 transactionCounters:{inbound:0,outbound:0,consumed:0,transfer:0,adjustment:0,opening:0},partners:[]});
 user={id:adminId,authUid:adminId,username:adminId+'@qa.invalid',fullName:'QA admin',role:'مدير نظام',permissions:allPermissions,active:true};
 for(const [key,val]of [[k.settings,settings],[k.users,[user]],[k.materials,[]],[k.transactions,[]],[k.audit,[]],[k.generator,[]]] as any)localStorage.setItem(key,JSON.stringify(val));
 fake.backend.settings.set('app_config',clone(settings));fake.backend.users.set(adminId,clone(user));dataService.setCurrentUser(adminId);
});
afterEach(()=>{stopCloudSync();vi.unstubAllGlobals();});


import {IndexedDbSyncQueueStore} from '../src/services/syncQueueStore';
import {__p9MonitoringTestApi} from '../src/services/dataService';
import {isValidInventoryDate} from '../src/utils/inventoryIntegrity';

describe('Remediation acceptance — candidate source only',()=>{
 it('live diagnostics derive warehouse totals from the ledger and detect changed content under the same IDs',async()=>{
  await reference();
  const matched=await compareLocalAndCloudData();
  expect(matched.status,JSON.stringify(matched)).toBe('matched');
  expect(matched.warehouseTotalsLocal).toEqual({'QA-A':90,'QA-B':30});
  expect(matched.warehouseTotalsCloud).toEqual(matched.warehouseTotalsLocal);
  const inbound=[...fake.backend.transactions.values()].find(t=>t.transactionType==='وارد');
  fake.backend.transactions.set(inbound.id,{...inbound,quantity:41});
  const changed=await compareLocalAndCloudData();
  expect(changed.status).toBe('differences-found');
  expect(changed.mismatchedRecords.transactions).toContain(inbound.id);
  expect(changed.warehouseTotalsCloud['QA-A']).toBe(91);
 });
 it('live diagnostics flag profile differences and orphan references instead of a false matched result',async()=>{
  await reference();
  fake.backend.users.set(adminId,{...user,permissions:['materials_view']});
  const first=[...fake.backend.transactions.values()][0];
  fake.backend.transactions.set(first.id,{...first,itemId:'qa-missing'});
  const report=await compareLocalAndCloudData();
  expect(report.status).toBe('differences-found');
  expect(report.mismatchedRecords.users).toContain(adminId);
  expect(report.orphanTransactionsCount).toBe(1);
 });
 it('F01 uncertain transport retains durable projection without a success audit',async()=>{localStorage.setItem(k.materials,JSON.stringify([material()]));fake.failTable='transactions';const before=localStorage.getItem(k.audit);const result=await dataService.saveTransaction(tx('وارد',5));expect(result.success).toBe(false);expect(dataService.getTransactions()).toHaveLength(1);expect(await dataService.listPendingInventoryMutations()).toHaveLength(1);expect(localStorage.getItem(k.audit)).toBe(before);expect(fake.backend.audit_logs.size).toBe(0);});
 it('F01 missing authenticated session cannot masquerade as central success',async()=>{localStorage.setItem(k.materials,JSON.stringify([material()]));fake.uid='';const result=await dataService.saveTransaction(tx('وارد',5));expect(result.success).toBe(false);expect(fake.calls).toHaveLength(0);expect(dataService.getTransactions()).toHaveLength(0);});
 it('F09 direction agrees across material, warehouse, ledger and calculator',async()=>{await reference();await save(tx('تسوية',2,'qa-a',{transferType:'out',date:'2026-11-06'}));expect(dataService.getItemStock('qa-m1')).toBe(118);expect(dataService.getItemStockByStorehouse('qa-m1','qa-a')).toBe(88);expect(dataService.calculateStock(dataService.getTransactions())).toBe(118);const rows=buildTransactionLedger(dataService.getTransactions(),'all',settings.storehouses,dataService.getMaterials());expect(rows[0]?.displayStockAfter).toBe(118);});
 it('F14 central audit rejection retains business rows',async()=>{await reference();const before=localStorage.getItem(k.transactions);fake.failTable='audit_logs';await expect(dataService.resetToFactoryDefaults()).rejects.toThrow();expect(localStorage.getItem(k.transactions)).toBe(before);});
 it('F02/F14 durable pending queue blocks bootstrap and both clear paths, even without an active coordinator',async()=>{await reference();const store=new IndexedDbSyncQueueStore();const now=Date.now();await store.put({id:'qa-existing-pending',userId:adminId,status:'blocked',operations:[],attempts:1,nextAttemptAt:now,createdAt:now,updatedAt:now});const before=localStorage.getItem(k.transactions);try{expect(await dataService.getOutstandingSyncWorkCount()).toBeGreaterThan(0);expect((await dataService.bootstrapFreshDeviceData(user)).success).toBe(false);await expect(dataService.resetToFactoryDefaults()).rejects.toThrow();await expect(dataService.clearLocalDeviceDataOnly()).rejects.toThrow();expect(localStorage.getItem(k.transactions)).toBe(before);expect((await store.listForUser(adminId))).toHaveLength(1);}finally{await store.clearForUser(adminId);}});
 it('F14 sticky diagnostic prevents destructive reset/clear but permits read-only canonical recovery',async()=>{await reference();__p9MonitoringTestApi.setLastCloudWriteError('synthetic unresolved');const before=localStorage.getItem(k.transactions);await expect(dataService.resetToFactoryDefaults()).rejects.toThrow();await expect(dataService.clearLocalDeviceDataOnly()).rejects.toThrow();expect((await dataService.bootstrapFreshDeviceData(user)).success).toBe(true);expect(dataService.getTransactions().map(t=>t.id).sort()).toEqual(JSON.parse(before!).map((t:any)=>t.id).sort());});
 it('F10 cloud recovery is contained before its first mutation, rather than a merge labelled full restore',async()=>{await reference();const backup=await createBackup();const before=[...Object.values(k)].map(key=>localStorage.getItem(key));fake.calls=[];const result=await dataService.restoreBackupData(backup);expect(result.success).toBe(false);expect([...Object.values(k)].map(key=>localStorage.getItem(key))).toEqual(before);expect(fake.calls).toHaveLength(0);});
 it('F16 missing permission rejects before local/remote deletion',async()=>{await reference();setRole(['materials_view','transactions_view','transactions_create']);const before=localStorage.getItem(k.transactions);fake.calls=[];const result=await dataService.deleteTransactions([dataService.getTransactions()[0].id]);expect(result.success).toBe(false);expect(localStorage.getItem(k.transactions)).toBe(before);expect(fake.calls).toHaveLength(0);});
 it.each(['2026-02-31','2026-02-29','1900-02-29','2026-04-31','2026-13-01','2026-00-01','0000-01-01','2026-1-01','2026-01-00'])('F17 invalid calendar date %s is rejected before writes',async(date)=>{localStorage.setItem(k.materials,JSON.stringify([material()]));expect(isValidInventoryDate(date)).toBe(false);const result=await dataService.saveTransaction(tx('وارد',1,'qa-a',{date}));expect(result.success).toBe(false);expect(fake.calls).toHaveLength(0);expect(dataService.getTransactions()).toHaveLength(0);});
 it.each(['2000-02-29','2024-02-29','2026-02-28','2026-04-30','2026-12-31'])('F17 real calendar day %s is accepted',async(date)=>{localStorage.setItem(k.materials,JSON.stringify([material()]));expect(isValidInventoryDate(date)).toBe(true);await save(tx('وارد',1,'qa-a',{date}));});
 it('TX05 authorized deletion recalculates balances and paired transfer deletion removes both legs',async()=>{await reference();const outbound=dataService.getTransactions().find(t=>t.transactionType==='صادر')!;expect((await dataService.deleteTransactions([outbound.id])).success).toBe(true);expect(dataService.getItemStock('qa-m1')).toBe(145);const transfer=dataService.getTransactions().find(t=>t.transactionType==='تحويل')!;const r=await dataService.deleteTransactions([transfer.id]);expect(r.success).toBe(true);expect(r.deletedIds).toHaveLength(2);expect(dataService.getItemStock('qa-m1')).toBe(145);});
 it('CON04 replay of an already committed transaction does not double its balance',async()=>{localStorage.setItem(k.materials,JSON.stringify([material()]));const t=tx('وارد',5);await save(t);const saved=dataService.getTransactions()[0];await save(saved);expect(dataService.getTransactions()).toHaveLength(1);expect(dataService.getItemStock('qa-m1')).toBe(5);});
 it('MAT rename preserves identity and historic balances',async()=>{await reference();const m=dataService.getMaterials()[0];await dataService.saveMaterial({...m,name:'QA اسم جديد'});expect(dataService.getItemStock('qa-m1')).toBe(120);expect(dataService.getTransactions()).toHaveLength(7);});
});

it('U01 direct write in flight is reflected by the existing monitoring counts',()=>{__p9MonitoringTestApi.setPendingCloudWritesCount(2);expect(dataService.getMonitoringOutboxCounts()).toMatchObject({pending:2,flushing:true});__p9MonitoringTestApi.setPendingCloudWritesCount(0);});
it('F14 signed-out work belonging to another owner blocks clearing the whole device',async()=>{const store=new IndexedDbSyncQueueStore();const now=Date.now();await store.put({id:'qa-other-owner',userId:'qa-previous-owner',status:'pending',operations:[],attempts:0,nextAttemptAt:now,createdAt:now,updatedAt:now});try{await expect(dataService.clearLocalDeviceDataOnly()).rejects.toThrow();expect(await store.countAll()).toBeGreaterThan(0);}finally{await store.clearForUser('qa-previous-owner');}});
