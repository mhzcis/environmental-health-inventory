// @vitest-environment jsdom
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
 return {auth:{onAuthStateChange:(f:any)=>{fake.authCallback=f;return {data:{subscription:{unsubscribe(){}}}};},signOut:async()=>({error:null})},from:builder,rpc:async(name:string,args:any)=>{
  const uid=fake.uid;fake.calls.push({name,args:structuredClone(args),uid});if(fake.offline)throw new Error('synthetic offline');
  try{let payload=structuredClone(args.p_payload);if(fake.invalid&&payload?.mode==='mutation'){const t=payload.operations.find((x:any)=>x.collection==='transactions'&&x.kind==='set');if(t)t.value.quantity=-3;}
   const sql=name==='inventory_commit'?'select public.inventory_commit($1,$2) result':'select public.inventory_restore_preview($1) result';
   const values=name==='inventory_commit'?[args.p_mutation_id,JSON.stringify(payload)]:[JSON.stringify(args.p_backup)];
   const rows=await asUser(fake.db,uid,tx=>tx.query(sql,values));if(fake.switchAfterCommit){fake.switchAfterCommit=false;login(ids.employee);}if(fake.loseAck){fake.loseAck=false;throw new Error('synthetic ack lost');}return {data:rows.rows[0].result,error:null};
  }catch(error){if((error as any).code)return {data:null,error};throw error;}
 },channel:()=>{const c:any={on:()=>c,subscribe:()=>c};return c;},removeChannel:async()=>{}};
}}));
import {dataService,stopCloudSync,__p10EnqueueFenceTestApi} from '../src/services/dataService';
import {supabaseDb} from '../src/services/supabase';
import {canonicalizeWarehouseSettings} from '../src/utils/warehouseSettings';
import {IndexedDbSyncQueueStore} from '../src/services/syncQueueStore';
import {createBackup} from '../src/services/backupService';
import {updateManagedFirebaseUserProfile} from '../src/services/managedUserService';
let cfg:any,user:any;
const k={m:'remix_materials_v1',t:'remix_transactions_v1',s:'remix_settings_v1'};
const material=(id='qa-m1',code='QA-1001')=>({id,code,name:'QA مادة',category:'QA',unit:'قطعة',minimumStock:0,initialStock:0,primaryStorehouseId:'qa-a',storageLocation:'QA-A'});
const tx=(id='qa-t1',quantity=5)=>({id,date:'2026-11-04',itemId:'qa-m1',itemCode:'QA-1001',itemName:'QA مادة',itemCategory:'QA',itemType:'مادة',transactionType:'وارد',quantity,unit:'قطعة',storehouseId:'qa-a',storehouse:'QA-A',stockBefore:0,stockAfter:0,executedBy:'QA',supplierOrReceiver:'QA',createdAt:'2026-11-04T07:00:00Z'} as any);
const login=(uid:string)=>{fake.uid=uid;fake.authCallback('SIGNED_IN',{access_token:'synthetic-'+uid,user:{id:uid,email:'qa@invalid',created_at:'2026-11-01T00:00:00Z'}});};
const rows=async(table:string)=>(await fake.db.query(`select * from ${table} order by id`)).rows;
beforeAll(async()=>{vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('TextEncoder',TextEncoder);vi.stubGlobal('TextDecoder',TextDecoder);fake.db=await createIsolatedDatabase();await fake.db.exec('create table auth.users(id uuid primary key,email text);');for(const[name,id]of Object.entries(ids))await fake.db.query('insert into auth.users values($1,$2)',[id,name+'@qa.invalid']);await fake.db.exec(fs.readFileSync(process.cwd()+'/database/inventory_atomic.sql','utf8'));},60000);
beforeEach(async()=>{Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name:string,options:any,callback?:any)=>(callback||options)()}});stopCloudSync();__p10EnqueueFenceTestApi.clear();localStorage.clear();sessionStorage.clear();fake.offline=false;fake.loseAck=false;fake.invalid=false;fake.switchAfterCommit=false;fake.calls=[];const q=new IndexedDbSyncQueueStore();for(const id of Object.values(ids))await q.clearForUser(id as string);await fake.db.exec('delete from audit_logs;delete from transactions;delete from materials;delete from settings;delete from generator_logs;delete from users;');await seedAccounts(fake.db);
 cfg=canonicalizeWarehouseSettings({...JSON.parse(JSON.stringify(dataService.getSettings())),organizationName:'QA',departmentName:'QA',categories:[{name:'QA',prefix:'QA',startRange:1000,endRange:2000}],units:['قطعة'],storehouses:['QA-A','QA-B'],storehouseIds:['qa-a','qa-b'],storehouseEntities:[{id:'qa-a',name:'QA-A',active:true},{id:'qa-b',name:'QA-B',active:true}],warehouseSchemaVersion:2,transactionCounters:{inbound:0,outbound:0,consumed:0,opening:0,transfer:0,adjustment:0}});await fake.db.query("insert into settings(id,data)values('app_config',$1)",[JSON.stringify({...cfg,id:'app_config'})]);await fake.db.query("insert into materials(id,data)values('qa-m1',$1)",[JSON.stringify(material())]);login(ids.admin);user=(await fake.db.query('select data from users where id=$1',[ids.admin])).rows[0].data;expect((await dataService.bootstrapFreshDeviceData(user)).success).toBe(true);dataService.setCurrentUser(ids.admin);
});
afterAll(async()=>{stopCloudSync();await fake.db.close();vi.unstubAllGlobals();});
describe('actual service + adapter + durable IndexedDB queue + Postgres candidate',()=>{
 it('saves counter, transaction and canonical audit atomically',async()=>{const saved=await dataService.saveTransaction(tx());expect(saved.success,saved.message).toBe(true);expect(await rows('transactions')).toHaveLength(1);expect((await rows('settings'))[0].data.transactionCounters.inbound).toBe(1);expect((await rows('audit_logs')).every((r:any)=>r.data.actorUserId===ids.admin)).toBe(true);expect(await dataService.listPendingInventoryMutations()).toHaveLength(0);});
 it('offline work survives reload bootstrap and manually commits once',async()=>{fake.offline=true;const saved=await dataService.saveTransaction(tx());expect(saved.success).toBe(false);expect(dataService.getTransactions()).toHaveLength(1);expect(await rows('transactions')).toHaveLength(0);stopCloudSync();expect(await dataService.bootstrapFreshDeviceData(user)).toMatchObject({success:true,status:'pending-local'});expect(dataService.getTransactions()).toHaveLength(1);fake.offline=false;expect(await dataService.retryPendingInventoryMutations()).toBe(1);expect(await rows('transactions')).toHaveLength(1);expect(await dataService.listPendingInventoryMutations()).toHaveLength(0);});
 it('lost ACK safely replays the identical mutation ID',async()=>{fake.loseAck=true;expect((await dataService.saveTransaction(tx())).success).toBe(false);expect(await rows('transactions')).toHaveLength(1);const pending=await dataService.listPendingInventoryMutations();expect(pending).toHaveLength(1);await dataService.retryPendingInventoryMutations();const attempts=fake.calls.filter(x=>x.name==='inventory_commit');expect(attempts.map(x=>x.args.p_mutation_id)).toEqual([pending[0].id,pending[0].id]);expect(await rows('transactions')).toHaveLength(1);expect(await rows('audit_logs')).toHaveLength(1);});
 it('late server rejection leaves counter and audit unchanged; explicit cancellation rolls back local work',async()=>{fake.invalid=true;const result=await dataService.saveTransaction(tx());expect(result.success).toBe(false);expect(dataService.getTransactions()).toHaveLength(1);expect((await rows('settings'))[0].data.transactionCounters.inbound).toBe(0);expect(await rows('transactions')).toHaveLength(0);expect(await rows('audit_logs')).toHaveLength(0);expect((await dataService.listPendingInventoryMutations())[0].status).toBe('blocked');expect(await dataService.cancelRejectedInventoryMutations()).toBe(1);expect(dataService.getTransactions()).toHaveLength(0);fake.invalid=false;expect((await dataService.saveTransaction(tx('qa-t2'))).success).toBe(true);});
 it('multiple offline mutations retain order, counters and before-images',async()=>{fake.offline=true;await dataService.saveTransaction(tx('qa-t1',5));await dataService.saveTransaction(tx('qa-t2',3));expect(dataService.getTransactions()).toHaveLength(2);expect(await dataService.listPendingInventoryMutations()).toHaveLength(2);fake.offline=false;expect(await dataService.retryPendingInventoryMutations()).toBe(2);expect(await rows('transactions')).toHaveLength(2);expect((await rows('settings'))[0].data.transactionCounters.inbound).toBe(2);expect(dataService.getItemStock('qa-m1', undefined)).toBe(8);});
 it('uncertain timeout cannot be cancelled as a rejected transaction',async()=>{fake.offline=true;await dataService.saveTransaction(tx());await expect(dataService.cancelRejectedInventoryMutations()).rejects.toThrow('INVENTORY_UNCERTAIN_CANNOT_CANCEL');expect(await dataService.listPendingInventoryMutations()).toHaveLength(1);});
 it('both clear paths refuse existing durable work',async()=>{fake.offline=true;await dataService.saveTransaction(tx());await expect(dataService.resetToFactoryDefaults()).rejects.toThrow();await expect(dataService.clearLocalDeviceDataOnly()).rejects.toThrow();expect(dataService.getTransactions()).toHaveLength(1);});
 it('another account neither sends nor replaces the previous owner queue',async()=>{fake.offline=true;await dataService.saveTransaction(tx());const before=localStorage.getItem(k.t);login(ids.employee);const employee=(await fake.db.query('select data from users where id=$1',[ids.employee])).rows[0].data;expect(await dataService.listPendingInventoryMutations()).toHaveLength(0);expect((await dataService.bootstrapFreshDeviceData(employee)).success).toBe(false);expect(localStorage.getItem(k.t)).toBe(before);expect(await rows('transactions')).toHaveLength(0);});
 it('exact cloud restore removes surplus business rows and rehydrates an existing Auth profile',async()=>{await dataService.saveTransaction(tx());const b=await createBackup();await supabaseDb.upsertDoc('materials','qa-extra',material('qa-extra','QA-1999'));await fake.db.query('delete from users where id=$1',[ids.employee]);const pre=await dataService.previewBackupRestore(b);expect(pre.diffs.materials.removed).toBe(1);expect(pre.diffs.users.added).toBe(1);const r=await dataService.restoreBackupData(b,pre);expect(r.success,r.message).toBe(true);expect(await rows('materials')).toHaveLength(1);expect(await rows('users')).toHaveLength(5);expect(Number((await fake.db.query('select count(*) n from auth.users')).rows[0].n)).toBe(5);expect(await dataService.listPendingInventoryMutations()).toHaveLength(0);});
 it('stale restore preview is rejected without replacing local or remote records',async()=>{const b=await createBackup();const pre=await dataService.previewBackupRestore(b);await supabaseDb.upsertDoc('materials','qa-extra',material('qa-extra','QA-1999'));const before=localStorage.getItem(k.m);const r=await dataService.restoreBackupData(b,pre);expect(r.success).toBe(false);expect(localStorage.getItem(k.m)).toBe(before);expect(await rows('materials')).toHaveLength(2);expect((await dataService.listPendingInventoryMutations())[0].status).toBe('blocked');});
 it('session switch after server commit retains owner receipt and never acknowledges to the new account',async()=>{
   fake.switchAfterCommit=true;
   const result=await dataService.saveTransaction(tx()); expect(result.success).toBe(false);
   expect(await rows('transactions')).toHaveLength(1); expect(await dataService.listPendingInventoryMutations()).toHaveLength(0);
   login(ids.admin); const pending=await dataService.listPendingInventoryMutations(); expect(pending).toHaveLength(1);
   expect(await dataService.retryPendingInventoryMutations()).toBe(1); expect(await rows('transactions')).toHaveLength(1);
   expect(await rows('audit_logs')).toHaveLength(1);
 });
 it('IndexedDB failure happens before local projection or any cloud call',async()=>{
   const before=localStorage.getItem(k.t); const spy=vi.spyOn(IndexedDbSyncQueueStore.prototype,'insert').mockRejectedValueOnce(new DOMException('synthetic quota','QuotaExceededError'));
   const result=await dataService.saveTransaction(tx()); spy.mockRestore(); expect(result.success).toBe(false);
   expect(localStorage.getItem(k.t)).toBe(before); expect(fake.calls).toHaveLength(0); expect(await rows('transactions')).toHaveLength(0);
 });
 it('imports multiple materials and their opening balances in one acknowledged transaction',async()=>{
   const a={...material('qa-new-a','QA-1002'),type:'material',currentStock:0,createdAt:'2026-11-04T08:00:00Z'} as any;
   const b={...material('qa-new-b','QA-1003'),type:'material',currentStock:0,createdAt:'2026-11-04T08:00:00Z'} as any;
   const opening=(m:any,id:string)=>({...tx(id,4),itemId:m.id,transactionType:'افتتاحي',itemCode:m.code});
   await dataService.importMaterialsBatch([a,b],[opening(a,'qa-op-a'),opening(b,'qa-op-b')]);
   expect(await rows('materials')).toHaveLength(3); expect(await rows('transactions')).toHaveLength(2);
   expect(fake.calls.filter(c=>c.name==='inventory_commit')).toHaveLength(1);
   expect((await rows('settings'))[0].data.transactionCounters.opening).toBe(2);
 });
 it('invalid last import row leaves the whole file unchanged locally and remotely',async()=>{
   const a={...material('qa-new-a','QA-1002'),type:'material',currentStock:0} as any;
   const before=localStorage.getItem(k.m);
   await expect(dataService.importMaterialsBatch([a,{...a,id:'qa-bad',code:'QA-1003',unit:'undefined-unit'}],[])).rejects.toThrow();
   expect(localStorage.getItem(k.m)).toBe(before); expect(fake.calls).toHaveLength(0); expect(await rows('materials')).toHaveLength(1);
 });
 it('explicit cancellation reverses a rejected request and all dependent queued work',async()=>{
   fake.invalid=true; await dataService.saveTransaction(tx('qa-t1')); await dataService.saveTransaction(tx('qa-t2'));
   expect(await dataService.listPendingInventoryMutations()).toHaveLength(2);
   expect(await dataService.cancelRejectedInventoryMutations()).toBe(2);
   expect(dataService.getTransactions()).toHaveLength(0); expect(dataService.getSettings().transactionCounters?.inbound).toBe(0);
   expect(await rows('transactions')).toHaveLength(0);
 });

 it('profile updates retain a durable ID after lost ACK and never install unconfirmed local privileges',async()=>{
   const target=(await fake.db.query('select data from users where id=$1',[ids.employee])).rows[0].data;
   const before=dataService.getUsers().find(u=>u.id===ids.employee)!.fullName;
   fake.loseAck=true;
   const result=await updateManagedFirebaseUserProfile(target,{...target,fullName:'QA updated'});
   expect(result.success).toBe(false);expect(result.pendingConfirmation).toBe(true);
   expect(dataService.getUsers().find(u=>u.id===ids.employee)!.fullName).toBe(before);
   expect(await dataService.listPendingInventoryMutations()).toHaveLength(1);
   expect(await dataService.retryPendingInventoryMutations()).toBe(1);
   expect((await dataService.bootstrapFreshDeviceData(user)).success).toBe(true);
   expect(dataService.getUsers().find(u=>u.id===ids.employee)!.fullName).toBe('QA updated');
   expect(await rows('audit_logs')).toHaveLength(1);
 });

 it('reference rename updates settings, materials and ledger metadata atomically',async()=>{
   await dataService.saveTransaction(tx()); fake.calls=[];
   await dataService.updateReferenceValues('unit','قطعة','لتر');
   expect(fake.calls.filter(c=>c.name==='inventory_commit')).toHaveLength(1);
   expect((await rows('settings'))[0].data.units).toEqual(['لتر']);
   expect((await rows('materials'))[0].data.unit).toBe('لتر');
   expect((await rows('transactions'))[0].data.unit).toBe('لتر');
   expect(dataService.getItemStock('qa-m1', undefined)).toBe(5);
 });

 it('device clear requires a browser-wide exclusive lock and fails closed when unavailable',async()=>{
   Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});
   const before=localStorage.getItem(k.m);
   await expect(dataService.clearLocalDeviceDataOnly()).rejects.toThrow('المتصفح');
   expect(localStorage.getItem(k.m)).toBe(before);expect(fake.uid).toBe(ids.admin);
 });
 it('mixed-owner durable queues block projection replacement even when the current owner has work',async()=>{
   fake.offline=true;await dataService.saveTransaction(tx());const q=new IndexedDbSyncQueueStore();const now=Date.now();
   await q.insert({id:'qa-other-owner-pending',userId:ids.employee,operations:[],status:'pending',attempts:0,nextAttemptAt:now,createdAt:now,updatedAt:now} as any);
   const before=localStorage.getItem(k.t);expect((await dataService.bootstrapFreshDeviceData(user)).success).toBe(false);
   expect(localStorage.getItem(k.t)).toBe(before);
 });

});
