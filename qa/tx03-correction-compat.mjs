// QA-20261109 TX-03 regression: a correction (cancel + replacement linked by correctionOf) is either committed
// with a complete audit receipt (removedTransactions + corrections) or rejected atomically. Proven against the
// candidate SQL AND the released #8 SQL (rollback target, kept verbatim in qa/fixtures).
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createIsolatedDatabase,seedAccounts,asUser,ids} from './schema.mjs';
const CANDIDATE=fs.readFileSync(new URL('../database/inventory_atomic.sql',import.meta.url),'utf8');
const PR8=fs.readFileSync(new URL('./fixtures/inventory_atomic.pr8-8f56193.sql',import.meta.url),'utf8');
const cfg={id:'app_config',organizationName:'QA',storehouseEntities:[{id:'qa-a',name:'QA-A',active:true}],storehouses:['QA-A'],storehouseIds:['qa-a'],units:['قطعة'],categories:[{name:'QA',prefix:'QA',startRange:1000,endRange:2999}],transactionCounters:{inbound:0,outbound:0,consumed:0,opening:0,transfer:0,adjustment:0}};
const mat={id:'m1',code:'QA-1001',name:'QA item',category:'QA',unit:'قطعة',minimumStock:0,initialStock:0,primaryStorehouseId:'qa-a',storageLocation:'QA-A'};
const tr=(id,n,q,more={})=>({id,itemId:'m1',itemCode:'QA-1001',date:'2026-11-09',transactionNumber:n,transactionType:'وارد',storehouseId:'qa-a',quantity:q,...more});
const set=(collection,docId,value,old=null)=>({collection,docId,kind:'set',value:{...value,id:docId},expected:old?{kind:'present',data:old}:{kind:'missing'}});
const del=(collection,docId,old)=>({collection,docId,kind:'delete',expected:{kind:'present',data:old}});
const original=tr('t-orig','W-0001',19);
const link={id:'t-orig',transactionNumber:'W-0001',transactionType:'وارد',quantity:19,date:'2026-11-09',itemId:'m1',itemCode:'QA-1001',storehouseId:'qa-a',reason:'QA wrong quantity'};
const replacement=tr('t-repl','W-0002',18,{correctionOf:link});
const correctionOps=(rep=replacement)=>[del('transactions','t-orig',original),set('transactions',rep.id,rep)];
let db;
// Synthetic single 'QA' category (pre-R8 suite): the R8 five-category pin is lifted in this isolated database only.
const unpin=async()=>{if((await db.query("select to_regclass('inventory_private.category_policy') r")).rows[0].r)await db.exec('DELETE FROM inventory_private.category_policy;');};
const boot=async sql=>{if(db)await db.close();db=await createIsolatedDatabase();await db.exec('CREATE TABLE auth.users(id uuid primary key,email text);');for(const [name,id]of Object.entries(ids))await db.query('insert into auth.users values($1,$2)',[id,name+'@qa.invalid']);await db.exec(sql);await unpin();await seedAccounts(db);await db.query('insert into settings(id,data) values($1,$2)',['app_config',JSON.stringify(cfg)]);await db.query('insert into materials(id,data) values($1,$2)',['m1',JSON.stringify(mat)]);await commit({mode:'mutation',label:'seed',operations:[set('transactions','t-orig',original)]},'qa-seed-original');};
const commit=async(p,id)=>(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_commit($1,$2) ack',[id,JSON.stringify(p)]))).rows[0].ack;
const rejects=async(fn,codes)=>{let e;try{await fn();}catch(x){e=x;}assert.ok(e,'Expected rejection');if(codes)assert.ok(codes.includes(e.code),e.code+':'+e.message);return e;};
const ids_=async t=>(await db.query(`select id from ${t} order by id`)).rows.map(r=>r.id);
const audit=async id=>(await db.query('select data from audit_logs where id=$1',[id])).rows[0]?.data;
const assertUntouched=async()=>{assert.deepEqual(await ids_('transactions'),['t-orig']);assert.deepEqual(await ids_('audit_logs'),['qa-seed-original']);};
const assertCompleteReceipt=a=>{assert.equal(a.action,'تصحيح حركة مخزنية (إلغاء وبديل)');
  assert.equal(a.removedTransactions?.length,1);assert.equal(a.removedTransactions[0].id,'t-orig');assert.equal(a.removedTransactions[0].transactionNumber,'W-0001');assert.equal(Number(a.removedTransactions[0].quantity),19);
  assert.equal(a.corrections?.length,1);assert.deepEqual({o:a.corrections[0].originalNumber,oq:Number(a.corrections[0].originalQuantity),r:a.corrections[0].replacementNumber,rq:Number(a.corrections[0].replacementQuantity)},{o:'W-0001',oq:19,r:'W-0002',rq:18});};
const results=[];async function test(name,sql,fn){try{await boot(sql);await fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:e.message});}}
const correction=(ops=correctionOps())=>({mode:'correction',label:'correct-transaction',operations:ops});

