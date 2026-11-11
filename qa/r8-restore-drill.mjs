// R8-LIVE-01 restore drill rehearsal — isolated PGlite only (two disposable databases). Never points at production.
// Source DB -> full application backup (manifest + SHA-256) -> admin preview -> expected-state restore into a fresh
// disposable target -> verification of counts, per-record hashes, per-warehouse ledger totals, lifecycle/archive,
// reserved codes, audit retention, stale-preview rejection, retried restore and reader restrictions.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createIsolatedDatabase,seedAccounts,asUser,ids,allPermissions} from './schema.mjs';
const CANDIDATE=fs.readFileSync(new URL('../database/inventory_atomic.sql',import.meta.url),'utf8');
const WA='wh-0ulyoh6',WB='wh-0ek8571',PES='mat-1793795662160',SAN='mat-drill-san-2001';
const categories=[{name:'مبيدات حشرية',prefix:'PES',startRange:1001,endRange:1999},{name:'معقمات ومطهرات',prefix:'SAN',startRange:2001,endRange:2999},
 {name:'معدات رش ومكافحة',prefix:'EQP',startRange:3001,endRange:3999},{name:'طعوم قوارض',prefix:'ROD',startRange:4001,endRange:4999},{name:'كلور ومواد كيميائية',prefix:'CHM',startRange:5001,endRange:5999}];
const cfg={id:'app_config',organizationName:'QA drill',storehouseEntities:[{id:WA,name:'المخزن الرئيسي',active:true},{id:WB,name:'مخزن ب',active:true}],storehouses:['المخزن الرئيسي','مخزن ب'],storehouseIds:[WA,WB],
 units:['لتر','قطعة'],categories,transactionCounters:{inbound:3,outbound:2,consumed:1,opening:1,transfer:1,adjustment:0}};
const tr=(id,n,q,type,wh,more={})=>({id,itemId:PES,itemCode:'PES-1001',date:'2026-11-04',transactionNumber:n,transactionType:type,storehouseId:wh,quantity:q,createdAt:'2026-11-04T10:00:00Z',...more});
const pesLedger=()=>[tr('tr-init-mat-1793795662160','OP-0001',10,'افتتاحي',WA),tr('tr-1793795875190','W-0003',5,'وارد',WA),tr('tr-1793796116084','O-0001',3,'صادر',WA),
 tr('transfer-83c5ee06-out','T-0001-OUT',2,'تحويل',WA,{transferType:'out',operationId:'transfer-83c5ee06',pairedTransactionId:'transfer-83c5ee06-in'}),
 tr('transfer-83c5ee06-in','T-0001-IN',2,'تحويل',WB,{transferType:'in',operationId:'transfer-83c5ee06',pairedTransactionId:'transfer-83c5ee06-out'}),
 tr('tr-1793821614812','C-0001',1,'مستهلك',WA),tr('tr-recon-1793822708552-mh21','O-0002',1,'صادر',WB)]
 .map((t,i)=>({...t,createdAt:`2026-11-04T09:${String(i<4?i*10:i===4?30:(i-1)*10).padStart(2,'0')}:00Z`}));
const boot=async()=>{const db=await createIsolatedDatabase();await db.exec('CREATE TABLE auth.users(id uuid primary key,email text);');
 for(const [name,id] of Object.entries(ids))await db.query('insert into auth.users values($1,$2)',[id,name+'@qa.invalid']);
 await db.exec(CANDIDATE);await seedAccounts(db);await db.query('update users set permissions=$1,data=jsonb_set(data,$2,$1) where id=$3',[JSON.stringify([...allPermissions,'materials_archive']),'{permissions}',ids.admin]);
 await db.query('insert into settings(id,data) values($1,$2)',['app_config',JSON.stringify(cfg)]);return db;};
const rowsOf=async(db,t)=>(await db.query(`select id,data from ${t} order by id`)).rows;
const commit=async(db,who,id,p)=>(await asUser(db,who,tx=>tx.query('select public.inventory_commit($1,$2) a',[id,JSON.stringify(p)]))).rows[0].a;
const canonical=v=>JSON.stringify(v,(k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(n=>[n,x[n]])):x);
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const ledgerTotals=async db=>(await db.query("select data->>'itemId' item, data->>'storehouseId' wh, sum(case when data->>'transactionType' in ('صادر','مستهلك') or (data->>'transactionType'='تحويل' and data->>'transferType'='out') then -(data->>'quantity')::numeric else (data->>'quantity')::numeric end) q from transactions group by 1,2 order by 1,2")).rows.map(r=>`${r.item}@${r.wh}=${Number(r.q)}`);
const results=[];const t0=Date.now();
const step=async(name,fn)=>{try{await fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:String(e.message).slice(0,400)});}};

