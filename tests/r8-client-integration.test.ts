// @vitest-environment jsdom
// R8 client integration: real dataService + adapter + IndexedDB outbox + the R8 Postgres candidate (PGlite).
import 'fake-indexeddb/auto';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {TextEncoder,TextDecoder} from 'node:util';
import {createRequire} from 'node:module';
const {createIsolatedDatabase,seedAccounts,asUser,ids}=createRequire(process.cwd()+'/package.json')('./qa/schema.mjs');
const fake=vi.hoisted(()=>({db:null as any,uid:'',authCallback:null as any,offline:false,loseAck:false,invalid:false,switchAfterCommit:false,calls:[] as any[]}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>{
 const builder=(table:string)=>{let id:string|undefined;const q:any={select:()=>q,eq:(_:string,v:string)=>{id=v;return q;},order:()=>q,maybeSingle:async()=>({data:(await asUser(fake.db,fake.uid,tx=>tx.query(`select * from public.${table} where id=$1`,[id]))).rows[0]||null,error:null}),range:async(start:number,end:number)=>({data:(await asUser(fake.db,fake.uid,tx=>tx.query(`select * from public.${table} order by id limit $1 offset $2`,[end-start+1,start]))).rows,error:null})};return q;};
 return {auth:{onAuthStateChange:(f:any)=>{fake.authCallback=f;return {data:{subscription:{unsubscribe(){}}}};},signOut:async()=>({error:null})},from:builder,rpc:async(name:string,args:any={})=>{
  const uid=fake.uid;fake.calls.push({name,args:structuredClone(args),uid});if(fake.offline)throw new Error('synthetic offline');
  try{let payload=structuredClone(args.p_payload);if(fake.invalid&&payload?.mode==='mutation'){const t=payload.operations.find((x:any)=>x.collection==='transactions'&&x.kind==='set');if(t)t.value.quantity=-3;}
   const sql=name==='inventory_commit'?'select public.inventory_commit($1,$2) result':name==='inventory_next_material_code'?'select public.inventory_next_material_code($1) result':name==='inventory_projection_drift'?'select public.inventory_projection_drift() result':name==='inventory_code_registry'?'select public.inventory_code_registry() result':'select public.inventory_restore_preview($1) result';
   const values=name==='inventory_commit'?[args.p_mutation_id,JSON.stringify(payload)]:name==='inventory_next_material_code'?[args.p_category]:name==='inventory_projection_drift'||name==='inventory_code_registry'?[]:[JSON.stringify(args.p_backup)];
   const rows=await asUser(fake.db,uid,tx=>tx.query(sql,values));if(fake.switchAfterCommit){fake.switchAfterCommit=false;login(ids.employee);}if(fake.loseAck){fake.loseAck=false;throw new Error('synthetic ack lost');}return {data:rows.rows[0].result,error:null};
  }catch(error){if((error as any).code)return {data:null,error};throw error;}
 },channel:()=>{const c:any={on:()=>c,subscribe:()=>c};return c;},removeChannel:async()=>{}};
}}));
import {dataService,stopCloudSync,__p10EnqueueFenceTestApi} from '../src/services/dataService';
import {supabaseDb} from '../src/services/supabase';
import {canonicalizeWarehouseSettings} from '../src/utils/warehouseSettings';
import {IndexedDbSyncQueueStore} from '../src/services/syncQueueStore';
import {setInventoryOutboxSendGate} from '../src/services/supabaseOutbox';
import {createBackup,validateBackup} from '../src/services/backupService';
let cfg:any,user:any;
const k={m:'remix_materials_v1',t:'remix_transactions_v1',s:'remix_settings_v1'};
const material=(id='qa-m1',code='QA-1001')=>({id,code,name:'QA مادة',category:'QA',unit:'قطعة',minimumStock:0,initialStock:0,primaryStorehouseId:'qa-a',storageLocation:'QA-A'});
const tx=(id='qa-t1',quantity=5)=>({id,date:'2026-11-04',itemId:'qa-m1',itemCode:'QA-1001',itemName:'QA مادة',itemCategory:'QA',itemType:'مادة',transactionType:'وارد',quantity,unit:'قطعة',storehouseId:'qa-a',storehouse:'QA-A',stockBefore:0,stockAfter:0,executedBy:'QA',supplierOrReceiver:'QA',createdAt:'2026-11-04T07:00:00Z'} as any);
const login=(uid:string)=>{fake.uid=uid;fake.authCallback('SIGNED_IN',{access_token:'synthetic-'+uid,user:{id:uid,email:'qa@invalid',created_at:'2026-11-01T00:00:00Z'}});};
const rows=async(table:string)=>(await fake.db.query(`select * from ${table} order by id`)).rows;
beforeAll(async()=>{vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('TextEncoder',TextEncoder);vi.stubGlobal('TextDecoder',TextDecoder);fake.db=await createIsolatedDatabase();await fake.db.exec('create table auth.users(id uuid primary key,email text);');for(const[name,id]of Object.entries(ids))await fake.db.query('insert into auth.users values($1,$2)',[id,name+'@qa.invalid']);await fake.db.exec(fs.readFileSync(process.cwd()+'/database/inventory_atomic.sql','utf8'));/* R8-R1: this isolated suite uses a synthetic 'QA' category; lift the production five-category pin here only (covered by qa/r8-readiness R1-R2-03). */await fake.db.exec('delete from inventory_private.category_policy');},60000);
beforeEach(async()=>{Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name:string,options:any,callback?:any)=>(callback||options)()}});stopCloudSync();__p10EnqueueFenceTestApi.clear();localStorage.clear();sessionStorage.clear();fake.offline=false;fake.loseAck=false;fake.invalid=false;fake.switchAfterCommit=false;fake.calls=[];const q=new IndexedDbSyncQueueStore();for(const id of Object.values(ids))await q.clearForUser(id as string);await fake.db.exec('delete from inventory_private.material_code_registry;delete from audit_logs;delete from transactions;delete from materials;delete from settings;delete from generator_logs;delete from users;');await seedAccounts(fake.db);
 cfg=canonicalizeWarehouseSettings({...JSON.parse(JSON.stringify(dataService.getSettings())),organizationName:'QA',departmentName:'QA',categories:[{name:'QA',prefix:'QA',startRange:1000,endRange:2000}],units:['قطعة'],storehouses:['QA-A','QA-B'],storehouseIds:['qa-a','qa-b'],storehouseEntities:[{id:'qa-a',name:'QA-A',active:true},{id:'qa-b',name:'QA-B',active:true}],warehouseSchemaVersion:2,transactionCounters:{inbound:0,outbound:0,consumed:0,opening:0,transfer:0,adjustment:0}});await fake.db.query("insert into settings(id,data)values('app_config',$1)",[JSON.stringify({...cfg,id:'app_config'})]);await fake.db.query("insert into materials(id,data)values('qa-m1',$1)",[JSON.stringify(material())]);/* R8-R1: migration backfill of the code registry */await fake.db.exec("insert into inventory_private.material_code_registry(code_key,code,prefix,number,material_id,source) select lower(btrim(m.data->>'code')),btrim(m.data->>'code'),p->>'prefix',(p->>'number')::numeric,m.id,'r8-backfill' from materials m cross join lateral inventory_private.code_parts(m.data->>'code') p where p->>'prefix' is not null on conflict do nothing");login(ids.admin);user=(await fake.db.query('select data from users where id=$1',[ids.admin])).rows[0].data;expect((await dataService.bootstrapFreshDeviceData(user)).success).toBe(true);dataService.setCurrentUser(ids.admin);
});
afterAll(async()=>{stopCloudSync();await fake.db.close();vi.unstubAllGlobals();});

