// R8-REC-01 / deliverables: rehearses the PREPARED production migration and rollback in isolated PGlite only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createIsolatedDatabase,seedAccounts,asUser,ids,allPermissions} from './schema.mjs';
import {buildMigration,buildRollback,MAIN_COMMIT_MD5,MAIN_VALIDATE_MD5} from './build-r8-migration.mjs';
const MIGRATION=fs.readFileSync(new URL('../database/migrations/R8_PRODUCTION_MIGRATION.sql',import.meta.url),'utf8');
const ROLLBACK=fs.readFileSync(new URL('../database/migrations/R8_ROLLBACK.sql',import.meta.url),'utf8');
const MAIN=fs.readFileSync(new URL('./fixtures/inventory_atomic.main-6933d16.sql',import.meta.url),'utf8');
const WA='wh-a',WB='wh-b',PES='mat-pes';
const cats=[{name:'مبيدات حشرية',prefix:'PES',startRange:1001,endRange:1999},{name:'معقمات ومطهرات',prefix:'SAN',startRange:2001,endRange:2999},{name:'معدات رش ومكافحة',prefix:'EQP',startRange:3001,endRange:3999},{name:'طعوم قوارض',prefix:'ROD',startRange:4001,endRange:4999},{name:'كلور ومواد كيميائية',prefix:'CHM',startRange:5001,endRange:5999}];
const cfg={id:'app_config',organizationName:'QA',storehouseEntities:[{id:WA,name:'A',active:true},{id:WB,name:'B',active:true}],storehouses:['A','B'],storehouseIds:[WA,WB],units:['لتر'],categories:cats,transactionCounters:{inbound:1,outbound:0,consumed:0,opening:1,transfer:0,adjustment:0}};
const mat={id:PES,code:'PES-1001',name:'QA',category:'مبيدات حشرية',unit:'لتر',minimumStock:0,initialStock:10,primaryStorehouseId:WA,storageLocation:'A',currentStock:14,warehouseStocks:{A:14}};
const tx=(id,n,q,type)=>({id,itemId:PES,itemCode:'PES-1001',date:'2026-11-04',transactionNumber:n,transactionType:type,storehouseId:WA,quantity:q});
let db;const q=async(s,p=[])=>(await db.query(s,p)).rows;
const md5=async n=>(await q("select md5(p.prosrc) m from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='inventory_private' and p.proname=$1",[n]))[0]?.m;
const fnExists=async n=>(await q("select count(*)::int n from pg_proc where proname=$1",[n]))[0].n>0;
const dataHash=async()=>(await q("select md5(coalesce(jsonb_agg(jsonb_build_array(t,id,data) order by t,id)::text,'')) h from (select 'm' t,id,data from materials union all select 't',id,data from transactions union all select 's',id,data from settings union all select 'u',id,data from users union all select 'a',id,data from audit_logs) x"))[0].h;
const audits=async()=>(await q('select id,md5(data::text) h from audit_logs order by id')).map(r=>r.id+':'+r.h);
const commit=async(p,id)=>(await asUser(db,ids.admin,t=>t.query('select public.inventory_commit($1,$2) a',[id,JSON.stringify(p)]))).rows[0].a;
const execFails=async(sql,re)=>{let e;try{await db.exec(sql);}catch(x){e=x;}try{await db.exec('ROLLBACK');}catch{}assert.ok(e,'expected failure');assert.match(e.message,re);};
const boot=async()=>{if(db)await db.close();db=await createIsolatedDatabase();await db.exec('CREATE TABLE auth.users(id uuid primary key,email text);');for(const[n,id]of Object.entries(ids))await db.query('insert into auth.users values($1,$2)',[id,n+'@qa.invalid']);
 await db.exec(MAIN);await seedAccounts(db);await q('update users set permissions=$1,data=jsonb_set(data,$2,$1) where id=$3',[JSON.stringify([...allPermissions,'materials_archive']),'{permissions}',ids.admin]);
 await q('insert into settings values($1,$2)',['app_config',JSON.stringify(cfg)]).catch(()=>q('insert into settings(id,data) values($1,$2)',['app_config',JSON.stringify(cfg)]));
 await q('insert into materials(id,data) values($1,$2)',[PES,JSON.stringify(mat)]);
 for(const t of [tx('tr-init-mat-pes','OP-0001',10,'افتتاحي'),tx('tr-in','W-0001',2,'وارد')])await q('insert into transactions(id,data) values($1,$2)',[t.id,JSON.stringify(t)]);
 await commit({mode:'audit',label:'QA',operations:[{collection:'audit_logs',docId:'x',kind:'set',value:{action:'prior',details:'prior'}}]},'qa-prior-receipt');};
const results=[];async function test(name,fn){try{await boot();await fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:String(e.message).slice(0,400)});}}
const archive=(v)=>({mode:'lifecycle',label:'QA',lifecycle:{action:'archive',materialId:PES,expectedLifecycleVersion:v,reason:'QA',purpose:'qa_test_data'}});
const reactivate=(v)=>({mode:'lifecycle',label:'QA',lifecycle:{action:'reactivate',materialId:PES,expectedLifecycleVersion:v,reason:'QA'}});

