import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {schemas} from '../lib/record-schema.mjs';
import {db,transaction} from './database.mjs';
import {HttpError} from './auth.mjs';
const fail=(s,m)=>{throw new HttpError(s,m)};
const iso=z.string().datetime({offset:true});
export const sourceSchema=z.object({method:z.enum(['user_report','device','import','ai_inference','unknown']),original_text:z.string().max(20000).default(''),reference:z.string().max(1000).default('')}).strict();
export const reviewSchema=z.object({status:z.enum(['confirmed','rejected']),actor:z.string().max(80),at:z.string().datetime({offset:true})}).strict();
export const metadataSchema=z.object({occurred_at:iso.nullable().default(null),source:sourceSchema.default({method:'unknown'}),certainty:z.enum(['reported','estimated','inferred','needs_review','unknown']).default('unknown'),field_status:z.record(z.enum(['reported','estimated','inferred','needs_review','unknown'])).default({}),related_ids:z.array(z.string().uuid()).max(100).default([]),review:reviewSchema.nullable().default(null)}).strict();
const inputSchema=z.object({request_id:z.string().uuid().optional(),id:z.string().uuid(),kind:z.string(),version:z.number().int().min(0),data:z.unknown(),deleted:z.boolean().default(false),metadata:metadataSchema.optional(),reclassify:z.boolean().default(false),source_id:z.string().uuid().optional()}).strict();
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
function metadata(d,user,id){return JSON.parse(d.prepare('SELECT body FROM record_metadata WHERE record_id=? AND user_id=?').get(id,user)?.body||JSON.stringify(metadataSchema.parse({})))}
function unpack(d,r){return {id:r.id,kind:r.kind,data:JSON.parse(r.payload),version:r.version,updatedAt:r.updated_at,deleted:!!r.deleted,source_id:r.source_id||null,metadata:metadata(d,r.user_id,r.id)}}
function rawById(d,user,id){const r=d.prepare('SELECT * FROM raw_inputs WHERE id=? AND user_id=?').get(id,user);if(!r)fail(404,'原始资料不存在');return r}
export function rawView(r,count){return {id:r.id,method:r.method,original_text:r.original_text,reference:r.reference,occurred_at:r.occurred_at,attachments:JSON.parse(r.attachments),created_at:r.created_at,actor:r.actor,record_count:count}}
// A raw input is the shared source of truth for one piece of user material; multiple structured records can link to it.
export function createRawInput(user,actor,raw,database=null){
 const v=z.object({request_id:z.string().uuid().optional(),method:z.enum(['user_report','device','import','ai_inference','unknown']).default('user_report'),original_text:z.string().max(20000).default(''),reference:z.string().max(1000).default(''),occurred_at:iso.nullable().default(null),attachments:z.array(z.object({type:z.string().max(50).default('file'),name:z.string().max(200),url:z.string().max(2000)}).strict()).max(20).default([])}).strict().parse(raw);
 if(!v.original_text&&!v.reference&&!v.attachments.length)fail(400,'需要提供原文、引用地址或附件');
 const write=x=>{
  if(v.request_id){const old=x.prepare('SELECT * FROM raw_inputs WHERE user_id=? AND request_id=?').get(user,v.request_id);if(old){if(old.method!==v.method||old.original_text!==v.original_text||old.reference!==v.reference)fail(409,'请求编号已用于不同原始资料');return {source:rawView(old,countRecords(x,user,old.id)),duplicate:true}}}
  const id=randomUUID(),at=new Date().toISOString();
  x.prepare('INSERT INTO raw_inputs(id,user_id,request_id,method,original_text,reference,occurred_at,attachments,created_at,actor) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user,v.request_id||null,v.method,v.original_text,v.reference,v.occurred_at,JSON.stringify(v.attachments),at,actor);
  return {source:rawView(x.prepare('SELECT * FROM raw_inputs WHERE id=?').get(id),0),duplicate:false};
 };
 return database?write(database):transaction(write);
}
function countRecords(d,user,id){return d.prepare('SELECT COUNT(*) n FROM records WHERE user_id=? AND source_id=?').get(user,id).n}
export function listRawInputs(user,search=new URLSearchParams()){
 const d=db(),cursor=search.get('cursor')||'';
 if(cursor&&!z.string().uuid().safeParse(cursor).success)fail(400,'cursor 无效');
 const rows=d.prepare('SELECT * FROM raw_inputs WHERE user_id=? AND id>? ORDER BY id LIMIT 101').all(user,cursor);
 return {sources:rows.slice(0,100).map(r=>rawView(r,countRecords(d,user,r.id))),nextCursor:rows.length>100?rows[99].id:null};
}
export function getRawInput(user,id,d=db()){
 const r=rawById(d,user,id);
 const records=d.prepare('SELECT id,kind,version,updated_at FROM records WHERE user_id=? AND source_id=? ORDER BY id').all(user,id).map(x=>({id:x.id,kind:x.kind,version:x.version,updated_at:x.updated_at}));
 return {source:rawView(r,records.length),records};
}
function linkSource(d,user,actor,b,existing=null){
 if(b.source_id){
  const row=rawById(d,user,b.source_id);return {source_id:row.id};
 }
 const s=b.metadata?.source;
 if(s&&(s.original_text||s.reference)){
  // Auto-create a raw input as a fallback for single-record writes; to share one raw input across records, create it via POST /api/v1/sources first and pass source_id.
  const created=createRawInput(user,actor,{request_id:b.request_id,method:s.method,original_text:s.original_text,reference:s.reference},d);
  return {source_id:created.source.id};
 }
 return {source_id:existing};
}
export function saveRecord(user,actor,raw,database=null){
 const b=inputSchema.parse(raw);if(!Object.hasOwn(schemas,b.kind))fail(400,'未知类型，请先保存为 unclassified 并保留原文');
 const data=schemas[b.kind].parse(b.data),hash=createHash('sha256').update(canonical(b)).digest('hex');
 const write=d=>{
  if(b.request_id){const previous=d.prepare('SELECT hash,response FROM record_requests WHERE user_id=? AND request_id=?').get(user,b.request_id);if(previous){if(previous.hash!==hash)fail(409,'request_id 已用于不同内容，请使用新的请求编号');return {...JSON.parse(previous.response),duplicate:true}}}
  const current=d.prepare('SELECT * FROM records WHERE id=?').get(b.id);
  if(current&&(current.user_id!==user||current.version!==b.version)||!current&&b.version!==0)fail(409,'记录版本冲突，请重新读取后再修改');
  if(current&&current.kind!==b.kind&&!b.reclassify)fail(409,'修改分类需要 reclassify=true，并提交新分类的完整数据');
  const meta=b.metadata||(current?metadata(d,user,b.id):metadataSchema.parse({}));
  if(Object.keys(meta.field_status).some(k=>!Object.hasOwn(data,k)))fail(400,'field_status 只能引用 data 中的字段');
  const references=[...meta.related_ids,...(b.kind==='transaction'&&data.account_id?[data.account_id]:[])];
  for(const id of references){if(id===b.id||!d.prepare('SELECT 1 FROM records WHERE id=? AND user_id=? AND deleted=0').get(id,user))fail(400,'关联记录不存在、已归档或引用自身')}
  if(b.kind==='transaction'&&data.account_id&&d.prepare('SELECT kind FROM records WHERE id=? AND user_id=?').get(data.account_id,user)?.kind!=='account')fail(400,'account_id 必须指向现金账户');
  const linked=linkSource(d,user,actor,b,current?.source_id||null);
  const at=new Date().toISOString();
  if(current)d.prepare('INSERT OR IGNORE INTO record_history VALUES(?,?,?,?,?,?)').run(b.id,user,current.version,JSON.stringify(unpack(d,current)),'legacy_snapshot',current.updated_at);
  if(current)d.prepare('UPDATE records SET kind=?,payload=?,version=version+1,updated_at=?,deleted=?,source_id=? WHERE id=? AND user_id=?').run(b.kind,JSON.stringify(data),at,b.deleted?1:0,linked.source_id,b.id,user);
  else d.prepare('INSERT INTO records(id,user_id,kind,payload,version,updated_at,deleted,source_id) VALUES(?,?,?,?,?,?,?,?)').run(b.id,user,b.kind,JSON.stringify(data),1,at,b.deleted?1:0,linked.source_id);
  d.prepare('INSERT INTO record_metadata VALUES(?,?,?) ON CONFLICT(record_id) DO UPDATE SET body=excluded.body').run(b.id,user,JSON.stringify(meta));
  const record=unpack(d,d.prepare('SELECT * FROM records WHERE id=?').get(b.id));
  d.prepare('INSERT INTO record_history VALUES(?,?,?,?,?,?)').run(b.id,user,record.version,JSON.stringify(record),actor,at);
  const result={record,duplicate:false};if(b.request_id)d.prepare('INSERT INTO record_requests VALUES(?,?,?,?)').run(user,b.request_id,hash,JSON.stringify(result));return result;
 };return database?write(database):transaction(write);
}
// User-facing confirmation or rejection of AI-extracted information. Session-only at the route layer.
export function reviewRecord(user,actor,b){
 const v=z.object({id:z.string().uuid(),version:z.number().int().min(1),decision:z.enum(['confirm','reject'])}).strict().parse(b);
 return transaction(d=>{
  const r=d.prepare('SELECT * FROM records WHERE id=? AND user_id=?').get(v.id,user);if(!r)fail(404,'记录不存在');
  if(r.version!==v.version)fail(409,'记录版本冲突，请重新读取后再修改');
  const meta=metadata(d,user,v.id);meta.review={status:v.decision==='confirm'?'confirmed':'rejected',actor,at:new Date().toISOString()};
  d.prepare('INSERT INTO record_metadata VALUES(?,?,?) ON CONFLICT(record_id) DO UPDATE SET body=excluded.body').run(v.id,user,JSON.stringify(meta));
  const at=new Date().toISOString();d.prepare('UPDATE records SET updated_at=? WHERE id=? AND user_id=?').run(at,v.id,user);
  return {record:unpack(d,d.prepare('SELECT * FROM records WHERE id=?').get(v.id))};
 });
}
export function readRecords(user,search){
 const d=db(),id=search.get('id'),history=search.get('history');
 if(id){z.string().uuid().parse(id);const row=d.prepare('SELECT * FROM records WHERE id=? AND user_id=?').get(id,user);if(!row)fail(404,'记录不存在');if(history==='true'){const before=Number(search.get('before_version')||Number.MAX_SAFE_INTEGER);if(!Number.isSafeInteger(before)||before<1)fail(400,'before_version 无效');const rows=d.prepare('SELECT snapshot,actor,changed_at FROM record_history WHERE record_id=? AND user_id=? AND version<? ORDER BY version DESC LIMIT 101').all(id,user,before);const entries=rows.slice(0,100).map(r=>({record:JSON.parse(r.snapshot),actor:r.actor,changed_at:r.changed_at}));if(!rows.length&&row.version<before)entries.push({record:unpack(d,row),actor:'legacy_snapshot',changed_at:row.updated_at});return {history:entries,nextBeforeVersion:rows.length>100?entries.at(-1).record.version:null}}return {record:unpack(d,row)}}
 const kind=search.get('kind'),since=search.get('since'),cursor=search.get('cursor')||'',from=search.get('from'),to=search.get('to'),status=search.get('status'),source=search.get('source'),related=search.get('related');
 if(kind&&!Object.hasOwn(schemas,kind))fail(400,'未知类型');if(since)iso.parse(since);
 for(const v of [from,to])if(v&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||isNaN(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v))fail(400,'时间范围使用 YYYY-MM-DD');if(from&&to&&from>to)fail(400,'开始日期不能晚于结束日期');
 if(status&&!['known','missing','needs_review'].includes(status))fail(400,'未知资料状态');
 if(source)z.string().uuid().parse(source);if(related)z.string().uuid().parse(related);
 const cond=['r.user_id=?','r.id>?'],args=[user,cursor];
 if(!since)cond.push('r.deleted=0');else{cond.push('r.updated_at>=?');args.push(new Date(since).toISOString())}
 if(kind){cond.push('r.kind=?');args.push(kind)}
 if(source){cond.push('r.source_id=?');args.push(source)}
 if(related){cond.push("EXISTS(SELECT 1 FROM json_each(json_extract(m.body,'$.related_ids')) je WHERE je.value=?)");args.push(related)}
 // Occurrence filters never substitute write time for an unknown event date.
 const eventDate="COALESCE(NULLIF(json_extract(r.payload,'$.date'),''),substr(json_extract(m.body,'$.occurred_at'),1,10))";
 if(from){cond.push(eventDate+'>=?');args.push(from)}if(to){cond.push(eventDate+'<=?');args.push(to)}
 if(status){cond.push("r.kind='profile' AND json_extract(r.payload,'$.status')=?");args.push(status)}
 const rows=d.prepare(`SELECT r.* FROM records r LEFT JOIN record_metadata m ON m.record_id=r.id WHERE ${cond.join(' AND ')} ORDER BY r.id LIMIT 501`).all(...args);
 return {records:rows.slice(0,500).map(r=>unpack(d,r)),nextCursor:rows.length>500?rows[499].id:null};
}