await test('TX03-C1 candidate: correction commits once with complete audit (removedTransactions + corrections)',CANDIDATE,async()=>{
  const a=await commit(correction(),'qa-corr-0001');assertCompleteReceipt(a.audit);assert.deepEqual(await ids_('transactions'),['t-repl']);assertCompleteReceipt(await audit('qa-corr-0001'));
  const again=await commit(correction(),'qa-corr-0001');assert.equal(again.replayed,true);assert.deepEqual(await ids_('transactions'),['t-repl']);assert.equal((await ids_('audit_logs')).length,2);});
await test('TX03-C2 candidate: correctionOf sent in plain mutation mode is rejected atomically',CANDIDATE,async()=>{
  await rejects(()=>commit({mode:'mutation',label:'x',operations:correctionOps()},'qa-corr-0002'),['22023']);await assertUntouched();});
await test('TX03-C3 candidate: correction mode without a linked replacement is rejected',CANDIDATE,async()=>{
  await rejects(()=>commit(correction([del('transactions','t-orig',original),set('transactions','t-repl',tr('t-repl','W-0002',18))]),'qa-corr-0003'),['23514']);await assertUntouched();});
await test('TX03-C4 candidate: link that does not match the cancelled original is rejected',CANDIDATE,async()=>{
  await rejects(()=>commit(correction(correctionOps({...replacement,correctionOf:{...link,quantity:7}})),'qa-corr-0004'),['23514']);await assertUntouched();});
await test('TX03-C5 candidate: editing a non-ledger field of an existing replacement still works in mutation mode',CANDIDATE,async()=>{
  await commit(correction(),'qa-corr-0005');const row={...replacement};await commit({mode:'mutation',label:'notes',operations:[set('transactions','t-repl',{...row,notes:'n'},{...row})]},'qa-corr-0005b');
  assert.equal((await db.query("select data->>'notes' n from transactions where id='t-repl'")).rows[0].n,'n');});
await test('TX03-C6 candidate: restore of a backup that contains a correction row is not blocked by the link check',CANDIDATE,async()=>{
  await commit(correction(),'qa-corr-0006');const users=(await db.query('select data from users order by id')).rows.map(x=>x.data);
  const b={settings:cfg,materials:[mat],transactions:[replacement],generatorLogs:[],users,codeRegistry:[{code:'QA-1001',materialId:'m1',deleted:false}]};
  const pre=(await asUser(db,ids.admin,tx=>tx.query('select public.inventory_restore_preview($1) p',[JSON.stringify(b)]))).rows[0].p;
  await commit({mode:'restore',label:'QA restore',backup:b,expectedState:pre.expectedState},'qa-corr-0006r');assert.deepEqual(await ids_('transactions'),['t-repl']);});
await test('TX03-R1 #8 SQL (rollback target): queued correction is rejected atomically, no partial commit, no audit row',PR8,async()=>{
  const e=await rejects(()=>commit(correction(),'qa-corr-0101'),['22023']);assert.match(e.message,/INVENTORY_OPERATIONS_INVALID/);await assertUntouched();});
await test('TX03-R2 #8 -> candidate upgrade: the SAME queued correction then commits once with complete audit',PR8,async()=>{
  await rejects(()=>commit(correction(),'qa-corr-0102'),['22023']);await db.exec(CANDIDATE);await unpin();
  const a=await commit(correction(),'qa-corr-0102');assert.equal(a.replayed,false);assertCompleteReceipt(a.audit);assert.deepEqual(await ids_('transactions'),['t-repl']);
  assert.equal((await commit(correction(),'qa-corr-0102')).replayed,true);assert.equal((await ids_('audit_logs')).length,2);});
await test('TX03-R3 candidate -> #8 rollback: later queued correction is rejected; earlier committed correction stays intact',CANDIDATE,async()=>{
  await commit(correction(),'qa-corr-0103');await db.exec(PR8);await unpin();
  const second=tr('t-repl2','W-0003',17,{correctionOf:{...link,id:'t-repl',transactionNumber:'W-0002',quantity:18}});
  await rejects(()=>commit(correction([del('transactions','t-repl',replacement),set('transactions','t-repl2',second)]),'qa-corr-0103b'),['22023']);
  assert.deepEqual(await ids_('transactions'),['t-repl']);assertCompleteReceipt(await audit('qa-corr-0103'));});
const report={suite:'TX-03 correction audit completeness / #8 compatibility (PGlite, isolated)',total:results.length,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,results};
fs.writeFileSync(process.env.QA_TX03_OUTPUT||'/tmp/inventory-tx03-correction.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,1));await db.close();if(report.failed)process.exitCode=1;