const pendingKey='remix_materials_pending_v1';
const stored=()=>JSON.parse(localStorage.getItem(k.m)||'[]') as any[];
const grantArchive=async()=>{await fake.db.query(`update users set permissions=permissions||'["materials_archive"]'::jsonb,data=jsonb_set(data,'{permissions}',(data->'permissions')||'["materials_archive"]'::jsonb) where id=$1`,[ids.admin]);};
const newMaterial=(id:string,code:string)=>({...material(id,code),type:'material',currentStock:0,createdAt:'2026-11-04T08:00:00Z'} as any);
const projectionConsistent=(row:any)=>{const byId=row.warehouseStocksById||{};const names=row.warehouseStocks||{};const sum=(o:any)=>Object.values(o).reduce((a:number,b:any)=>a+Number(b),0);
 expect(sum(names)).toBe(row.currentStock);expect(byId['qa-a']??0).toBe(names['QA-A']??0);expect(byId['qa-b']??0).toBe(names['QA-B']??0);};
describe('R8 owner requirement 3: unconfirmed material changes never enter STORAGE_KEYS.MATERIALS',()=>{
 it('R8-REQ3-01 offline create stays out of MATERIALS, is visible as pending, and lands from the server ACK',async()=>{
  fake.offline=true;
  await expect(dataService.saveMaterial(newMaterial('qa-new-a','QA-1002'))).rejects.toThrow();
  expect(stored().map(m=>m.id)).toEqual(['qa-m1']);
  // R8-R1 (RT-R8-01): the confirmed view never contains it; it is listed separately as pending
  expect(dataService.getMaterials().some(m=>m.id==='qa-new-a')).toBe(false);
  expect(dataService.getPendingMaterialChanges().map(p=>[p.docId,p.code,p.kind])).toEqual([['qa-new-a','QA-1002','set']]);
  expect(dataService.getWorkingMaterials().find(m=>m.id==='qa-new-a')?.syncPending).toBe(true);
  expect(await dataService.listPendingInventoryMutations()).toHaveLength(1);
  fake.offline=false;
  expect(await dataService.retryPendingInventoryMutations()).toBe(1);
  const confirmed=stored().find(m=>m.id==='qa-new-a');
  expect(confirmed).toBeTruthy(); expect(confirmed.syncPending).toBeUndefined();
  expect(localStorage.getItem(pendingKey)).toBeNull();
  expect((await rows('materials')).map((r:any)=>r.id)).toContain('qa-new-a');
 });
 it('R8-REQ3-02 a server-rejected material change is never written to MATERIALS; outbox keeps it visible until explicit cancel',async()=>{
  const bad={...newMaterial('qa-bad','ZZ-77')};
  await expect(dataService.saveMaterial(bad)).rejects.toThrow();
  expect(stored().some(m=>m.id==='qa-bad')).toBe(false);
  const [row]=await dataService.listPendingInventoryMutations();
  expect(row.status).toBe('blocked'); expect(row.lastErrorCode).toMatch(/INVENTORY_CODE_CATEGORY_MISMATCH|23514/);
  expect(dataService.getMaterials().some(m=>m.id==='qa-bad')).toBe(false);
  expect(dataService.getPendingMaterialChanges().map(p=>p.docId)).toEqual(['qa-bad']);
  expect(await rows('materials')).toHaveLength(1);
  expect(await dataService.cancelRejectedInventoryMutations()).toBe(1);
  expect(dataService.getMaterials().some(m=>m.id==='qa-bad')).toBe(false);
  expect(dataService.getPendingMaterialChanges()).toEqual([]);
  expect(localStorage.getItem(pendingKey)).toBeNull();
 });
 it('R8-REQ3-03 a pending edit of an existing material leaves the confirmed row untouched until ACK',async()=>{
  const before=JSON.stringify(stored().find(m=>m.id==='qa-m1'));
  fake.offline=true;
  const edited={...dataService.getMaterials().find(m=>m.id==='qa-m1')!,name:'QA renamed'};
  await expect(dataService.saveMaterial(edited)).rejects.toThrow();
  expect(JSON.stringify(stored().find(m=>m.id==='qa-m1'))).toBe(before);
  expect(dataService.getMaterials().find(m=>m.id==='qa-m1')?.name).toBe('QA مادة'); // confirmed value stays visible
  expect(dataService.getPendingMaterialChanges().find(p=>p.docId==='qa-m1')?.name).toBe('QA renamed');
  fake.offline=false; await dataService.retryPendingInventoryMutations();
  expect(stored().find(m=>m.id==='qa-m1').name).toBe('QA renamed');
  expect((await rows('materials')).find((r:any)=>r.id==='qa-m1').data.syncPending).toBeUndefined();
 });
});
describe('R8 owner requirement 2 / DATA-01: projection consistent after every inventory_commit',()=>{
 it('R8-REQ2-01 inbound, transfer-like second warehouse and outbound keep currentStock/warehouseStocks/warehouseStocksById equal (server and ACK copy)',async()=>{
  expect((await dataService.saveTransaction(tx('qa-t1',5))).success).toBe(true);
  let local=stored().find(m=>m.id==='qa-m1'); projectionConsistent(local); expect(local.currentStock).toBe(5);
  expect((await dataService.saveTransaction({...tx('qa-t2',3),storehouseId:'qa-b',storehouse:'QA-B'})).success).toBe(true);
  local=stored().find(m=>m.id==='qa-m1'); projectionConsistent(local); expect(local.currentStock).toBe(8);
  const server=(await rows('materials')).find((r:any)=>r.id==='qa-m1').data; projectionConsistent(server);
  expect(server.warehouseStocksById).toEqual({'qa-a':5,'qa-b':3});
  expect(dataService.getItemStock('qa-m1',undefined)).toBe(8);
  const drift=await supabaseDb.projectionDrift(); expect(drift.drift).toBe(0);
 });
 it('R8-REQ1-01 a stale name-keyed cache (5 vs 8) on a ledger-backed material no longer blocks the device (root cause of MATERIAL_STOCK_CONFLICT:qa-m1:qa-a:5:8)',async()=>{
  expect((await dataService.saveTransaction(tx('qa-t1',5))).success).toBe(true);
  const rowsLocal=stored(); const m=rowsLocal.find(x=>x.id==='qa-m1'); m.warehouseStocks={'QA-A':8}; m.warehouseStocksById={'qa-a':5};
  localStorage.setItem(k.m,JSON.stringify(rowsLocal));
  const read=dataService.getMaterials().find(x=>x.id==='qa-m1')!;
  expect(read.currentStock).toBe(5);
  expect((await dataService.saveTransaction(tx('qa-t2',2))).success).toBe(true);
  const server=(await rows('materials')).find((r:any)=>r.id==='qa-m1').data; expect(server.warehouseStocks).toEqual({'QA-A':7}); expect(server.warehouseStocksById).toEqual({'qa-a':7});
 });
});
describe('R8-ARC-01 / CODE-01 client paths',()=>{
 it('R8-ARC-C1 archive needs materials_archive, is server-confirmed, hides the item from active lists and blocks new movements',async()=>{
  expect((await dataService.setMaterialLifecycle('qa-m1','archive','QA test row','qa_test_data')).success).toBe(false);
  await grantArchive(); const spy=vi.spyOn(dataService,'hasPermission').mockReturnValue(true);
  try{
   const r=await dataService.setMaterialLifecycle('qa-m1','archive','QA test row','qa_test_data'); expect(r.success,r.message).toBe(true);
   expect(stored().find(m=>m.id==='qa-m1').lifecycleStatus).toBe('archived');
   expect(dataService.getActiveMaterials().some(m=>m.id==='qa-m1')).toBe(false);
   expect(dataService.getArchivedMaterials().map(m=>m.id)).toEqual(['qa-m1']);
   const blocked=await dataService.saveTransaction(tx('qa-t9',1)); expect(blocked.success).toBe(false);
   expect(await rows('transactions')).toHaveLength(0);
   expect(await dataService.cancelRejectedInventoryMutations()).toBe(1);
   const back=await dataService.setMaterialLifecycle('qa-m1','reactivate','back in use'); expect(back.success,back.message).toBe(true);
   expect(dataService.getActiveMaterials().some(m=>m.id==='qa-m1')).toBe(true);
  }finally{spy.mockRestore();}
 });
 it('R8-ARC-C2 offline archive is queued durably (mode lifecycle), not applied locally, and commits once on retry',async()=>{
  await grantArchive(); const spy=vi.spyOn(dataService,'hasPermission').mockReturnValue(true);
  try{
   fake.offline=true;
   const r=await dataService.setMaterialLifecycle('qa-m1','archive','discontinued item','discontinued');
   expect(r.success).toBe(false); expect(r.pending).toBe(true);
   const [row]=await dataService.listPendingInventoryMutations(); expect((row as any).restorePayload.mode).toBe('lifecycle');
   expect(stored().find(m=>m.id==='qa-m1').lifecycleStatus).toBeUndefined();
   fake.offline=false; expect(await dataService.retryPendingInventoryMutations()).toBe(1);
   expect(stored().find(m=>m.id==='qa-m1').lifecycleStatus).toBe('archived');
   expect((await rows('audit_logs')).filter((a:any)=>a.data.lifecycle)).toHaveLength(1);
  }finally{spy.mockRestore();}
 });
 it('R8-ARC-C3 discontinued archive of a non-zero ledger balance is refused before sending',async()=>{
  await grantArchive(); const spy=vi.spyOn(dataService,'hasPermission').mockReturnValue(true);
  try{
   expect((await dataService.saveTransaction(tx('qa-t1',5))).success).toBe(true); const calls=fake.calls.length;
   const r=await dataService.setMaterialLifecycle('qa-m1','archive','x','discontinued'); expect(r.success).toBe(false);
   expect(fake.calls.length).toBe(calls);
  }finally{spy.mockRestore();}
 });
 it('R8-CODE-C1 suggestMaterialCode comes from the central registry; a code once used is never suggested again (even after its row is gone)',async()=>{
  // registry backfilled in beforeEach (QA-1001), as the production migration does
  expect(await dataService.suggestMaterialCode('QA')).toBe('QA-1002');
  await dataService.saveMaterial(newMaterial('qa-new-a','QA-1002'));
  expect(await dataService.suggestMaterialCode('QA')).toBe('QA-1003');
  await fake.db.query("delete from materials where id='qa-new-a'");
  expect(await dataService.suggestMaterialCode('QA')).toBe('QA-1003');
 });
});

