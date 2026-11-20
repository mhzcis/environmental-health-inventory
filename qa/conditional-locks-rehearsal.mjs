// Conditional category/warehouse locks — rehearses the PREPARED migration, rollback and one-time pre-launch cleanup
// in isolated PGlite only, on a synthetic copy shaped exactly like production (read-only observation 2026-11-20:
// one material mat-1793795662160 PES-1001, nine ledger rows, one registry row, five pinned policy rows). Never
// points at production.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createIsolatedDatabase,seedAccounts,asUser,ids} from './schema.mjs';
import {PINS} from './build-conditional-locks-migration.mjs';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const MAIN=read('./fixtures/inventory_atomic.main-81e3dab.sql');
const CANDIDATE=read('../database/inventory_atomic.sql');
const MIGRATION=read('../database/migrations/CONDITIONAL_LOCKS_MIGRATION.sql');
const ROLLBACK=read('../database/migrations/CONDITIONAL_LOCKS_ROLLBACK.sql');
const CLEANUP=read('../database/one_time_prelaunch_cleanup.sql');
const WA='wh-0ulyoh6',WB='wh-0ek8571',PES='mat-1793795662160';
const cats=[{name:'مبيدات حشرية',prefix:'PES',startRange:1001,endRange:1999},{name:'معقمات ومطهرات',prefix:'SAN',startRange:2001,endRange:2999},{name:'معدات رش ومكافحة',prefix:'EQP',startRange:3001,endRange:3999},{name:'طعوم قوارض',prefix:'ROD',startRange:4001,endRange:4999},{name:'كلور ومواد كيميائية',prefix:'CHM',startRange:5001,endRange:5999}];
const whs=[[WA,'المخزن الرئيسي'],['wh-0ebefdb','مستودع السموم والمبيدات'],['wh-0c5t1fd','مستودع الأجهزة والمعدات'],['wh-01z6f2r','مستودع طعوم القوارض'],['wh-08dc70y','مخزن أدوات السلامة'],[WB,'مخزن ب']].map(([id,name])=>({id,name,active:true}));
const cfg={id:'app_config',organizationName:'QA',departmentName:'QA',storehouseEntities:whs,storehouses:whs.map(w=>w.name),storehouseIds:whs.map(w=>w.id),warehouseSchemaVersion:2,units:['لتر'],categories:cats,partners:[],
 transactionCounters:{inbound:3,opening:1,consumed:3,outbound:2,transfer:1,adjustment:0}};
const mat={id:PES,code:'PES-1001',name:'QA_ACCEPTANCE_20261104',category:'مبيدات حشرية',unit:'لتر',minimumStock:2,initialStock:10,primaryStorehouseId:WA,storageLocation:'المخزن الرئيسي'};
const t=(id,n,q,type,wh,tt)=>({id,itemId:PES,itemCode:'PES-1001',date:'2026-11-04',transactionNumber:n,transactionType:type,storehouseId:wh,quantity:q,...(tt?{transferType:tt}:{})});
const ledger=[t('tr-init-mat-1793795662160','OP-0001',10,'افتتاحي',WA,'in'),t('tr-1793795875190','W-0003',5,'وارد',WA,'in'),t('tr-1793796116084','O-0001',3,'صادر',WA,'out'),
 {...t('transfer-83c5ee06-2673-483d-8a1a-27f1a0a7327e-out','T-0001-OUT',2,'تحويل',WA,'out'),operationId:'transfer-83c5ee06',pairedTransactionId:'transfer-83c5ee06-2673-483d-8a1a-27f1a0a7327e-in'},
 {...t('transfer-83c5ee06-2673-483d-8a1a-27f1a0a7327e-in','T-0001-IN',2,'تحويل',WB,'in'),operationId:'transfer-83c5ee06',pairedTransactionId:'transfer-83c5ee06-2673-483d-8a1a-27f1a0a7327e-out'},
 t('tr-1793821614812','C-0001',1,'مستهلك',WA,'out'),t('tr-recon-1793822708552-mat-1793795662160-mh21','O-0002',1,'صادر',WB),
 t('tr-zero-PES1001-20261112-wh-0ulyoh6','C-0002',9,'مستهلك',WA,'out'),t('tr-zero-PES1001-20261112-wh-0ek8571','C-0003',1,'مستهلك',WB,'out')]
 .map((r,i)=>({...r,createdAt:`2026-11-04T09:${String(10+i).padStart(2,'0')}:00Z`}));