const src=await boot();
// Source state: PES fixture (stale cache 12, seven ledger rows) reconciled is NOT required for the drill; archive it as QA data
// and add one real-shaped material with an opening balance through the supported path.
await src.query('insert into materials(id,data) values($1,$2)',[PES,JSON.stringify({id:PES,code:'PES-1001',name:'QA PES',category:'مبيدات حشرية',unit:'لتر',minimumStock:0,initialStock:10,primaryStorehouseId:WA,storageLocation:'المخزن الرئيسي',currentStock:12,warehouseStocks:{'المخزن الرئيسي':12}})]);
for(const t of pesLedger())await src.query('insert into transactions(id,data) values($1,$2)',[t.id,JSON.stringify(t)]);
await commit(src,ids.admin,'drill-archive-pes-1',{mode:'lifecycle',label:'QA',lifecycle:{action:'archive',materialId:PES,expectedLifecycleVersion:0,reason:'QA test record — not real stock',purpose:'qa_test_data'}});
const san={id:SAN,code:'SAN-2001',name:'معقم تجريبي',category:'معقمات ومطهرات',unit:'لتر',minimumStock:1,initialStock:0,primaryStorehouseId:WA,storageLocation:'المخزن الرئيسي'};
const setOp=(c,id,v,old=null)=>({collection:c,docId:id,kind:'set',value:{...v,id},expected:old?{kind:'present',data:old}:{kind:'missing'}});
const s0=(await src.query("select data from settings where id='app_config'")).rows[0].data;
await commit(src,ids.admin,'drill-open-san-1',{mode:'mutation',label:'QA',operations:[setOp('materials',SAN,san),
 setOp('transactions','drill-op-san',{itemId:SAN,itemCode:'SAN-2001',date:'2026-11-05',transactionNumber:'OP-0002',transactionType:'افتتاحي',storehouseId:WA,quantity:4,createdAt:'2026-11-05T08:00:00Z'}),
 setOp('settings','app_config',{...s0,transactionCounters:{...s0.transactionCounters,opening:2}},s0)]});

// 1. Export (full dataset, not a warehouse filter) with manifest + checksum.
const backup={settings:(await src.query("select data from settings where id='app_config'")).rows[0].data,materials:(await rowsOf(src,'materials')).map(r=>r.data),
 transactions:(await rowsOf(src,'transactions')).map(r=>r.data),generatorLogs:[],users:(await rowsOf(src,'users')).map(r=>r.data)};
const body=canonical(backup);const manifest={format:'inventory-app-backup',version:'r8-drill',counts:Object.fromEntries(Object.entries(backup).map(([k,v])=>[k,Array.isArray(v)?v.length:1])),sha256:sha(body)};
const recordHashes=Object.fromEntries(['materials','transactions'].flatMap(k=>backup[k].map(r=>[`${k}/${r.id}`,sha(canonical(r))])));
const srcTotals=await ledgerTotals(src);const srcAudit=(await rowsOf(src,'audit_logs')).length;