await test('MIG-0 committed migration/rollback files are generated from the reviewed sources',async()=>{assert.equal(MIGRATION,buildMigration());assert.equal(ROLLBACK,buildRollback());
 assert.equal(await md5('commit_inventory'),MAIN_COMMIT_MD5);assert.equal(await md5('validate_inventory'),MAIN_VALIDATE_MD5);});
await test('MIG-1 baseline drift stops the migration with nothing applied',async()=>{await db.exec(MAIN.replace("'INVENTORY_AUTH_REQUIRED'","'INVENTORY_AUTH_REQUIRED' /*drift*/"));const h=await dataHash();
 await execFails(MIGRATION,/R8_MIGRATION_BASELINE_DRIFT/);assert.equal(await fnExists('material_projection'),false);assert.equal(await dataHash(),h);
 assert.equal((await q("select to_regclass('inventory_private.material_code_registry') r"))[0].r,null);});
await test('MIG-2 category policy mismatch stops the migration with nothing applied',async()=>{await q("update settings set data=jsonb_set(data,'{categories,0,endRange}','1500')");
 await execFails(MIGRATION,/R8_MIGRATION_POLICY_MISMATCH/);assert.equal(await fnExists('material_projection'),false);});
await test('MIG-3 migration changes functions only (no data row), registers PES-1001, then drift check reports stale 14 vs ledger 12',async()=>{const h=await dataHash();await db.exec(MIGRATION);
 assert.equal(await dataHash(),h);assert.notEqual(await md5('commit_inventory'),MAIN_COMMIT_MD5);
 assert.deepEqual((await q('select code,material_id from inventory_private.material_code_registry')).map(r=>r.code+'@'+r.material_id),['PES-1001@'+PES]);
 const d=(await asUser(db,ids.admin,t=>t.query('select public.inventory_projection_drift() d'))).rows[0].d;assert.equal(d.drift,1);assert.equal(d.rows[0].stored.currentStock,14);assert.equal(d.rows[0].computed.currentStock,12);});
await test('MIG-4 rollback refuses while an item is archived; reactivate -> rollback restores main exactly and keeps all receipts/rows',async()=>{await db.exec(MIGRATION);
 await commit(archive(0),'qa-mig-archive-1');const before=await audits();const rows=await dataHash();
 await execFails(ROLLBACK,/R8_ROLLBACK_BLOCKED_ARCHIVED_MATERIALS/);assert.equal(await fnExists('material_projection'),true);assert.equal(await dataHash(),rows);
 await commit(reactivate(1),'qa-mig-react-1');const kept=await audits();const h=await dataHash();
 await db.exec(ROLLBACK);assert.equal(await md5('commit_inventory'),MAIN_COMMIT_MD5);assert.equal(await md5('validate_inventory'),MAIN_VALIDATE_MD5);
 assert.equal(await fnExists('material_projection'),false);assert.equal(await fnExists('inventory_projection_drift'),false);assert.equal(await dataHash(),h);
 for(const a of before)assert.ok(kept.includes(a));assert.deepEqual(await audits(),kept);
 assert.equal((await q('select count(*)::int n from inventory_private.material_code_registry'))[0].n,1);
 // main behaviour after rollback: ordinary mutation commits; lifecycle mode is rejected atomically.
 const c=(await q("select data from settings where id='app_config'"))[0].data;
 await commit({mode:'mutation',label:'QA',operations:[{collection:'transactions',docId:'tr-after',kind:'set',value:tx('tr-after','W-0002',1,'وارد'),expected:{kind:'missing'}},
  {collection:'settings',docId:'app_config',kind:'set',value:{...c,transactionCounters:{...c.transactionCounters,inbound:2}},expected:{kind:'present',data:c}}]},'qa-mig-main-tx');
 let e;try{await commit(archive(2),'qa-mig-after-rb');}catch(x){e=x;}assert.match(e?.message||'',/INVENTORY_OPERATIONS_INVALID/);});
await test('MIG-5 confirmed write hold allows rollback with an archived item; roll-forward again is idempotent and keeps reservations',async()=>{await db.exec(MIGRATION);await commit(archive(0),'qa-mig-archive-2');
 await db.exec(`SET r8.rollback_hold_writes='confirmed'; ${ROLLBACK}`);assert.equal(await md5('commit_inventory'),MAIN_COMMIT_MD5);await db.exec('RESET r8.rollback_hold_writes');
 await db.exec(MIGRATION);assert.equal((await q(`select data->>'lifecycleStatus' s from materials where id='${PES}'`))[0].s,'archived');
 let e;try{await commit({mode:'mutation',label:'QA',operations:[{collection:'materials',docId:'m2',kind:'set',value:{...mat,id:'m2',currentStock:0,warehouseStocks:{}},expected:{kind:'missing'}}]},'qa-mig-reuse');}catch(x){e=x;}
 assert.match(e?.message||'',/INVENTORY_CODE_RESERVED/);});
const report={suite:'R8 prepared migration + rollback rehearsal (PGlite isolated)',total:results.length,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,results};
fs.writeFileSync(process.env.QA_R8_MIGRATION_OUTPUT||'/tmp/inventory-r8-migration.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,1));await db.close();if(report.failed)process.exitCode=1;
