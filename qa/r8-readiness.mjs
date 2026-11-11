// R8 readiness (QA-20261109) — isolated PGlite only. Never points at production.
// Covers R8-DATA-01, R8-ARC-01, R8-REC-01, R8-CODE-01 (+POL-01/02 config), R8-RBAC-01.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createIsolatedDatabase,seedAccounts,asUser,ids,allPermissions} from './schema.mjs';
const CANDIDATE=fs.readFileSync(new URL('../database/inventory_atomic.sql',import.meta.url),'utf8');
const MAIN=fs.readFileSync(new URL('./fixtures/inventory_atomic.main-6933d16.sql',import.meta.url),'utf8');
// Production-shaped (synthetic) config: the five live categories and owner-approved prefixes/ranges.
const WA='wh-0ulyoh6',WB='wh-0ek8571';
export const liveCategories=[{name:'مبيدات حشرية',prefix:'PES',startRange:1001,endRange:1999},{name:'معقمات ومطهرات',prefix:'SAN',startRange:2001,endRange:2999},
 {name:'معدات رش ومكافحة',prefix:'EQP',startRange:3001,endRange:3999},{name:'طعوم قوارض',prefix:'ROD',startRange:4001,endRange:4999},{name:'كلور ومواد كيميائية',prefix:'CHM',startRange:5001,endRange:5999}];
const cfg={id:'app_config',organizationName:'QA',storehouseEntities:[{id:WA,name:'المخزن الرئيسي',active:true},{id:WB,name:'مخزن ب',active:true}],storehouses:['المخزن الرئيسي','مخزن ب'],storehouseIds:[WA,WB],
 units:['لتر','قطعة'],categories:liveCategories,transactionCounters:{inbound:0,outbound:0,consumed:0,opening:0,transfer:0,adjustment:0}};
const PES='mat-1793795662160';
const mat=(id,code,more={})=>({id,code,name:'QA '+code,category:'مبيدات حشرية',unit:'لتر',minimumStock:0,initialStock:0,primaryStorehouseId:WA,storageLocation:'المخزن الرئيسي',...more});
const tr=(id,n,q,type,wh,more={})=>({id,itemId:PES,itemCode:'PES-1001',date:'2026-11-04',transactionNumber:n,transactionType:type,storehouseId:wh,quantity:q,createdAt:'2026-11-04T10:00:00Z',...more});
// The seven PES-1001 ledger rows exactly as observed read-only (PRODUCTION_READONLY_R8.json), with synthetic dates/ordering.
const pesLedger=()=>[
 tr('tr-init-mat-1793795662160','OP-0001',10,'افتتاحي',WA,{createdAt:'2026-11-04T09:00:00Z'}),
 tr('tr-1793795875190','W-0003',5,'وارد',WA,{createdAt:'2026-11-04T09:10:00Z'}),
 tr('tr-1793796116084','O-0001',3,'صادر',WA,{createdAt:'2026-11-04T09:20:00Z'}),
 tr('transfer-83c5ee06-2673-483d-8a1a-27f1a0a7327e-out','T-0001-OUT',2,'تحويل',WA,{transferType:'out',operationId:'transfer-83c5ee06',pairedTransactionId:'transfer-83c5ee06-2673-483d-8a1a-27f1a0a7327e-in',createdAt:'2026-11-04T09:30:00Z'}),
 tr('transfer-83c5ee06-2673-483d-8a1a-27f1a0a7327e-in','T-0001-IN',2,'تحويل',WB,{transferType:'in',operationId:'transfer-83c5ee06',pairedTransactionId:'transfer-83c5ee06-2673-483d-8a1a-27f1a0a7327e-out',createdAt:'2026-11-04T09:30:00Z'}),
 tr('tr-1793821614812','C-0001',1,'مستهلك',WA,{createdAt:'2026-11-04T09:40:00Z'}),
 tr('tr-recon-1793822708552-mat-1793795662160-mh21','O-0002',1,'صادر',WB,{createdAt:'2026-11-04T09:50:00Z'}),
];
const stalePes=()=>({...mat(PES,'PES-1001',{initialStock:10,updatedAt:'2026-11-04T13:00:57.023Z'}),currentStock:12,warehouseStocks:{'المخزن الرئيسي':12}});
const set=(collection,docId,value,old=null)=>({collection,docId,kind:'set',value:{...value,id:docId},expected:old?{kind:'present',data:old}:{kind:'missing'}});
const del=(collection,docId,old)=>({collection,docId,kind:'delete',expected:{kind:'present',data:old}});
const payload=(operations,mode='mutation')=>({mode,label:'QA',operations});
let db,seq=0;
const q=async(sql,p=[])=>(await db.query(sql,p)).rows;
const row=async(t,id)=>(await q(`select data from ${t} where id=$1`,[id]))[0]?.data;
const count=async t=>Number((await q(`select count(*) n from ${t}`))[0].n);
const auditHashes=async()=>(await q("select id, md5(data::text) h from audit_logs order by id")).map(r=>r.id+':'+r.h);
const ledgerHash=async item=>(await q("select md5(coalesce(jsonb_agg(jsonb_build_array(id,data) order by id)::text,'')) h from transactions where data->>'itemId'=$1",[item]))[0].h;
const stateHash=async()=>(await q("select md5(coalesce(jsonb_agg(jsonb_build_array(id,data) order by id)::text,'')) h from (select id,data from materials union all select id,data from transactions union all select id,data from settings union all select id,data from audit_logs) s"))[0].h;
const raw=async(who,p,id)=>(id=id.length<8?'qa-r8-pad-'+id:id,await asUser(db,who,tx=>tx.query('select public.inventory_commit($1,$2) ack',[id,JSON.stringify(p)]))).rows[0].ack;
// Invariant after EVERY successful commit: each material the commit projected equals its ledger projection, and no
// previously consistent material became inconsistent (seeded stale fixtures stay visible to the drift check until reconciled).
const inconsistent=async()=>(await q("select id from materials m where inventory_private.stored_projection(m.data) is distinct from inventory_private.material_projection(m.id) order by id")).map(r=>r.id);
const assertProjectionInvariant=async()=>assert.deepEqual(await inconsistent(),[],'stored projection differs from the ledger');
const commit=async(who,p,id='qa-r8-commit-'+(++seq))=>{const before=new Set(await inconsistent());const a=await raw(who,p,id);
 const projected=new Set([...(a.audit.projectedMaterialIds||[]),...(a.materials||[]).map(m=>m.id)]);const after=await inconsistent();
 for(const id of after)assert.ok(before.has(id)&&!projected.has(id),'stored projection differs from the ledger: '+id);return a;};
