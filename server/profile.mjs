import {db} from './database.mjs';
import {domains,intakeSnapshot,definitions} from './intake.mjs';
import {protocolVersion} from './protocol.mjs';
const count=(fields,status)=>fields.filter(f=>f.status===status).length;
// Machine-readable continuation point for any AI: confirmed facts, pending reviews,
// missing required facts, deferred items, progress, recent changes and suggested questions.
export function profile(user,d=db()){
 const views={};
 for(const domain of Object.keys(domains)){
  const ctx=intakeSnapshot(d,user,domain);
  const fields=ctx.fields.map(f=>({key:f.key,label:f.label,question:f.question,required:f.required,status:f.status,token:f.token,record_id:f.record?.id||null,record_version:f.record?.version||null,updated_at:f.record?.updated_at||null}));
  views[domain]={label:domains[domain].label,fields,counts:{known:count(fields,'known'),missing:count(fields,'missing'),deferred:count(fields,'deferred'),needs_review:count(fields,'needs_review')}};
 }
 const byKey={};
 for(const domain of Object.keys(domains))for(const f of views[domain].fields)byKey[f.key]=f;
 const suggested=definitions.filter(x=>x.required).map(x=>byKey[x.key]).filter(Boolean).filter(f=>f.status==='missing').map(f=>({field_key:f.key,label:f.label,question:f.question}));
 const recent=d.prepare('SELECT r.id,r.kind,r.version,r.updated_at,r.deleted,r.source_id,m.body FROM records r LEFT JOIN record_metadata m ON m.record_id=r.id WHERE r.user_id=? ORDER BY r.updated_at DESC LIMIT 20').all(user).map(r=>({record_id:r.id,kind:r.kind,version:r.version,updated_at:r.updated_at,deleted:!!r.deleted,source_id:r.source_id||null,metadata:r.body?JSON.parse(r.body):null}));
 return {protocol_version:protocolVersion,profile_schema:'/api/v1/schema',updated_at:new Date().toISOString(),domains:views,fields:Object.values(byKey).map(f=>({key:f.key,label:f.label,question:f.question,required:f.required,status:f.status,token:f.token,record_id:f.record_id,record_version:f.record_version,updated_at:f.updated_at,domains:definitions.find(x=>x.key===f.key)?.domains||[]})),suggested_questions:suggested,recent_changes:recent,note:'共享档案接续：已确认资料不重复询问；AI 推断在用户确认前不是事实；缺失与未知保持为空，不补造。'};
}