let db;const q=async(s,p=[])=>(await db.query(s,p)).rows;
const FN="select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' f, md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('inventory_private','public') order by 1";
const fnMap=async()=>Object.fromEntries((await q(FN)).map(r=>[r.f,r.m]));
const md5=async n=>(await q("select md5(p.prosrc) m from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='inventory_private' and p.proname=$1",[n]))[0]?.m;
const dataHash=async()=>(await q("select md5(coalesce(jsonb_agg(jsonb_build_array(t,id,data) order by t,id)::text,'')) h from (select 'm' t,id,data from materials union all select 't',id,data from transactions union all select 's',id,data from settings union all select 'u',id,data from users union all select 'a',id,data from audit_logs union all select 'g',id,data from generator_logs) x"))[0].h;
const privHash=async()=>(await q("select md5(coalesce((select jsonb_agg(jsonb_build_array(code_key,material_id,deleted_at is null) order by code_key) from inventory_private.material_code_registry)::text,'')||coalesce((select jsonb_agg(prefix order by prefix) from inventory_private.category_policy)::text,'')||coalesce((select case when to_regclass('inventory_private.warehouse_usage') is null then null else 'wu' end),'')) h"))[0].h;
const n=async t=>Number((await q(`select count(*) n from ${t}`))[0].n);
const commit=async(p,id)=>(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_commit($1,$2) a',[id,JSON.stringify(p)]))).rows[0].a;
const nextCode=async cat=>(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_next_material_code($1) c',[cat]))).rows[0].c.code;
const set=(collection,docId,value,old=null)=>({collection,docId,kind:'set',value:{...value,id:docId},expected:old?{kind:'present',data:old}:{kind:'missing'}});
const del=(collection,docId,old)=>({collection,docId,kind:'delete',expected:{kind:'present',data:old}});
const row=async(tb,id)=>(await q(`select data from ${tb} where id=$1`,[id]))[0]?.data;
const execFails=async(sql,re)=>{let e;try{await db.exec(sql);}catch(x){e=x;}try{await db.exec('ROLLBACK');}catch{}assert.ok(e,'expected failure');assert.match(e.message,re);};
const rejects=async(fn,re)=>{let e;try{await fn();}catch(x){e=x;}assert.ok(e,'expected rejection');assert.match(e.message,re);};
const saveCfg=async(mutate,id)=>{const c=await row('settings','app_config');const next=mutate(structuredClone(c));return commit({mode:'mutation',label:'QA',operations:[set('settings','app_config',next,c)]},id);};
const pmat=(id,code,more={})=>({id,code,name:'QA '+code,category:'مبيدات حشرية',unit:'لتر',minimumStock:0,initialStock:0,primaryStorehouseId:WA,storageLocation:'المخزن الرئيسي',...more});
// Production-shaped database at main 81e3dab (the live server functions), with the historical rows and registry backfill.
const boot=async()=>{if(db)await db.close();db=await createIsolatedDatabase();await db.exec('CREATE TABLE auth.users(id uuid primary key,email text);');
 for(const[k,id]of Object.entries(ids))await db.query('insert into auth.users values($1,$2)',[id,k+'@qa.invalid']);
 await db.exec(MAIN);await seedAccounts(db);
 await q('insert into settings(id,data) values($1,$2)',['app_config',JSON.stringify(cfg)]);
 await q('insert into materials(id,data) values($1,$2)',[PES,JSON.stringify(mat)]);
 for(const r of ledger)await q('insert into transactions(id,data) values($1,$2)',[r.id,JSON.stringify(r)]);
 await q("update materials set data=(data-inventory_private.derived_material_keys())||inventory_private.material_projection(id)");
 await db.exec(MAIN); // idempotent re-run = the R8 backfill as applied in production (registry pes-1001, five pinned rows)
 for(let i=0;i<113;i++)await q('insert into audit_logs(id,data,updated_at) values($1,$2,now())',['qa-hist-'+i,JSON.stringify({id:'qa-hist-'+i,action:'سجل قديم يذكر PES-1001 و wh-0ebefdb',details:'نص حر'})]);};
const results=[];async function test(name,fn){try{await boot();await fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:String(e.message).slice(0,500)});}}
let candidateFns;
{db=await createIsolatedDatabase();await db.exec('CREATE TABLE auth.users(id uuid primary key,email text);');await db.exec(CANDIDATE);candidateFns=await fnMap();await db.close();db=null;}

