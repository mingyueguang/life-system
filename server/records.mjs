import {createHash} from 'node:crypto';
import {z} from 'zod';
import {schemas} from '../lib/record-schema.mjs';
import {db,transaction} from './database.mjs';
import {HttpError} from './auth.mjs';
const fail=(s,m)=>{throw new HttpError(s,m)};
const iso=z.string().datetime({offset:true});
export const sourceSchema=z.object({method:z.enum(['user_report','device','import','ai_inference','unknown']),original_text:z.string().max(20000).default(''),reference:z.string().max(1000).default('')}).strict();
export const metadataSchema=z.object({occurred_at:iso.nullable().default(null),source:sourceSchema.default({method:'unknown'}),certainty:z.enum(['reported','estimated','inferred','needs_review','unknown']).default('unknown'),field_status:z.record(z.enum(['reported','estimated','inferred','needs_review','unknown'])).default({}),related_ids:z.array(z.string().uuid()).max(100).default([])}).strict();
const inputSchema=z.object({request_id:z.string().uuid().optional(),id:z.string().uuid(),kind:z.string(),version:z.number().int().min(0),data:z.unknown(),deleted:z.boolean().default(false),metadata:metadataSchema.optional(),reclassify:z.boolean().default(false)}).strict();
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
function metadata(d,user,id){return JSON.parse(d.prepare('SELECT body FROM record_metadata WHERE record_id=? AND user_id=?').get(id,user)?.body||JSON.stringify(metadataSchema.parse({})))}
function unpack(d,r){return {id:r.id,kind:r.kind,data:JSON.parse(r.payload),version:r.version,updatedAt:r.updated_at,deleted:!!r.deleted,metadata:metadata(d,r.user_id,r.id)}}
export function saveRecord(user,actor,raw){
 const b=inputSchema.parse(raw);if(!Object.hasOwn(schemas,b.kind))fail(400,'未知类型，请先保存为 unclassified 并保留原文');
 const data=schemas[b.kind].parse(b.data),hash=createHash('sha256').update(canonical(b)).digest('hex');
 return transaction(d=>{
  if(b.request_id){const previous=d.prepare('SELECT hash,response FROM record_requests WHERE user_id=? AND request_id=?').get(user,b.request_id);if(previous){if(previous.hash!==hash)fail(409,'request_id 已用于不同内容，请使用新的请求编号');return {...JSON.parse(previous.response),duplicate:true}}}
  const current=d.prepare('SELECT * FROM records WHERE id=?').get(b.id);
  if(current&&(current.user_id!==user||current.version!==b.version)||!current&&b.version!==0)fail(409,'记录版本冲突，请重新读取后再修改');
  if(current&&current.kind!==b.kind&&!b.reclassify)fail(409,'修改分类需要 reclassify=true，并提交新分类的完整数据');
  const meta=b.metadata||(current?metadata(d,user,b.id):metadataSchema.parse({}));
  if(Object.keys(meta.field_status).some(k=>!Object.hasOwn(data,k)))fail(400,'field_status 只能引用 data 中的字段');
  const references=[...meta.related_ids,...(b.kind==='transaction'&&data.account_id?[data.account_id]:[])];
  for(const id of references){if(id===b.id||!d.prepare('SELECT 1 FROM records WHERE id=? AND user_id=? AND deleted=0').get(id,user))fail(400,'关联记录不存在、已归档或引用自身')}
  if(b.kind==='transaction'&&data.account_id&&d.prepare('SELECT kind FROM records WHERE id=? AND user_id=?').get(data.account_id,user)?.kind!=='account')fail(400,'account_id 必须指向现金账户');
  const at=new Date().toISOString();
  if(current)d.prepare('INSERT OR IGNORE INTO record_history VALUES(?,?,?,?,?,?)').run(b.id,user,current.version,JSON.stringify(unpack(d,current)),'legacy_snapshot',current.updated_at);
  if(current)d.prepare('UPDATE records SET kind=?,payload=?,version=version+1,updated_at=?,deleted=? WHERE id=? AND user_id=?').run(b.kind,JSON.stringify(data),at,b.deleted?1:0,b.id,user);
  else d.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(b.id,user,b.kind,JSON.stringify(data),1,at,b.deleted?1:0);
  d.prepare('INSERT INTO record_metadata VALUES(?,?,?) ON CONFLICT(record_id) DO UPDATE SET body=excluded.body').run(b.id,user,JSON.stringify(meta));
  const record=unpack(d,d.prepare('SELECT * FROM records WHERE id=?').get(b.id));
  d.prepare('INSERT INTO record_history VALUES(?,?,?,?,?,?)').run(b.id,user,record.version,JSON.stringify(record),actor,at);
  const result={record,duplicate:false};if(b.request_id)d.prepare('INSERT INTO record_requests VALUES(?,?,?,?)').run(user,b.request_id,hash,JSON.stringify(result));return result;
 });
}
export function readRecords(user,search){
 const d=db(),id=search.get('id'),history=search.get('history');
 if(id){z.string().uuid().parse(id);const row=d.prepare('SELECT * FROM records WHERE id=? AND user_id=?').get(id,user);if(!row)fail(404,'记录不存在');if(history==='true'){const before=Number(search.get('before_version')||Number.MAX_SAFE_INTEGER);if(!Number.isSafeInteger(before)||before<1)fail(400,'before_version 无效');const rows=d.prepare('SELECT snapshot,actor,changed_at FROM record_history WHERE record_id=? AND user_id=? AND version<? ORDER BY version DESC LIMIT 101').all(id,user,before);const entries=rows.slice(0,100).map(r=>({record:JSON.parse(r.snapshot),actor:r.actor,changed_at:r.changed_at}));if(!rows.length&&row.version<before)entries.push({record:unpack(d,row),actor:'legacy_snapshot',changed_at:row.updated_at});return {history:entries,nextBeforeVersion:rows.length>100?entries.at(-1).record.version:null}}return {record:unpack(d,row)}}
 const kind=search.get('kind'),since=search.get('since'),cursor=search.get('cursor')||'',from=search.get('from'),to=search.get('to'),status=search.get('status');
 if(kind&&!Object.hasOwn(schemas,kind))fail(400,'未知类型');if(since)iso.parse(since);
 for(const v of [from,to])if(v&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||isNaN(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v))fail(400,'时间范围使用 YYYY-MM-DD');if(from&&to&&from>to)fail(400,'开始日期不能晚于结束日期');
 if(status&&!['known','missing','needs_review'].includes(status))fail(400,'未知资料状态');
 const cond=['r.user_id=?','r.id>?'],args=[user,cursor];
 if(!since)cond.push('r.deleted=0');else{cond.push('r.updated_at>=?');args.push(new Date(since).toISOString())}
 if(kind){cond.push('r.kind=?');args.push(kind)}
 // Occurrence filters never substitute write time for an unknown event date.
 const eventDate="COALESCE(NULLIF(json_extract(r.payload,'$.date'),''),substr(json_extract(m.body,'$.occurred_at'),1,10))";
 if(from){cond.push(eventDate+'>=?');args.push(from)}if(to){cond.push(eventDate+'<=?');args.push(to)}
 if(status){cond.push("r.kind='profile' AND json_extract(r.payload,'$.status')=?");args.push(status)}
 const rows=d.prepare(`SELECT r.* FROM records r LEFT JOIN record_metadata m ON m.record_id=r.id WHERE ${cond.join(' AND ')} ORDER BY r.id LIMIT 501`).all(...args);
 return {records:rows.slice(0,500).map(r=>unpack(d,r)),nextCursor:rows.length>500?rows[499].id:null};
}