// ---------------------------------------------------------------------------------------------------------------
// R8 FIX ROUND 1 regression tests (RT-R8-01, R2-R8-07, R2-R8-08, RT-R8-10, R2-R8-09/RT-R8-09, RT-R8-04, R2-R8-01)
// ---------------------------------------------------------------------------------------------------------------
const txKey='remix_transactions_pending_v1';
const commits=()=>fake.calls.filter(c=>c.name==='inventory_commit').length;
describe('R8-R1 confirmed-only views: the pending overlay never replaces confirmed values',()=>{
 it('R1-RT01-a a pending edit + pending outbound: Materials/Reports views keep the confirmed name and stock; the form balance is never raised by unconfirmed work; ACK applies both',async()=>{
  expect((await dataService.saveTransaction(tx('qa-t1',5))).success).toBe(true);
  fake.offline=true;
  const edited={...dataService.getMaterials().find(m=>m.id==='qa-m1')!,name:'QA renamed',currentStock:999,warehouseStocksById:{'qa-a':999}} as any;
  await expect(dataService.saveMaterial(edited)).rejects.toThrow();
  expect((await dataService.saveTransaction({...tx('qa-t2',2),transactionType:'صادر'})).success).toBe(false);
  const confirmed=dataService.getMaterials().find(m=>m.id==='qa-m1')!;
  expect(confirmed.name).toBe('QA مادة'); expect(confirmed.currentStock).toBe(5); expect(confirmed.warehouseStocksById).toEqual({'qa-a':5});
  expect(confirmed.syncPending).toBeUndefined();
  // write-path view: pending business fields, but server-owned keys never taken from the pending value
  const working=dataService.getWorkingMaterials().find(m=>m.id==='qa-m1')!;
  expect(working.name).toBe('QA renamed'); expect(working.currentStock).not.toBe(999);
  // reports/dashboard source excludes the queued outbound; the form balance is reduced by it (never raised)
  expect(dataService.getConfirmedTransactions().map(t=>t.id)).toEqual(['qa-t1']);
  expect([...dataService.getPendingTransactionIds()]).toEqual(['qa-t2']);
  expect(dataService.getItemStockByStorehouse('qa-m1','qa-a')).toBe(3);
  expect(dataService.getPendingMaterialChanges().map(p=>[p.docId,p.name])).toEqual([['qa-m1','QA renamed']]);
  fake.offline=false; expect(await dataService.retryPendingInventoryMutations()).toBe(2);
  const after=dataService.getMaterials().find(m=>m.id==='qa-m1')!;
  expect(after.name).toBe('QA renamed'); expect(after.currentStock).toBe(3);
  expect(localStorage.getItem(pendingKey)).toBeNull(); expect(localStorage.getItem(txKey)).toBeNull();
  expect(dataService.getPendingMaterialChanges()).toEqual([]);
 });
 it('R1-RT01-b a pending INBOUND never raises the form balance or the confirmed stock before the server confirms it',async()=>{
  expect((await dataService.saveTransaction(tx('qa-t1',5))).success).toBe(true);
  fake.offline=true;
  expect((await dataService.saveTransaction(tx('qa-t2',7))).success).toBe(false);
  expect(dataService.getMaterials().find(m=>m.id==='qa-m1')!.currentStock).toBe(5);
  expect(dataService.getItemStockByStorehouse('qa-m1','qa-a')).toBe(5);
  expect(dataService.getItemStock('qa-m1',undefined)).toBe(5);
  fake.offline=false; await dataService.retryPendingInventoryMutations();
  expect(dataService.getItemStockByStorehouse('qa-m1','qa-a')).toBe(12);
 });
 it('R1-R2-08 a server-REJECTED outbound changes neither the confirmed stock nor the report source; after cancel and after a later confirmed transaction the values are correct',async()=>{
  expect((await dataService.saveTransaction(tx('qa-t1',5))).success).toBe(true);
  fake.invalid=true;
  expect((await dataService.saveTransaction({...tx('qa-t2',2),transactionType:'صادر'})).success).toBe(false);
  fake.invalid=false;
  const [row]=await dataService.listPendingInventoryMutations(); expect(row.status).toBe('blocked');
  expect(dataService.getMaterials().find(m=>m.id==='qa-m1')!.currentStock).toBe(5);
  expect(dataService.getConfirmedTransactions().map(t=>t.id)).toEqual(['qa-t1']);
  expect(await dataService.cancelRejectedInventoryMutations()).toBe(1);
  expect(localStorage.getItem(txKey)).toBeNull();
  expect(dataService.getTransactions().map(t=>t.id)).toEqual(['qa-t1']);
  expect((await dataService.saveTransaction(tx('qa-t3',1))).success).toBe(true);
  expect(dataService.getMaterials().find(m=>m.id==='qa-m1')!.currentStock).toBe(6);
 });
 it('R1-R2-07 a stale overlay whose request is gone (ACK lost before publish / reload) is cleared on bootstrap; MATERIALS equals the server row',async()=>{
  localStorage.setItem(pendingKey,JSON.stringify([{mutationId:'gone-1',ownerUid:fake.uid,docId:'qa-m1',kind:'set',value:{...material(),name:'STALE'}}]));
  localStorage.setItem(txKey,JSON.stringify([{mutationId:'gone-1',docId:'qa-tx-x',previous:null}]));
  expect(dataService.getWorkingMaterials().find(m=>m.id==='qa-m1')!.name).toBe('STALE');
  expect((await dataService.bootstrapFreshDeviceData(user)).success).toBe(true);
  expect(localStorage.getItem(pendingKey)).toBeNull(); expect(localStorage.getItem(txKey)).toBeNull();
  const server=(await rows('materials')).find((r:any)=>r.id==='qa-m1').data;
  expect(dataService.getWorkingMaterials().find(m=>m.id==='qa-m1')!.name).toBe(server.name);
  expect(dataService.getPendingMaterialChanges()).toEqual([]);
 });
 it('R1-RT10 queue offline, log out, log in: the pending row is still listed (rebuilt from the outbox) and is sent once',async()=>{
  fake.offline=true;
  await expect(dataService.saveMaterial(newMaterial('qa-new-a','QA-1002'))).rejects.toThrow();
  await dataService.logout();
  expect(localStorage.getItem(pendingKey)).toBeNull();
  login(ids.admin); dataService.setCurrentUser(ids.admin);
  expect(await dataService.bootstrapFreshDeviceData(user)).toMatchObject({success:true,status:'pending-local'});
  expect(dataService.getPendingMaterialChanges().map(p=>p.docId)).toEqual(['qa-new-a']);
  fake.offline=false; expect(await dataService.retryPendingInventoryMutations()).toBe(1);
  expect((await rows('materials')).map((r:any)=>r.id)).toContain('qa-new-a');
 });
});
describe('R8-R1 outbox send gate (R2-R8-09 / RT-R8-09)',()=>{
 it('R1-GATE-1 the application default is CLOSED (fresh module without the test harness flag)',async()=>{
  const g=globalThis as any; const saved=g.__R8_OUTBOX_GATE_TEST_OPEN__; delete g.__R8_OUTBOX_GATE_TEST_OPEN__;
  try{vi.resetModules();const fresh=await import('../src/services/supabaseOutbox');expect(fresh.isInventoryOutboxSendGateOpen()).toBe(false);}
  finally{g.__R8_OUTBOX_GATE_TEST_OPEN__=saved;vi.resetModules();}
 });
 it('R1-GATE-2 with the gate closed a direct send makes zero RPCs (stays pending, not blocked); opening the gate drains it once',async()=>{
  setInventoryOutboxSendGate(false);
  try{
   const before=commits();
   const r=await dataService.saveTransaction(tx('qa-t1',5)); expect(r.success).toBe(false);
   expect(commits()).toBe(before);
   const [row]=await dataService.listPendingInventoryMutations(); expect(row.status).toBe('pending');
   await expect(dataService.retryPendingInventoryMutations()).rejects.toThrow(); expect(commits()).toBe(before);
   setInventoryOutboxSendGate(true);
   await vi.waitFor(async()=>expect(await rows('transactions')).toHaveLength(1),{timeout:5000,interval:50});
   expect(commits()).toBe(before+1);
   expect(await dataService.listPendingInventoryMutations()).toHaveLength(0);
  }finally{setInventoryOutboxSendGate(true);}
 });
});
describe('R8-R1 code registry in backup/restore (RT-R8-04)',()=>{
 it('R1-RT04 the backup carries the registry (deleted reservations included, checksummed); a fresh-environment restore keeps them and never re-issues the code',async()=>{
  await fake.db.query("insert into inventory_private.material_code_registry(code_key,code,prefix,number,material_id,source,deleted_at) values('qa-1002','QA-1002','QA',1002,'qa-gone','test',now())");
  const b=await createBackup({codeRegistry:await dataService.getCodeRegistryForBackup()});
  expect(b.codeRegistry!.find(r=>r.code==='QA-1002')).toMatchObject({materialId:'qa-gone',deleted:true});
  expect(b.manifest.counts.codeRegistry).toBe(b.codeRegistry!.length);
  expect((await validateBackup(JSON.parse(JSON.stringify(b)))).success).toBe(true);
  const tampered=JSON.parse(JSON.stringify(b)); tampered.codeRegistry=tampered.codeRegistry.filter((r:any)=>r.code!=='QA-1002');
  expect((await validateBackup(tampered)).success).toBe(false);
  await fake.db.exec('delete from inventory_private.material_code_registry'); // fresh environment: no registry at all
  const pre=await dataService.previewBackupRestore(b); const r=await dataService.restoreBackupData(b,pre); expect(r.success,r.message).toBe(true);
  const reg=(await fake.db.query("select code,deleted_at is not null d from inventory_private.material_code_registry order by code")).rows;
  expect(reg).toEqual([{code:'QA-1001',d:false},{code:'QA-1002',d:true}]);
  expect(await dataService.suggestMaterialCode('QA')).toBe('QA-1003');
  const sent=fake.calls.filter(c=>c.name==='inventory_commit'&&c.args.p_payload?.mode==='restore').at(-1);
  expect(sent.args.p_payload.backup.codeRegistry).toEqual(b.codeRegistry);
 });
});
describe('R8-R1 archive rule (R2-R8-01)',()=>{
 it('R1-R2-01-client nonzero stock is refused before sending for EVERY purpose, including qa_test_data',async()=>{
  await grantArchive(); const spy=vi.spyOn(dataService,'hasPermission').mockReturnValue(true);
  try{
   expect((await dataService.saveTransaction(tx('qa-t1',5))).success).toBe(true);
   const calls=commits();
   for(const purpose of ['qa_test_data','discontinued'] as const){
    const r=await dataService.setMaterialLifecycle('qa-m1','archive','x',purpose); expect(r.success).toBe(false); expect(r.message).toMatch(/لا يمكن أرشفة/);
   }
   expect(commits()).toBe(calls);
  }finally{spy.mockRestore();}
 });
});