const rejects=async(fn,codes,re)=>{let e;try{await fn();}catch(x){e=x;}assert.ok(e,'Expected rejection');if(codes)assert.ok(codes.includes(e.code),e.code+':'+e.message);if(re)assert.match(e.message,re);return e;};
const atomicReject=async(fn,codes,re)=>{const before=await stateHash();const regCount=async()=>(await q("select to_regclass('inventory_private.material_code_registry') r"))[0].r?count('inventory_private.material_code_registry'):-1;const reg=await regCount();const e=await rejects(fn,codes,re);assert.equal(await stateHash(),before,'rejected request changed state');assert.equal(await regCount(),reg);return e;};
const grant=async(id,perms)=>q('update users set permissions=$1, data=jsonb_set(data,$2,$1) where id=$3',[JSON.stringify(perms),'{permissions}',id]);
const boot=async(sql=CANDIDATE)=>{if(db)await db.close();db=await createIsolatedDatabase();await db.exec('CREATE TABLE auth.users(id uuid primary key,email text);');
 for(const [name,id] of Object.entries(ids))await db.query('insert into auth.users values($1,$2)',[id,name+'@qa.invalid']);
 await db.exec(sql);await seedAccounts(db);await db.query('insert into settings(id,data) values($1,$2)',['app_config',JSON.stringify(cfg)]);};
// Seed the PES fixture as stored in production: stale cache 12 and the seven ledger rows (direct superuser insert = historical data).
// Registers directly seeded (historical) codes exactly as the migration backfill does, when the registry exists.
const backfill=async()=>{if((await q("select to_regclass('inventory_private.material_code_registry') r"))[0].r)await q("insert into inventory_private.material_code_registry(code_key,code,prefix,number,material_id,source) select lower(btrim(m.data->>'code')),btrim(m.data->>'code'),p->>'prefix',(p->>'number')::numeric,m.id,'qa-seed' from materials m cross join lateral inventory_private.code_parts(m.data->>'code') p on conflict do nothing");};
// stale:true = production shape (stored 12, no id map: drift). stale:false = the same item after the approved reconcile (stored = ledger).
const seedPes=async({stale=true}={})=>{await q('insert into materials(id,data) values($1,$2)',[PES,JSON.stringify(stalePes())]);for(const t of pesLedger())await q('insert into transactions(id,data) values($1,$2)',[t.id,JSON.stringify(t)]);
 await q("update settings set data=jsonb_set(data,'{transactionCounters}',$1)",[JSON.stringify({inbound:3,outbound:2,consumed:1,opening:1,transfer:1,adjustment:0})]);
 if(!stale)await q("update materials set data=(data-inventory_private.derived_material_keys())||inventory_private.material_projection(id) where id=$1",[PES]);await backfill();};
const seedPesOk=()=>seedPes({stale:false});
// A zero-balance QA item with history (received 3, issued 3): the only kind of item that may be archived (R2-R8-01).
const Z='mat-qa-zero';const zMat=()=>mat(Z,'PES-1002',{name:'QA zero item'});
const zLedger=()=>[tr('z-in','ZW-0001',3,'وارد',WA,{itemId:Z,itemCode:'PES-1002',createdAt:'2026-11-04T08:00:00Z'}),tr('z-out','ZO-0001',3,'صادر',WA,{itemId:Z,itemCode:'PES-1002',createdAt:'2026-11-04T08:10:00Z'})];
const seedZero=async()=>{await q('insert into materials(id,data) values($1,$2)',[Z,JSON.stringify(zMat())]);for(const t of zLedger())await q('insert into transactions(id,data) values($1,$2)',[t.id,JSON.stringify(t)]);
 if((await q("select to_regproc('inventory_private.material_projection') r"))[0].r)await q("update materials set data=(data-inventory_private.derived_material_keys())||inventory_private.material_projection(id) where id=$1",[Z]);await backfill();};
const ztr=(id,n,q,type,wh,more={})=>tr(id,n,q,type,wh,{itemId:Z,itemCode:'PES-1002',...more});
const archiveP=(materialId,expectedLifecycleVersion,more={})=>({mode:'lifecycle',label:'QA archive',lifecycle:{action:'archive',materialId,expectedLifecycleVersion,reason:'QA test record — not real stock',purpose:'qa_test_data',...more}});
const reactivateP=(materialId,expectedLifecycleVersion)=>({mode:'lifecycle',label:'QA reactivate',lifecycle:{action:'reactivate',materialId,expectedLifecycleVersion,reason:'QA rehearsal'}});
const archiver=async()=>grant(ids.admin,[...allPermissions,'materials_archive']);
const cfgNow=async()=>row('settings','app_config');
const counters=async()=>(await cfgNow()).transactionCounters;
const results=[];
async function test(name,fn,sql){try{await boot(sql);await fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:String(e.message).slice(0,400)});}}