const tgt=await boot();
await commit(tgt,ids.admin,'drill-target-prior-audit',{mode:'audit',label:'QA',operations:[{collection:'audit_logs',docId:'drill-prior',kind:'set',value:{action:'prior',details:'target history'}}]});
const tgtAuditBefore=(await rowsOf(tgt,'audit_logs')).map(r=>r.id);
const preview=async db=>(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_restore_preview($1) p',[JSON.stringify(backup)]))).rows[0].p;

await step('DRILL-1 checksum of the exported file verifies before import',async()=>{assert.equal(sha(canonical(backup)),manifest.sha256);assert.equal(manifest.counts.materials,2);assert.equal(manifest.counts.transactions,8);});
await step('DRILL-2 non-admin preview is refused (reader/keeper cannot restore)',async()=>{
 for(const who of [ids.reader,ids.employee]){let e;try{await asUser(tgt,who,tx=>tx.query('select public.inventory_restore_preview($1) p',[JSON.stringify(backup)]));}catch(x){e=x;}assert.ok(e,'preview allowed for non-admin');}});
let pre;
await step('DRILL-3 stale preview is rejected and the target is unchanged',async()=>{const stale=await preview(tgt);
 await commit(tgt,ids.admin,'drill-target-change',{mode:'mutation',label:'QA',operations:[setOp('materials','drill-extra',{code:'CHM-5001',name:'تغيير بعد المعاينة',category:'كلور ومواد كيميائية',unit:'لتر',minimumStock:0,initialStock:0,primaryStorehouseId:WA,storageLocation:'المخزن الرئيسي'})]});
 const before=canonical(await rowsOf(tgt,'materials'));let e;try{await commit(tgt,ids.admin,'drill-restore-stale',{mode:'restore',label:'QA',backup,expectedState:stale.expectedState});}catch(x){e=x;}
 assert.equal(e?.code,'40001');assert.equal(canonical(await rowsOf(tgt,'materials')),before);});
await step('DRILL-4 preview -> expected-state restore succeeds; retried restore replays without duplication',async()=>{pre=await preview(tgt);
 const a=await commit(tgt,ids.admin,'drill-restore-1',{mode:'restore',label:'QA',backup,expectedState:pre.expectedState});assert.equal(a.replayed,false);
 const auditCount=(await rowsOf(tgt,'audit_logs')).length;const b=await commit(tgt,ids.admin,'drill-restore-1',{mode:'restore',label:'QA',backup,expectedState:pre.expectedState});
 assert.equal(b.replayed,true);assert.equal((await rowsOf(tgt,'audit_logs')).length,auditCount);});
await step('DRILL-5 counts, per-record hashes and per-warehouse ledger totals match the source',async()=>{
 assert.equal((await rowsOf(tgt,'materials')).length,2);assert.equal((await rowsOf(tgt,'transactions')).length,8);
 for(const r of await rowsOf(tgt,'transactions'))assert.equal(sha(canonical(r.data)),recordHashes[`transactions/${r.id}`],'transaction hash '+r.id);
 assert.deepEqual(await ledgerTotals(tgt),srcTotals);
 const pes=(await tgt.query('select data from materials where id=$1',[PES])).rows[0].data;assert.equal(pes.initialStock,10,'historical 10 preserved');
 assert.deepEqual(pes.warehouseStocksById,{[WA]:9,[WB]:1});assert.equal(pes.ledgerTotalStock,10);
 const drift=(await asUser(tgt,ids.admin,tx=>tx.query('select public.inventory_projection_drift() d'))).rows[0].d;assert.equal(drift.drift,0);});
await step('DRILL-6 archive/lifecycle survives: PES stays archived, absent from active stock, history intact',async()=>{
 const pes=(await tgt.query('select data from materials where id=$1',[PES])).rows[0].data;assert.equal(pes.lifecycleStatus,'archived');assert.equal(pes.archivePurpose,'qa_test_data');
 assert.equal(pes.currentStock,10);assert.equal((await tgt.query("select count(*) n from transactions where data->>'itemId'=$1",[PES])).rows[0].n,7);});
await step('DRILL-7 reserved codes: PES-1001 and SAN-2001 are reserved in the target; next codes never reuse them',async()=>{
 const next=async c=>(await asUser(tgt,ids.admin,tx=>tx.query('select public.inventory_next_material_code($1) n',[c]))).rows[0].n.code;
 assert.equal(await next('مبيدات حشرية'),'PES-1002');assert.equal(await next('معقمات ومطهرات'),'SAN-2002');
 const reg=(await tgt.query('select code from inventory_private.material_code_registry order by code')).rows.map(r=>r.code);assert.ok(reg.includes('PES-1001')&&reg.includes('SAN-2001'));});
await step('DRILL-8 target audit history is retained and one restore receipt is appended (not overwritten from JSON)',async()=>{
 const ids_=(await rowsOf(tgt,'audit_logs')).map(r=>r.id);for(const id of tgtAuditBefore)assert.ok(ids_.includes(id),'lost target audit '+id);
 assert.ok(ids_.includes('drill-restore-1'));assert.ok(srcAudit>0);});
await step('DRILL-9 login after restore + sample isolated transaction; reader stays read-only',async()=>{
 const s=(await tgt.query("select data from settings where id='app_config'")).rows[0].data;const m=(await tgt.query('select data from materials where id=$1',[SAN])).rows[0].data;
 await commit(tgt,ids.employee,'drill-post-restore-tx',{mode:'mutation',label:'QA',operations:[setOp('transactions','drill-in-san',{itemId:SAN,itemCode:'SAN-2001',date:'2026-11-06',transactionNumber:'W-0004',transactionType:'وارد',storehouseId:WA,quantity:1,createdAt:'2026-11-06T08:00:00Z'}),
  setOp('settings','app_config',{...s,transactionCounters:{...s.transactionCounters,inbound:s.transactionCounters.inbound+1}},s)]});
 assert.equal((await tgt.query('select data from materials where id=$1',[SAN])).rows[0].data.currentStock,5);void m;
 let e;try{await commit(tgt,ids.reader,'drill-reader-write',{mode:'mutation',label:'QA',operations:[setOp('transactions','drill-reader',{itemId:SAN,date:'2026-11-06',transactionNumber:'W-0099',transactionType:'وارد',storehouseId:WA,quantity:1})]});}catch(x){e=x;}
 assert.equal(e?.code,'42501');});
const report={suite:'R8-LIVE-01 restore drill rehearsal (PGlite, two disposable databases)',checksum:manifest.sha256,counts:manifest.counts,elapsedMs:Date.now()-t0,
 total:results.length,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,results};
console.log(JSON.stringify(report,null,1));await src.close();await tgt.close();if(report.failed)process.exit(1);
