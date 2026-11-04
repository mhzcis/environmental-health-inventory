import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
const snapshot=JSON.parse(fs.readFileSync(new URL('./baseline-schema.json',import.meta.url),'utf8'));
export const tables=['users','settings','materials','transactions','generator_logs','audit_logs'];
export async function createIsolatedDatabase(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth; CREATE SCHEMA inventory_private;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub' $$;
 GRANT USAGE ON SCHEMA public,auth,inventory_private TO authenticated,anon; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;` .replace("SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'", "SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid"));
 for(const table of tables){
  const cols=snapshot.columns.filter(c=>c.table_name===table).map(c=>`"${c.column_name}" ${c.data_type}${c.column_default?' DEFAULT '+c.column_default:''}${c.is_nullable==='NO'?' NOT NULL':''}`);
  const constraints=snapshot.constraints.filter(c=>c.table===table).map(c=>`CONSTRAINT "${c.name}" ${c.definition}`);
  await db.exec(`CREATE TABLE public."${table}" (${[...cols,...constraints].join(',')}); ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY;`);
 }
 for(const f of snapshot.functions) await db.exec(f.definition);
 await db.exec('REVOKE ALL ON FUNCTION inventory_private.has_permission(text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION inventory_private.has_permission(text) TO authenticated;');
 for(const g of snapshot.grants) await db.exec(`GRANT ${g.privilege_type} ON public."${g.table_name}" TO "${g.grantee}";`);
 for(const p of snapshot.policies){
  await db.exec(`CREATE POLICY "${p.policyname}" ON public."${p.tablename}" AS ${p.permissive} FOR ${p.cmd} TO ${p.roles.map(r=>'"'+r+'"').join(',')} ${p.qual?'USING ('+p.qual+')':''} ${p.with_check?'WITH CHECK ('+p.with_check+')':''};`);
 }
 for(const idx of snapshot.indexes.filter(i=>!snapshot.constraints.some(c=>c.name===i.indexname))) await db.exec(idx.indexdef);
 return db;
}
export async function asUser(db,uid,fn){
 return db.transaction(async tx=>{
  await tx.exec('SET LOCAL ROLE authenticated');
  await tx.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:uid,role:'authenticated'})]);
  return await fn(tx);
 });
}
export const ids={admin:'11111111-1111-4111-8111-111111111111',employee:'22222222-2222-4222-8222-222222222222',reader:'33333333-3333-4333-8333-333333333333',disabled:'44444444-4444-4444-8444-444444444444',blank:'55555555-5555-4555-8555-555555555555'};
export const allPermissions=['dashboard_view','materials_view','materials_create','materials_edit','materials_delete','materials_stocktake','transactions_view','transactions_create','transactions_delete','reports_view','reports_export','reports_print','audit_view','generator_log','settings_view','settings_edit','users_manage','system_reset'];
export const employeePermissions=['materials_view','materials_create','materials_edit','materials_stocktake','transactions_view','transactions_create','reports_view','reports_export','reports_print'];
export async function seedAccounts(db){
 for(const [key,id] of Object.entries(ids)){
  const permissions=key==='admin'?allPermissions:key==='employee'?employeePermissions:key==='reader'?['materials_view','transactions_view','reports_view']:[];
  const user={id,authUid:id,username:key+'@qa.invalid',fullName:'QA '+key,role:key==='admin'?'مدير نظام':'أمين مستودع',permissions,active:key!=='disabled'};
  await db.query('INSERT INTO public.users(id,auth_uid,username,full_name,role,permissions,active,data) VALUES($1,$1,$2,$3,$4,$5,$6,$7)',[id,user.username,user.fullName,user.role,JSON.stringify(permissions),user.active,JSON.stringify(user)]);
 }
}