await test('CL-MIG-0 production-shaped main 81e3dab baseline: every pinned md5(prosrc) equals the PGlite 81e3dab body; registry/policy as observed',async()=>{
 for(const[name,m]of Object.entries(PINS))assert.equal(await md5(name),m,name);
 assert.equal(await n('materials'),1);assert.equal(await n('transactions'),9);
 assert.deepEqual((await q('select code_key,material_id,deleted_at from inventory_private.material_code_registry')).map(r=>[r.code_key,r.material_id,r.deleted_at]),[['pes-1001',PES,null]]);
 assert.deepEqual((await q('select prefix from inventory_private.category_policy order by prefix')).map(r=>r.prefix),['CHM','EQP','PES','ROD','SAN']);});
await test('CL-MIG-1 migration: functions become byte-identical to database/inventory_atomic.sql, public data untouched, unused policy rows unpinned, usage backfilled, grants closed',async()=>{
 const h=await dataHash();await db.exec(MIGRATION);
 assert.equal(await dataHash(),h,'public data changed');
 assert.deepEqual(await fnMap(),candidateFns);
 assert.deepEqual((await q('select prefix,start_range::int s,end_range::int e from inventory_private.category_policy')).map(r=>[r.prefix,r.s,r.e]),[['PES',1001,1999]]);
 assert.deepEqual((await q('select warehouse_id from inventory_private.warehouse_usage order by 1')).map(r=>r.warehouse_id),[WB,WA].sort());
 const g=(await q(`select has_table_privilege('authenticated','inventory_private.warehouse_usage','SELECT') a, has_table_privilege('anon','inventory_private.warehouse_usage','SELECT') b,
   has_function_privilege('anon','public.inventory_reference_usage()','EXECUTE') c, has_function_privilege('authenticated','public.inventory_reference_usage()','EXECUTE') d,
   has_function_privilege('authenticated','inventory_private.record_warehouse_usage(text)','EXECUTE') e`))[0];
 assert.deepEqual(g,{a:false,b:false,c:false,d:true,e:false});
 const u=(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_reference_usage() u'))).rows[0].u;
 assert.deepEqual(u.usedCategoryPrefixes,['PES']);assert.deepEqual(u.usedWarehouseIds,[WB,WA].sort());
 // audit_logs free text (mentions PES-1001 and wh-0ebefdb) is never usage: wh-0ebefdb is deletable.
 await saveCfg(c=>{c.storehouseEntities=c.storehouseEntities.filter(w=>w.id!=='wh-0ebefdb');c.storehouses=c.storehouseEntities.map(w=>w.name);c.storehouseIds=c.storehouseEntities.map(w=>w.id);return c;},'qa-cl-del-unused');
 await rejects(()=>saveCfg(c=>{c.storehouseEntities=c.storehouseEntities.filter(w=>w.id!==WB);c.storehouses=c.storehouseEntities.map(w=>w.name);c.storehouseIds=c.storehouseEntities.map(w=>w.id);return c;},'qa-cl-del-used'),/INVENTORY_WAREHOUSE_IN_USE/);
 await saveCfg(c=>{c.categories[1]={...c.categories[1],prefix:'SNT',endRange:2500};return c;},'qa-cl-unused-cat');
 await rejects(()=>saveCfg(c=>{c.categories[0]={...c.categories[0],endRange:1500};return c;},'qa-cl-used-cat'),/INVENTORY_CATEGORY_PREFIX_FROZEN/);});
await test('CL-MIG-2 baseline drift (second run, or an unreviewed body) stops the migration with nothing applied',async()=>{
 await db.exec(MIGRATION);const f=await fnMap(),h=await dataHash(),p=await privHash();
 await execFails(MIGRATION,/CONDITIONAL_LOCKS_BASELINE_DRIFT/);assert.deepEqual(await fnMap(),f);assert.equal(await dataHash(),h);assert.equal(await privHash(),p);
 await boot();const f0=await fnMap(),p0=await privHash();
 await db.exec("CREATE OR REPLACE FUNCTION inventory_private.reserve_material_code(p_id text, p_data jsonb, p_cfg jsonb, p_strict boolean, p_source text) RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN NULL; END $$;");
 const f1=await fnMap();await execFails(MIGRATION,/CONDITIONAL_LOCKS_BASELINE_DRIFT/);assert.deepEqual(await fnMap(),f1);assert.equal(await privHash(),p0);assert.notDeepEqual(f1,f0);
 assert.equal(await q("select to_regclass('inventory_private.warehouse_usage') r").then(r=>r[0].r),null);});
await test('CL-MIG-3 rollback restores every main 81e3dab function body exactly (all six pinned md5s), drops the new functions, keeps data; roll-forward is repeatable',async()=>{
 const base=await fnMap(),h=await dataHash();await db.exec(MIGRATION);
 await commit({mode:'audit',label:'QA',operations:[{collection:'audit_logs',docId:'x',kind:'set',value:{action:'تسجيل الدخول',details:'QA',itemType:'نظام'}}]},'qa-cl-audit-1').catch(()=>{});
 const h2=await dataHash();await db.exec(ROLLBACK);
 assert.deepEqual(await fnMap(),base);for(const[name,m]of Object.entries(PINS))assert.equal(await md5(name),m,name);
 assert.equal(await dataHash(),h2);
 assert.deepEqual((await q('select prefix from inventory_private.category_policy order by prefix')).map(r=>r.prefix),['CHM','EQP','PES','ROD','SAN']);
 await db.exec(MIGRATION);assert.deepEqual(await fnMap(),candidateFns);assert.deepEqual((await q('select prefix from inventory_private.category_policy')).map(r=>r.prefix),['PES']);
 void h;});
await test('CL-MIG-4 rollback refuses (nothing applied) once settings use the new freedom (a sixth category), because main 81e3dab requires the exact five-category pin',async()=>{
 await db.exec(MIGRATION);await saveCfg(c=>{c.categories.push({name:'أخرى',prefix:'OTH',startRange:6001,endRange:6999});return c;},'qa-cl-sixth');
 const f=await fnMap(),h=await dataHash();await execFails(ROLLBACK,/POLICY_PINNED/);assert.deepEqual(await fnMap(),f);assert.equal(await dataHash(),h);});
await test('CL-CLN-1 cleanup on the migrated production copy: removes PES-1001 + 9 rows + reservation, zeroes counters, empties lock tables, keeps all 113 audits and adds exactly one; next code is PES-1001',async()=>{
 await db.exec(MIGRATION);const auditsBefore=(await q('select id,md5(data::text) h from audit_logs order by id')).map(r=>r.id+r.h);
 const s0=await row('settings','app_config');
 await db.exec(CLEANUP);
 for(const tb of ['materials','transactions','inventory_private.material_code_registry','inventory_private.category_policy','inventory_private.warehouse_usage'])assert.equal(await n(tb),0,tb);
 const s1=await row('settings','app_config');assert.deepEqual(s1.transactionCounters,{inbound:0,outbound:0,consumed:0,transfer:0,adjustment:0,opening:0});
 assert.deepEqual({...s1,transactionCounters:null},{...s0,transactionCounters:null},'settings changed beyond counters');
 const after=(await q('select id,md5(data::text) h from audit_logs order by id')).map(r=>r.id+r.h);
 assert.equal(after.length,auditsBefore.length+1);assert.ok(auditsBefore.every(a=>after.includes(a)),'an existing audit row changed');
 assert.equal((await q("select count(*)::int c from audit_logs where data->>'action'='تنظيف بيانات الاختبار قبل الإطلاق'"))[0].c,1);
 assert.equal(await nextCode('مبيدات حشرية'),'PES-1001');
 const u=(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_reference_usage() u'))).rows[0].u;assert.deepEqual(u,{usedCategoryPrefixes:[],usedCategoryNames:[],usedWarehouseIds:[]});
 // The cleanup is one-time: a second run aborts with nothing changed.
 const h=await dataHash();await execFails(CLEANUP,/PRELAUNCH_CLEANUP_ABORTED_UNEXPECTED_MATERIALS/);assert.equal(await dataHash(),h);});
await test('CL-CLN-2 after cleanup every reservation rule is back: PES-1001 issued once, deleted, never re-issued; prefix and warehouse lock on first use; unused ones stay free',async()=>{
 await db.exec(MIGRATION);await db.exec(CLEANUP);
 await commit({mode:'mutation',label:'QA',operations:[set('materials','m-real-1',pmat('m-real-1','PES-1001'))]},'qa-cl-real-1');
 assert.deepEqual((await q('select prefix from inventory_private.category_policy')).map(r=>r.prefix),['PES']);
 assert.deepEqual((await q('select warehouse_id from inventory_private.warehouse_usage')).map(r=>r.warehouse_id),[WA]);
 await commit({mode:'mutation',label:'QA',operations:[del('materials','m-real-1',await row('materials','m-real-1'))]},'qa-cl-real-del');
 assert.equal(await nextCode('مبيدات حشرية'),'PES-1002');
 await rejects(()=>commit({mode:'mutation',label:'QA',operations:[set('materials','m-real-2',pmat('m-real-2','PES-1001'))]},'qa-cl-reuse'),/INVENTORY_CODE_RESERVED|INVENTORY_CODE_NOT_NEXT/);
 await rejects(()=>commit({mode:'mutation',label:'QA',operations:[set('materials','m-real-1',pmat('m-real-1','PES-1001'))]},'qa-cl-reuse-same-id'),/INVENTORY_CODE_RESERVED|INVENTORY_CODE_NOT_NEXT/);
 await rejects(()=>saveCfg(c=>{c.categories[0]={...c.categories[0],startRange:1101};return c;},'qa-cl-pes-frozen'),/INVENTORY_CATEGORY_PREFIX_FROZEN/);
 await rejects(()=>saveCfg(c=>{c.categories=c.categories.filter(x=>x.prefix!=='PES');return c;},'qa-cl-pes-remove'),/INVENTORY_CATEGORY_PREFIX_FROZEN|INVENTORY_CATEGORY_IN_USE/);
 await rejects(()=>saveCfg(c=>{c.storehouseEntities=c.storehouseEntities.filter(w=>w.id!==WA);c.storehouses=c.storehouseEntities.map(w=>w.name);c.storehouseIds=c.storehouseEntities.map(w=>w.id);return c;},'qa-cl-wa'),/INVENTORY_WAREHOUSE_IN_USE/);
 // WB was used only by the cleaned test rows: it is free again after the one-time cleanup.
 await saveCfg(c=>{c.storehouseEntities=c.storehouseEntities.filter(w=>w.id!==WB);c.storehouses=c.storehouseEntities.map(w=>w.name);c.storehouseIds=c.storehouseEntities.map(w=>w.id);return c;},'qa-cl-wb');
 await saveCfg(c=>{c.categories=c.categories.filter(x=>x.prefix!=='CHM');c.categories[1]={...c.categories[1],prefix:'SNT'};return c;},'qa-cl-unused-edit');
 await saveCfg(c=>{c.categories[0]={...c.categories[0],name:'مبيدات حشرية عامة'};return c;},'qa-cl-rename-used').catch(e=>{if(!/INVENTORY_CATEGORY_IN_USE/.test(e.message))throw e;});});
await test('CL-CLN-3 cleanup refuses with nothing changed: before the migration, with an unexpected material, or with an unexpected reservation',async()=>{
 let h=await dataHash(),p=await privHash();await execFails(CLEANUP,/PRELAUNCH_CLEANUP_ABORTED_MIGRATION_NOT_APPLIED/);assert.equal(await dataHash(),h);assert.equal(await privHash(),p);
 await db.exec(MIGRATION);
 await q('insert into materials(id,data) values($1,$2)',['m-extra',JSON.stringify(pmat('m-extra','PES-1002'))]);
 h=await dataHash();p=await privHash();await execFails(CLEANUP,/PRELAUNCH_CLEANUP_ABORTED_UNEXPECTED_MATERIALS/);assert.equal(await dataHash(),h);assert.equal(await privHash(),p);
 await q("delete from materials where id='m-extra'");
 await q("insert into inventory_private.material_code_registry(code_key,code,prefix,number,material_id,source,deleted_at) values('pes-1002','PES-1002','PES',1002,'gone','qa',now())");
 h=await dataHash();p=await privHash();await execFails(CLEANUP,/PRELAUNCH_CLEANUP_ABORTED_UNEXPECTED_REGISTRY/);assert.equal(await dataHash(),h);assert.equal(await privHash(),p);});
const passed=results.filter(r=>r.status==='PASS').length;
console.log(JSON.stringify({suite:'Conditional locks migration / rollback / pre-launch cleanup rehearsal (PGlite isolated)',total:results.length,passed,failed:results.length-passed,results},null,1));
if(passed!==results.length)process.exitCode=1;