// ───────────────────────── R8-DATA-01 ─────────────────────────
await test('DATA-01 PES fixture: stale 12 is reported by the read-only drift check, nothing written',async()=>{await seedPes();const h=await stateHash();
 const d=(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_projection_drift() d'))).rows[0].d;assert.equal(d.drift,1);const r=d.rows.find(x=>x.id===PES);
 assert.equal(r.status,'drift');assert.equal(r.stored.currentStock,12);assert.equal(r.computed.currentStock,10);assert.equal(r.computed.ledgerTotalStock,10);
 assert.deepEqual(r.computed.warehouseStocksById,{[WA]:9,[WB]:1});assert.equal(r.ledgerRows,7);assert.equal(await stateHash(),h);});
await test('DATA-01 PES fixture: audited reconcile updates derived fields only 12 -> 10 (9/1); seven rows, counters and old audits unchanged',async()=>{await seedPes();
 await commit(ids.admin,{mode:'audit',label:'QA',operations:[{collection:'audit_logs',docId:'qa-prior',kind:'set',value:{action:'prior',details:'prior'}}]},'qa-prior-audit-1');
 const lh=await ledgerHash(PES);const ah=await auditHashes();const c=await counters();const before=await row('materials',PES);
 const drift=(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_projection_drift() d'))).rows[0].d.rows.find(x=>x.id===PES);
 await atomicReject(()=>raw(ids.admin,{mode:'reconcile',label:'QA',reconcile:{reason:'QA',materials:[{id:PES,expected:{...before,currentStock:11}}]}},'qa-recon-stale'),['40001'],/RECONCILE_STALE/);
 await atomicReject(()=>raw(ids.admin,{mode:'reconcile',label:'QA',reconcile:{reason:'QA',materials:[{id:PES,expected:before,expectedLedgerHash:'0'.repeat(64)}]}},'qa-recon-stale2'),['40001']);
 await atomicReject(()=>raw(ids.employee,{mode:'reconcile',label:'QA',reconcile:{reason:'QA',materials:[{id:PES,expected:before}]}},'qa-recon-denied'),['42501']);
 const a=await commit(ids.admin,{mode:'reconcile',label:'QA',reconcile:{reason:'R8 isolated rehearsal',materials:[{id:PES,expected:before,expectedLedgerHash:drift.ledgerHash}]}},'qa-recon-ok-1');
 const after=await row('materials',PES);assert.equal(after.currentStock,10);assert.deepEqual(after.warehouseStocksById,{[WA]:9,[WB]:1});assert.deepEqual(after.warehouseStocks,{'المخزن الرئيسي':9,'مخزن ب':1});
 assert.equal(after.initialStock,10);assert.deepEqual({...after,currentStock:0,warehouseStocks:0,warehouseStocksById:0,ledgerTotalStock:0},{...before,currentStock:0,warehouseStocks:0,warehouseStocksById:0,ledgerTotalStock:0});
 assert.equal(await ledgerHash(PES),lh);assert.equal(await count('transactions'),7);assert.deepEqual(await counters(),c);
 const ah2=await auditHashes();for(const x of ah)assert.ok(ah2.includes(x),'prior audit changed');assert.equal(ah2.length,ah.length+1);
 assert.equal(a.audit.reconciliations[0].before.currentStock,12);assert.equal(a.audit.reconciliations[0].after.currentStock,10);assert.equal(a.audit.reconciliations[0].ledgerRows,7);
 assert.equal((await asUser(db,ids.admin,tx=>tx.query('select public.inventory_projection_drift() d'))).rows[0].d.drift,0);});
await test('DATA-01 opening counts exactly once (opening row vs initialStock fallback)',async()=>{
 await commit(ids.admin,payload([set('materials','m-a',mat('m-a','PES-1001',{initialStock:10})),set('transactions','op-a',{...tr('op-a','OP-0001',10,'افتتاحي',WA),itemId:'m-a',itemCode:'PES-1001'}),set('settings','app_config',{...cfg,transactionCounters:{...cfg.transactionCounters,opening:1}},cfg)]));
 assert.equal((await row('materials','m-a')).currentStock,10);
 await q('insert into materials(id,data) values($1,$2)',['m-legacy',JSON.stringify(mat('m-legacy','PES-1003',{initialStock:4}))]);
 await commit(ids.admin,payload([set('materials','m-legacy',{...mat('m-legacy','PES-1003',{initialStock:4}),notes:'n'},mat('m-legacy','PES-1003',{initialStock:4}))]));
 const l=await row('materials','m-legacy');assert.equal(l.currentStock,4);assert.deepEqual(l.warehouseStocksById,{[WA]:4});});
await test('DATA-01 inbound/outbound/consumed/transfer legs keep currentStock, warehouseStocks and warehouseStocksById consistent',async()=>{await seedPesOk();let c=await cfgNow();
 const step=async(ops,inc)=>{const next={...c,transactionCounters:{...c.transactionCounters,...inc}};await commit(ids.employee,payload([...ops,set('settings','app_config',next,c)]));c=await cfgNow();};
 await step([set('transactions','t-in',tr('t-in','W-0004',4,'وارد',WA))],{inbound:4});
 await step([set('transactions','t-out',tr('t-out','O-0003',2,'صادر',WA))],{outbound:3});
 await step([set('transactions','t-con',tr('t-con','C-0002',1,'مستهلك',WB))],{consumed:2});
 await step([set('transactions','x-out',tr('x-out','T-0002-OUT',3,'تحويل',WA,{transferType:'out',operationId:'op2',pairedTransactionId:'x-in'})),set('transactions','x-in',tr('x-in','T-0002-IN',3,'تحويل',WB,{transferType:'in',operationId:'op2',pairedTransactionId:'x-out'}))],{transfer:2});
 const m=await row('materials',PES);assert.deepEqual(m.warehouseStocksById,{[WA]:8,[WB]:3});assert.equal(m.currentStock,11);assert.equal(m.ledgerTotalStock,11);assert.deepEqual(m.warehouseStocks,{'المخزن الرئيسي':8,'مخزن ب':3});});
await test('DATA-01 cancellation and correction recompute the projection; replay adds no effect',async()=>{await seedPesOk();const o=pesLedger()[1];
 const rep=tr('tr-repl','W-0009',4,'وارد',WA,{correctionOf:{id:o.id,transactionNumber:o.transactionNumber,quantity:5,reason:'QA'}});
 const p=payload([del('transactions',o.id,o),set('transactions','tr-repl',rep)],'correction');const a=await commit(ids.admin,p,'qa-corr-r8-01');
 assert.equal((await row('materials',PES)).currentStock,9);assert.ok(a.materials.some(x=>x.id===PES&&x.currentStock===9),'ack carries server projection');
 const again=await raw(ids.admin,p,'qa-corr-r8-01');assert.equal(again.replayed,true);assert.equal((await row('materials',PES)).currentStock,9);assert.equal(again.materials[0].currentStock,9);
 await commit(ids.admin,payload([del('transactions','tr-repl',rep)]));assert.equal((await row('materials',PES)).currentStock,5);});
await test('DATA-01 warehouse rename and deactivation: names follow ids; active total excludes, all-ledger total keeps stock',async()=>{await seedPesOk();let c=await cfgNow();
 const renamed={...c,storehouseEntities:[c.storehouseEntities[0],{...c.storehouseEntities[1],name:'مخزن ب الجديد'}],storehouses:['المخزن الرئيسي','مخزن ب الجديد']};
 await commit(ids.admin,payload([set('settings','app_config',renamed,c)]));let m=await row('materials',PES);assert.deepEqual(m.warehouseStocks,{'المخزن الرئيسي':9,'مخزن ب الجديد':1});c=await cfgNow();
 const off={...c,storehouseEntities:[c.storehouseEntities[0],{...c.storehouseEntities[1],active:false}],storehouses:['المخزن الرئيسي']};
 await commit(ids.admin,payload([set('settings','app_config',off,c)]));m=await row('materials',PES);
 assert.equal(m.currentStock,9);assert.equal(m.ledgerTotalStock,10);assert.deepEqual(m.warehouseStocksById,{[WA]:9,[WB]:1});assert.deepEqual(m.warehouseStocks,{'المخزن الرئيسي':9});});
await test('DATA-01 client-supplied derived values are never authoritative (create, edit, import, restore)',async()=>{
 await commit(ids.admin,payload([set('materials','m-x',{...mat('m-x','PES-1001'),currentStock:999,warehouseStocks:{'X':999},warehouseStocksById:{[WB]:999},ledgerTotalStock:999})]));
 let m=await row('materials','m-x');assert.equal(m.currentStock,0);assert.deepEqual(m.warehouseStocksById,{});
 await commit(ids.admin,payload([set('materials','m-x',{...m,name:'edited',currentStock:55},m)]));m=await row('materials','m-x');assert.equal(m.currentStock,0);assert.equal(m.name,'edited');
 const users=(await q('select data from users order by id')).map(r=>r.data);const b={settings:cfg,materials:[{...mat('m-x','PES-1001'),currentStock:777,warehouseStocksById:{[WA]:777}}],transactions:[],generatorLogs:[],users};
 const pre=(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_restore_preview($1) p',[JSON.stringify(b)]))).rows[0].p;
 await commit(ids.admin,{mode:'restore',label:'QA',backup:b,expectedState:pre.expectedState});m=await row('materials','m-x');assert.equal(m.currentStock,0);assert.deepEqual(m.warehouseStocksById,{});});
await test('DATA-01 expected-document check ignores ONLY server-owned fields; stale business fields still conflict',async()=>{await seedPesOk();const m=await row('materials',PES);
 await commit(ids.admin,payload([set('materials',PES,{...m,notes:'ok'},{...m,currentStock:3,warehouseStocks:{},ledgerTotalStock:1})]));assert.equal((await row('materials',PES)).notes,'ok');
 const m2=await row('materials',PES);await atomicReject(()=>raw(ids.admin,payload([set('materials',PES,{...m2,notes:'x'},{...m2,name:'stale-name'})]),'qa-stale-biz'),['40001'],/INVENTORY_CONFLICT/);});
await test('DATA-01 transaction-only writer never needs materials_edit; business edits still denied',async()=>{await seedPesOk();await grant(ids.employee,['materials_view','transactions_view','transactions_create']);
 const c=await cfgNow();await commit(ids.employee,payload([set('transactions','t-only',tr('t-only','W-0004',1,'وارد',WA)),set('settings','app_config',{...c,transactionCounters:{...c.transactionCounters,inbound:4}},c)]));
 assert.equal((await row('materials',PES)).currentStock,11);const m=await row('materials',PES);
 await commit(ids.employee,payload([set('materials',PES,{...m,currentStock:0},m)]));assert.equal((await row('materials',PES)).currentStock,11);
 await atomicReject(()=>raw(ids.employee,payload([set('materials',PES,{...m,name:'forged'},m)]),'qa-forge-name'),['42501']);});
await test('DATA-01 rejected commit changes neither cache nor ledger/audit/counters',async()=>{await seedPesOk();const m0=await row('materials',PES);await commit(ids.admin,payload([set('materials',PES,{...m0,notes:'n'},m0)]));
 const c=await cfgNow();await atomicReject(()=>raw(ids.employee,payload([set('transactions','t-bad',tr('t-bad','O-0003',50,'صادر',WA)),set('settings','app_config',{...c,transactionCounters:{...c.transactionCounters,outbound:3}},c)]),'qa-neg'),['23514']);});
await test('DATA-01 concurrent writers and import keep projections equal to the ledger',async()=>{await seedPesOk();const c=await cfgNow();
 const p=(id,n)=>payload([set('transactions',id,tr(id,n,1,'وارد',WA)),set('settings','app_config',{...c,transactionCounters:{...c.transactionCounters,inbound:4}},c)]);
 const r=await Promise.allSettled([commit(ids.employee,p('cc1','W-0004')),commit(ids.employee,p('cc2','W-0004'))]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 const c2=await cfgNow();await commit(ids.admin,payload([set('materials','imp-a',mat('imp-a','SAN-2001',{category:'معقمات ومطهرات'})),set('materials','imp-b',mat('imp-b','SAN-2002',{category:'معقمات ومطهرات'})),
  set('transactions','op-ia',{...tr('op-ia','OP-0002',3,'افتتاحي',WA),itemId:'imp-a',itemCode:'SAN-2001'}),set('transactions','op-ib',{...tr('op-ib','OP-0003',6,'افتتاحي',WB),itemId:'imp-b',itemCode:'SAN-2002'}),
  set('settings','app_config',{...c2,transactionCounters:{...c2.transactionCounters,opening:3}},c2)]));
 assert.equal((await row('materials','imp-a')).currentStock,3);assert.deepEqual((await row('materials','imp-b')).warehouseStocksById,{[WB]:6});});

await test('R1-RT11 deleting an opening row alone is refused (the initialStock fallback would re-create it); with initialStock cleared in the same request it commits and stock drops',async()=>{await seedPesOk();await seedZero();
 let m=await row('materials',Z);const op=ztr('zop','OP-0002',4,'افتتاحي',WA);
 await commit(ids.admin,payload([set('materials',Z,{...m,initialStock:4},m),set('transactions','zop',op)]));assert.equal((await row('materials',Z)).currentStock,4);
 const opRow=await row('transactions','zop');m=await row('materials',Z);
 await atomicReject(()=>raw(ids.admin,payload([del('transactions','zop',opRow)]),'qa-rt11-alone'),['23514'],/OPENING_LEDGER_REQUIRED/);
 await commit(ids.admin,payload([del('transactions','zop',opRow),set('materials',Z,{...m,initialStock:0},m)]));assert.equal((await row('materials',Z)).currentStock,0);});
await test('R1-RT02 production-shaped drift (PES-1001 stored 12 vs ledger 10) is never corrected implicitly: ordinary changes are refused, settings-wide refresh holds it, only reconcile fixes it',async()=>{
 await seedPes();await archiver();const before=await row('materials',PES);const c=await cfgNow();const L=pesLedger();
 const inc=k=>set('settings','app_config',{...c,transactionCounters:{...c.transactionCounters,[k]:c.transactionCounters[k]+1}},c);
 const refused=[['employee inbound (A1)',ids.employee,payload([set('transactions','a1',tr('a1','W-0004',1,'وارد',WA)),inc('inbound')])],
  ['business edit',ids.admin,payload([set('materials',PES,{...before,notes:'edit'},before)])],
  ['delete old transaction',ids.admin,payload([del('transactions',L[1].id,L[1])])],
  ['correction',ids.admin,payload([del('transactions',L[1].id,L[1]),set('transactions','rep',tr('rep','W-0009',4,'وارد',WA,{correctionOf:{id:L[1].id,transactionNumber:'W-0003',quantity:5,reason:'x'}}))],'correction')],
  ['archive',ids.admin,archiveP(PES,0)]];
 for(const [n,who,p] of refused)await atomicReject(()=>raw(who,p,'qa-rt02-'+n.replace(/\W+/g,'-')),['23514'],/RECONCILE_REQUIRED:PES-1001|ARCHIVE_NONZERO/).catch(e=>{throw new Error(n+': '+e.message);});
 assert.deepEqual(await row('materials',PES),before);
 // A1b: a settings change (unit added) commits, but the drifted stored projection is held untouched and reported.
 const a=await commit(ids.admin,payload([set('settings','app_config',{...c,units:[...c.units,'كيلو']},c)]));assert.deepEqual(a.audit.projectionDriftHeld,[PES]);
 assert.equal((await row('materials',PES)).currentStock,12);assert.deepEqual(await row('materials',PES),before);
 const d=(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_projection_drift() d'))).rows[0].d;assert.equal(d.rows.find(x=>x.id===PES).status,'drift');
 // Only the explicit, audited reconcile corrects it; afterwards the same inbound commits normally.
 await commit(ids.admin,{mode:'reconcile',label:'QA',reconcile:{reason:'approved',materials:[{id:PES,expected:before}]}},'qa-rt02-recon');assert.equal((await row('materials',PES)).currentStock,10);
 const c2=await cfgNow();await commit(ids.employee,payload([set('transactions','a2',tr('a2','W-0004',1,'وارد',WA)),set('settings','app_config',{...c2,transactionCounters:{...c2.transactionCounters,inbound:4}},c2)]));
 assert.equal((await row('materials',PES)).currentStock,11);});

// ───────────────────────── R8-ARC-01 ─────────────────────────
await test('ARC-01 archive requires the explicit materials_archive capability (admin preset alone is denied)',async()=>{await seedZero();
 await atomicReject(()=>raw(ids.admin,archiveP(Z,0),'qa-arc-denied1'),['42501'],/LIFECYCLE_DENIED/);await atomicReject(()=>raw(ids.employee,archiveP(Z,0),'qa-arc-denied2'),['42501']);
 await atomicReject(()=>raw(ids.reader,archiveP(Z,0),'qa-arc-denied3'),['42501']);});
await test('ARC-01 archive of a zero-balance item keeps id/code, its ledger rows and prior audits; appends one receipt',async()=>{await seedZero();await archiver();
 await commit(ids.admin,{mode:'audit',label:'QA',operations:[{collection:'audit_logs',docId:'p',kind:'set',value:{action:'prior',details:'prior'}}]},'qa-prior-audit-2');
 const lh=await ledgerHash(Z);const ah=await auditHashes();const c=await counters();
 const a=await commit(ids.admin,archiveP(Z,0),'qa-arc-0001');const m=await row('materials',Z);
 assert.equal(m.id,Z);assert.equal(m.code,'PES-1002');assert.equal(m.lifecycleStatus,'archived');assert.equal(m.lifecycleVersion,1);assert.equal(m.archivedBy,ids.admin);assert.equal(m.archivePurpose,'qa_test_data');
 assert.equal(m.ledgerTotalStock,0);assert.equal(a.audit.lifecycle.ledgerTotalStock,0);assert.equal(a.audit.lifecycle.ledgerRows,2);
 assert.equal(await ledgerHash(Z),lh);assert.deepEqual(await counters(),c);const ah2=await auditHashes();for(const x of ah)assert.ok(ah2.includes(x));assert.equal(ah2.length,ah.length+1);});
await test('R1-R2-01 nonzero stock can never be archived, whatever the declared purpose (qa_test_data included); zero stock can',async()=>{await seedPesOk();await seedZero();await archiver();
 for(const purpose of ['qa_test_data','discontinued'])await atomicReject(()=>raw(ids.admin,archiveP(PES,0,{purpose}),'qa-arc-nz-'+purpose),['23514'],/ARCHIVE_NONZERO_STOCK/);
 await atomicReject(()=>raw(ids.admin,archiveP(PES,0,{purpose:'other'}),'qa-arc-bad'),['22023']);
 await commit(ids.admin,archiveP(Z,0,{purpose:'discontinued'}));assert.equal((await row('materials',Z)).lifecycleStatus,'archived');assert.equal((await row('materials',PES)).lifecycleStatus,undefined);});
await test('ARC-01 server rejects every new ledger effect on an archived item (all paths atomic)',async()=>{await seedZero();await archiver();await commit(ids.admin,archiveP(Z,0));
 const c=await cfgNow();const inc=k=>set('settings','app_config',{...c,transactionCounters:{...c.transactionCounters,[k]:c.transactionCounters[k]+1}},c);const L=zLedger();const m=await row('materials',Z);
 const cases=[
  ['inbound',payload([set('transactions','n1',ztr('n1','W-0001',1,'وارد',WA)),inc('inbound')])],
  ['outbound',payload([set('transactions','n2',ztr('n2','O-0001',1,'صادر',WA)),inc('outbound')])],
  ['consumed',payload([set('transactions','n3',ztr('n3','C-0001',1,'مستهلك',WB)),inc('consumed')])],
  ['transfer both legs',payload([set('transactions','x1',ztr('x1','T-0001-OUT',1,'تحويل',WA,{transferType:'out',operationId:'opx',pairedTransactionId:'x2'})),set('transactions','x2',ztr('x2','T-0001-IN',1,'تحويل',WB,{transferType:'in',operationId:'opx',pairedTransactionId:'x1'})),inc('transfer')])],
  ['delete old transaction',payload([del('transactions',L[1].id,L[1])])],
  ['correction',payload([del('transactions',L[0].id,L[0]),set('transactions','rep',ztr('rep','W-0009',3,'وارد',WA,{correctionOf:{id:L[0].id,transactionNumber:'ZW-0001',quantity:3,reason:'x'}}))],'correction')],
  ['opening/import',payload([set('materials',Z,{...m,initialStock:20},m),set('transactions','op2',ztr('op2','OP-0002',20,'افتتاحي',WA))])],
  ['material delete',payload([del('materials',Z,m)])],
  ['re-code',payload([set('materials',Z,{...m,code:'PES-1003'},m)])],
  ['bundled unarchive + transaction',payload([set('materials',Z,{...m,lifecycleStatus:'active',lifecycleVersion:9},m),set('transactions','n9',ztr('n9','W-0001',1,'وارد',WA)),inc('inbound')])],
 ];
 for(const [name,p] of cases){await atomicReject(()=>raw(ids.admin,p,'qa-arc-block-'+name.replace(/\W+/g,'-')),['23514'],/MATERIAL_ARCHIVED/).catch(x=>{throw new Error(name+': '+x.message);});}
 assert.equal((await row('materials',Z)).lifecycleStatus,'archived');assert.equal(await count('transactions'),2);});
await test('ARC-01 legacy whole-document write cannot clear or forge lifecycle; omitted fields keep it archived',async()=>{await seedZero();await archiver();await commit(ids.admin,archiveP(Z,0));
 const m=await row('materials',Z);const legacy={...m};for(const k of ['lifecycleStatus','lifecycleVersion','archivedAt','archivedBy','archivedByName','archiveReason','archivePurpose'])delete legacy[k];
 await commit(ids.admin,payload([set('materials',Z,{...legacy,notes:'legacy client edit'},legacy)]));let after=await row('materials',Z);assert.equal(after.lifecycleStatus,'archived');assert.equal(after.notes,'legacy client edit');
 await commit(ids.admin,payload([set('materials',Z,{...after,notes:'n2',lifecycleStatus:'active',lifecycleVersion:0},after)]));after=await row('materials',Z);assert.equal(after.lifecycleStatus,'archived');assert.equal(after.lifecycleVersion,1);
 await commit(ids.admin,payload([set('materials','m-new',{...mat('m-new','PES-1003'),lifecycleStatus:'archived'})]));assert.equal((await row('materials','m-new')).lifecycleStatus,undefined);});
await test('ARC-01 duplicate/stale archive is refused; replay returns the original receipt',async()=>{await seedZero();await archiver();const a=await commit(ids.admin,archiveP(Z,0),'qa-arc-dup-1');
 const r=await raw(ids.admin,archiveP(Z,0),'qa-arc-dup-1');assert.equal(r.replayed,true);assert.equal(r.audit.timestamp,a.audit.timestamp);assert.equal(await count('audit_logs'),1);
 await atomicReject(()=>raw(ids.admin,archiveP(Z,0),'qa-arc-dup-2'),['40001'],/LIFECYCLE_STALE/);await atomicReject(()=>raw(ids.admin,archiveP(Z,1),'qa-arc-dup-3'),['23514'],/STATE_INVALID/);});
await test('ARC-01 request queued before archive is rejected after it (blocked, atomic); archive/receipt race: exactly one wins',async()=>{await seedZero();await archiver();const c=await cfgNow();
 const queued=payload([set('transactions','off1',ztr('off1','W-0001',1,'وارد',WA)),set('settings','app_config',{...c,transactionCounters:{...c.transactionCounters,inbound:1}},c)]);
 await commit(ids.admin,archiveP(Z,0));await atomicReject(()=>raw(ids.employee,queued,'qa-offline-queued-1'),['23514'],/MATERIAL_ARCHIVED/);
 await commit(ids.admin,reactivateP(Z,1));const c2=await cfgNow();
 const race=payload([set('transactions','race1',ztr('race1','W-0001',1,'وارد',WA)),set('settings','app_config',{...c2,transactionCounters:{...c2.transactionCounters,inbound:1}},c2)]);
 const r=await Promise.allSettled([raw(ids.employee,race,'qa-race-tx'),raw(ids.admin,archiveP(Z,2),'qa-race-arc')]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 const m=await row('materials',Z);const hasTx=await count('transactions')===3;assert.equal(m.lifecycleStatus,hasTx?'active':'archived');assert.equal(m.ledgerTotalStock,hasTx?1:0);await assertProjectionInvariant();});
await test('ARC-01 archived code is never reused (direct create) and reactivation reopens movements',async()=>{await seedZero();await archiver();await commit(ids.admin,archiveP(Z,0));
 await atomicReject(()=>raw(ids.admin,payload([set('materials','m-dup',mat('m-dup','PES-1002'))]),'qa-reuse'),['23505'],/CODE_RESERVED/);
 await commit(ids.admin,reactivateP(Z,1));const c=await cfgNow();
 await commit(ids.employee,payload([set('transactions','after',ztr('after','W-0001',1,'وارد',WA)),set('settings','app_config',{...c,transactionCounters:{...c.transactionCounters,inbound:1}},c)]));assert.equal((await row('materials',Z)).currentStock,1);});

// ───────────────────────── R8-REC-01 ─────────────────────────
await test('REC-01 archive -> reactivate -> archive: versions 1/2/3, three receipts, no counter rewind, ledger unchanged',async()=>{await seedZero();await archiver();const lh=await ledgerHash(Z);const c=await counters();
 await commit(ids.admin,archiveP(Z,0),'qa-rec-1');await commit(ids.admin,reactivateP(Z,1),'qa-rec-2');await commit(ids.admin,archiveP(Z,2),'qa-rec-3');
 const m=await row('materials',Z);assert.equal(m.lifecycleVersion,3);assert.equal(m.lifecycleStatus,'archived');assert.equal(m.currentStock,0);
 const rec=(await q("select data from audit_logs where data ? 'lifecycle' order by id")).map(r=>r.data.lifecycle.action);assert.deepEqual(rec,['archive','reactivate','archive']);
 assert.equal(await ledgerHash(Z),lh);assert.deepEqual(await counters(),c);});
await test('REC-01 stale compensating rollback is refused when another change intervened',async()=>{await seedZero();await archiver();await commit(ids.admin,archiveP(Z,0));await commit(ids.admin,reactivateP(Z,1));
 await atomicReject(()=>raw(ids.admin,reactivateP(Z,1),'qa-rec-stale'),['40001'],/LIFECYCLE_STALE/);});
await test('REC-01 backup round trip keeps lifecycle; older snapshot cannot silently reactivate; stale explicit lifecycle refused',async()=>{await seedZero();await archiver();await commit(ids.admin,archiveP(Z,0));
 const users=(await q('select data from users order by id')).map(r=>r.data);const L=zLedger();const s=await cfgNow();
 const restore=async(materials,id)=>{const b={settings:s,materials,transactions:L,generatorLogs:[],users};const pre=(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_restore_preview($1) p',[JSON.stringify(b)]))).rows[0].p;return raw(ids.admin,{mode:'restore',label:'QA',backup:b,expectedState:pre.expectedState},id);};
 const full=await row('materials',Z);await restore([full],'qa-rt-1');assert.equal((await row('materials',Z)).lifecycleStatus,'archived');await assertProjectionInvariant();
 const a=await restore([zMat()],'qa-rt-2');const m=await row('materials',Z);assert.equal(m.lifecycleStatus,'archived');assert.deepEqual(a.audit.lifecyclePreserved,[Z]);assert.equal(m.currentStock,0);
 await commit(ids.admin,reactivateP(Z,1));await atomicReject(()=>restore([{...full}],'qa-rt-3'),['40001'],/RESTORE_LIFECYCLE_STALE/);
 assert.equal(await count('transactions'),2);});
await test('REC-01 old-server compatibility: main SQL rejects lifecycle/reconcile atomically; the SAME queued request commits once after upgrade',async()=>{await seedZero();await archiver();
 await atomicReject(()=>raw(ids.admin,archiveP(Z,0),'qa-queued-lc-1'),['22023'],/OPERATIONS_INVALID/);
 await db.exec(CANDIDATE);const a=await raw(ids.admin,archiveP(Z,0),'qa-queued-lc-1');assert.equal(a.replayed,false);
 assert.equal((await raw(ids.admin,archiveP(Z,0),'qa-queued-lc-1')).replayed,true);assert.equal(await count('audit_logs'),1);},MAIN);
await test('REC-01 rollback to main SQL keeps every audit row, ledger row and lifecycle data; later lifecycle requests are refused',async()=>{await seedZero();await archiver();
 await commit(ids.admin,archiveP(Z,0),'qa-rb-1');await commit(ids.admin,reactivateP(Z,1),'qa-rb-2');const ah=await auditHashes();const lh=await ledgerHash(Z);
 await db.exec(MAIN);assert.deepEqual(await auditHashes(),ah);assert.equal(await ledgerHash(Z),lh);assert.equal((await row('materials',Z)).lifecycleVersion,2);
 await atomicReject(()=>raw(ids.admin,archiveP(Z,2),'qa-rb-3'),['22023']);});

// ───────────────────────── R8-CODE-01 / POL-01/02 ─────────────────────────
const next=async(cat,who=ids.admin)=>(await asUser(db,who,tx=>tx.query('select public.inventory_next_material_code($1) n',[cat]))).rows[0].n;
const cfgCase=async(name,mutate,re)=>{const c=await cfgNow();const next=structuredClone(c);mutate(next);await atomicReject(()=>raw(ids.admin,payload([set('settings','app_config',next,c)]),'qa-cfg-'+name),['23514'],re).catch(e=>{throw new Error(name+': '+e.message);});};
await test('CODE-01 CFG-02 category configuration validated at the server (names, prefixes, integer ordered non-overlapping ranges)',async()=>{
 await cfgCase('dup-name',c=>{c.categories[1].name=' مبيدات  حشرية';},/CATEGORY_(DUPLICATE|CONFIG_INVALID)/);
 await cfgCase('dup-name-case',c=>{c.categories.push({name:'qa x',prefix:'QAX',startRange:7001,endRange:7999},{name:'QA X',prefix:'QAY',startRange:8001,endRange:8999});},/CATEGORY_DUPLICATE/);
 await cfgCase('dup-prefix',c=>{c.categories[1].prefix='PES';},/CATEGORY_DUPLICATE/);
 await cfgCase('lower-prefix',c=>{c.categories[1].prefix='san';},/CONFIG_INVALID/);
 await cfgCase('overlap',c=>{c.categories[1].startRange=1500;},/RANGE_OVERLAP/);
 await cfgCase('non-integer',c=>{c.categories[0].endRange=1999.5;},/CONFIG_INVALID/);
 await cfgCase('string-range',c=>{c.categories[0].endRange='1999';},/CONFIG_INVALID/);
 await cfgCase('reversed',c=>{c.categories[0].startRange=1999;c.categories[0].endRange=1001;},/CONFIG_INVALID/);
 await cfgCase('empty-name',c=>{c.categories[0].name='  ';},/CONFIG_INVALID/);});
await test('R1-R2-03 the five-category policy is pinned after migration: no removal, re-prefix, shrink, widen, overlap, addition or name swap; a display rename with its materials is allowed',async()=>{await seedPesOk();await commit(ids.admin,payload([set('materials','m-1',mat('m-1','PES-1002'))]));
 assert.deepEqual((await q('select prefix,start_range::int s,end_range::int e from inventory_private.category_policy order by prefix')).map(r=>[r.prefix,r.s,r.e]),[['CHM',5001,5999],['EQP',3001,3999],['PES',1001,1999],['ROD',4001,4999],['SAN',2001,2999]]);
 await cfgCase('rename-prefix',c=>{c.categories[0].prefix='PST';},/PREFIX_FROZEN|POLICY_PINNED/);
 await cfgCase('shrink-used',c=>{c.categories[0].endRange=1002;},/POLICY_PINNED/);
 await cfgCase('shrink-used-start',c=>{c.categories[0].startRange=1002;},/PREFIX_FROZEN|POLICY_PINNED/);
 await cfgCase('shrink-unused',c=>{c.categories[4].endRange=5001;},/POLICY_PINNED/);
 await cfgCase('widen',c=>{c.categories[4].endRange=6999;},/POLICY_PINNED/);
 await cfgCase('reprefix-unused',c=>{c.categories[1].prefix='SNT';},/POLICY_PINNED/);
 await cfgCase('remove-unused',c=>{c.categories=c.categories.filter(x=>x.prefix!=='SAN');},/POLICY_PINNED/);
 await cfgCase('remove-used',c=>{c.categories=c.categories.slice(1);},/CATEGORY_IN_USE|PREFIX_FROZEN|POLICY_PINNED/);
 await cfgCase('add-sixth',c=>{c.categories.push({name:'أخرى',prefix:'ZZZ',startRange:9001,endRange:9002});},/POLICY_PINNED/);
 await cfgCase('overlap',c=>{c.categories[1].startRange=1500;},/RANGE_OVERLAP|POLICY_PINNED/);
 await cfgCase('swap-names',c=>{const a=c.categories[0].name;c.categories[0].name=c.categories[1].name;c.categories[1].name=a;},/CODE_CATEGORY_MISMATCH/);
 const c=await cfgNow();const same=structuredClone(c);same.categories[2].name='معدات رش';await commit(ids.admin,payload([set('settings','app_config',same,c)]));});
await test('CODE-01 referenced category rename (same prefix) is atomic with its materials; history is never recoded',async()=>{await seedPesOk();const c=await cfgNow();const m=await row('materials',PES);
 const next=structuredClone(c);next.categories[0].name='مبيدات حشرية ومكافحة';
 await commit(ids.admin,payload([set('settings','app_config',next,c),set('materials',PES,{...m,category:'مبيدات حشرية ومكافحة'},m)]));assert.equal((await row('materials',PES)).code,'PES-1001');
 const c2=await cfgNow();const m2=await row('materials',PES);await atomicReject(()=>raw(ids.admin,payload([set('materials',PES,{...m2,category:'معقمات ومطهرات'},m2)]),'qa-cat-move'),['23514'],/CODE_CATEGORY_MISMATCH/);});
await test('CODE-01 MAT-02 per-material membership: prefix, boundaries, case/whitespace, leading zeros (direct RPC)',async()=>{
 const bad=[['wrong-prefix','SAN-2001'],['below','PES-1000'],['above','PES-2000'],['lower','pes-1002'],['space',' PES-1002'],['zero','PES-01002'],['no-dash','PES1002']];
 for(const [n,code] of bad)await atomicReject(()=>raw(ids.admin,payload([set('materials','m-'+n,mat('m-'+n,code))]),'qa-mem-'+n),['23514'],/CODE_CATEGORY_MISMATCH/).catch(e=>{throw new Error(n+': '+e.message);});
 await commit(ids.admin,payload([set('materials','lo',mat('lo','PES-1001')),set('materials','lo2',mat('lo2','PES-1002'))]));});
await test('R1-RT03 codes are issued only in central order: a manual/imported/RPC code that skips ahead (PES-1999, PES-1500) is refused, so no range can be exhausted; consecutive import batches are accepted in any op order',async()=>{await seedPesOk();
 await atomicReject(()=>raw(ids.employee,payload([set('materials','e1',mat('e1','PES-1999'))]),'qa-rt03-1999'),['23514'],/CODE_NOT_NEXT:PES-1999:PES-1002/);
 await atomicReject(()=>raw(ids.admin,payload([set('materials','i1',mat('i1','PES-1002')),set('materials','i2',mat('i2','PES-1500'))]),'qa-rt03-1500'),['23514'],/CODE_NOT_NEXT/);
 assert.equal((await next('مبيدات حشرية')).code,'PES-1002');
 await commit(ids.admin,payload([set('materials','b2',mat('b2','PES-1003')),set('materials','b1',mat('b1','PES-1002'))]));assert.equal((await next('مبيدات حشرية')).code,'PES-1004');
 const m=await row('materials','b2');await atomicReject(()=>raw(ids.admin,payload([set('materials','b2',{...m,code:'PES-1900'},m)]),'qa-rt03-recode'),['23514'],/CODE_NOT_NEXT/);});
await test('CODE-01 import batch and restore with a wrong-category code are rejected atomically',async()=>{
 await atomicReject(()=>raw(ids.admin,payload([set('materials','i1',mat('i1','PES-1002')),set('materials','i2',mat('i2','CHM-5001'))]),'qa-imp-bad'),['23514']);
 const users=(await q('select data from users order by id')).map(r=>r.data);const b={settings:cfg,materials:[mat('r1','EQP-3001')],transactions:[],generatorLogs:[],users};
 const pre=(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_restore_preview($1) p',[JSON.stringify(b)]))).rows[0].p;
 await atomicReject(()=>raw(ids.admin,{mode:'restore',label:'QA',backup:b,expectedState:pre.expectedState},'qa-rst-bad'),['23514'],/CODE_CATEGORY_MISMATCH/);});
await test('CODE-01 central next code uses all materials incl. archived and the permanent registry (deleted codes never reused, not even by the same id)',async()=>{await seedPesOk();await seedZero();await archiver();
 assert.equal((await next('مبيدات حشرية')).code,'PES-1003');await commit(ids.admin,archiveP(Z,0));assert.equal((await next('مبيدات حشرية')).code,'PES-1003');
 await commit(ids.admin,payload([set('materials','m2',mat('m2','PES-1003'))]));await commit(ids.admin,payload([del('materials','m2',await row('materials','m2'))]));
 assert.equal((await next('مبيدات حشرية')).code,'PES-1004');await atomicReject(()=>raw(ids.admin,payload([set('materials','m3',mat('m3','PES-1003'))]),'qa-deleted-reuse'),['23505'],/CODE_RESERVED/);
 // R2-R8-04: re-creating the deleted id with its old code is refused; the same id may only take the next central code.
 await atomicReject(()=>raw(ids.admin,payload([set('materials','m2',{...mat('m2','PES-1003'),name:'Completely different product'})]),'qa-same-id-reuse'),['23505'],/CODE_RESERVED/);
 await commit(ids.admin,payload([set('materials','m2',mat('m2','PES-1004'))]));assert.equal((await next('مبيدات حشرية')).code,'PES-1005');
 assert.equal((await next('معقمات ومطهرات')).code,'SAN-2001');assert.equal((await next('طعوم قوارض')).code,'ROD-4001');});
await test('CODE-01 two clients allocating together: exactly one commits, the other gets a clear retry with nothing written',async()=>{
 const a=(await next('معقمات ومطهرات')).code,b=(await next('معقمات ومطهرات')).code;assert.equal(a,b);const audits=await count('audit_logs');
 const r=await Promise.allSettled([raw(ids.admin,payload([set('materials','c1',mat('c1',a,{category:'معقمات ومطهرات'}))]),'qa-alloc-1'),raw(ids.employee,payload([set('materials','c2',mat('c2',b,{category:'معقمات ومطهرات'}))]),'qa-alloc-2')]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);const lost=r.find(x=>x.status==='rejected');assert.match(lost.reason.message,/INVENTORY_CODE_RESERVED/);assert.equal(lost.reason.code,'23505');
 assert.equal(await count('audit_logs'),audits+1);assert.equal((await next('معقمات ومطهرات')).code,'SAN-2002');});
await test('CODE-01 exhausted range stops (no endRange+1) — last number reached through central allocation',async()=>{
 await q("insert into inventory_private.material_code_registry(code_key,code,prefix,number,material_id,source,deleted_at) values('rod-4998','ROD-4998','ROD',4998,'qa-old','qa-seed',now())");
 await commit(ids.admin,payload([set('materials','r1',mat('r1','ROD-4999',{category:'طعوم قوارض'}))]));
 await rejects(()=>next('طعوم قوارض'),['23514'],/RANGE_EXHAUSTED/);await atomicReject(()=>raw(ids.admin,payload([set('materials','r3',mat('r3','ROD-5000',{category:'طعوم قوارض'}))]),'qa-exh'),['23514']);});
await test('CODE-01 legacy code keeps working without recoding; new legacy codes are refused',async()=>{await q('insert into materials(id,data) values($1,$2)',['legacy',JSON.stringify(mat('legacy','OLD-X1'))]);await db.exec(CANDIDATE);
 const m=await row('materials','legacy');await commit(ids.admin,payload([set('materials','legacy',{...m,notes:'n'},m)]));assert.equal((await row('materials','legacy')).code,'OLD-X1');
 await atomicReject(()=>raw(ids.admin,payload([set('materials','legacy2',mat('legacy2','OLD-X2'))]),'qa-legacy-new'),['23514']);});

// ───────────────────────── R8-RBAC-01 ─────────────────────────
await test('R1-R2-05 audit events are server-controlled: reader may only report sign-in/out; unknown events, item types and floods are refused',async()=>{await seedPesOk();
 const ev=(action,more={})=>({mode:'audit',label:'QA',operations:[{collection:'audit_logs',docId:'x',kind:'set',value:{action,details:'d',...more}}]});
 await atomicReject(()=>raw(ids.reader,ev('forged action'),'qa-aud-r1'),['42501'],/AUDIT_EVENT_DENIED/);
 await atomicReject(()=>raw(ids.reader,ev('إضافة حركة مخزنية'),'qa-aud-r2'),['42501'],/AUDIT_EVENT_DENIED/);
 await atomicReject(()=>raw(ids.employee,ev('إضافة حركة مخزنية',{itemType:'<script>'}),'qa-aud-r3'),['42501'],/AUDIT_EVENT_DENIED/);
 await atomicReject(()=>raw(ids.employee,ev('anything'),'qa-aud-r4'),['42501'],/AUDIT_EVENT_DENIED/);
 const a=await commit(ids.reader,ev('تسجيل الدخول'),'qa-aud-login');assert.equal(a.audit.actorUserId,ids.reader);assert.equal(a.audit.result,'reported');
 await commit(ids.employee,ev('إضافة حركة مخزنية',{itemType:'حركة'}),'qa-aud-emp');
 for(let i=0;i<60;i++)await q("insert into audit_logs(id,data,updated_at) values($1,$2,now())",['qa-flood-'+i,JSON.stringify({actorUserId:ids.employee,result:'reported',action:'x'})]);
 await atomicReject(()=>raw(ids.employee,ev('إضافة حركة مخزنية'),'qa-aud-flood'),['54000'],/AUDIT_RATE_LIMITED/);
 await commit(ids.admin,ev('any administrative note'),'qa-aud-admin');});
await test('RBAC-01 reader reads materials/transactions/settings but no audit; every forged write RPC is rejected atomically',async()=>{await seedPes();await archiver();
 const read=async sql=>(await asUser(db,ids.reader,tx=>tx.query(sql))).rows;assert.equal((await read('select id from materials')).length,1);assert.equal((await read('select id from transactions')).length,7);
 assert.equal((await read('select id from settings')).length,1);await commit(ids.admin,{mode:'audit',label:'QA',operations:[{collection:'audit_logs',docId:'z',kind:'set',value:{action:'a',details:'d'}}]},'qa-rbac-audit');
 assert.equal((await read('select id from audit_logs')).length,0);
 const m=await row('materials',PES);const c=await cfgNow();const u=await row('users',ids.employee);const users=(await q('select data from users')).map(r=>r.data);
 const forged=[['create material',payload([set('materials','rx',mat('rx','PES-1002'))])],['edit material',payload([set('materials',PES,{...m,name:'x'},m)])],['delete material',payload([del('materials',PES,m)])],
  ['import',payload([set('materials','ri',mat('ri','PES-1003')),set('transactions','ro',{...tr('ro','OP-0002',1,'افتتاحي',WA),itemId:'ri'})])],['transaction',payload([set('transactions','rt',tr('rt','W-0004',1,'وارد',WA))])],
  ['delete transaction',payload([del('transactions',pesLedger()[1].id,pesLedger()[1])])],['settings',payload([set('settings','app_config',{...c,organizationName:'x'},c)])],
  ['user',payload([set('users',ids.employee,{...u,permissions:['users_manage']},u)])],['restore',{mode:'restore',label:'x',backup:{settings:c,materials:[],transactions:[],generatorLogs:[],users},expectedState:'x'}],
  ['archive',archiveP(PES,0)],['reconcile',{mode:'reconcile',label:'x',reconcile:{reason:'x',materials:[{id:PES,expected:m}]}}]];
 for(const [n,p] of forged)await atomicReject(()=>raw(ids.reader,p,'qa-reader-'+n.replace(/\W+/g,'-')),['42501']).catch(e=>{throw new Error(n+': '+e.message);});
 await atomicReject(()=>asUser(db,ids.reader,tx=>tx.query('select public.inventory_restore_preview($1)',[JSON.stringify({settings:c,materials:[],transactions:[],generatorLogs:[],users:[]})])),['42501']);
 await rejects(()=>next('مبيدات حشرية',ids.reader),['42501']);
 for(const t of ['materials','transactions','settings','users','audit_logs'])await rejects(()=>asUser(db,ids.reader,tx=>tx.query(`update ${t} set data=data`)),['42501']);});

const report={suite:'R8 readiness (PGlite isolated): DATA-01, ARC-01, REC-01, CODE-01, POL-01/02, RBAC-01',total:results.length,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,results};
fs.writeFileSync(process.env.QA_R8_OUTPUT||'/tmp/inventory-r8-readiness.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,1));await db.close();if(report.failed)process.exitCode=1;
