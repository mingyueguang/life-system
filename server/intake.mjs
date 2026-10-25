import {z} from 'zod';
import {randomUUID,createHash} from 'node:crypto';
import {db,transaction} from './database.mjs';
import {HttpError} from './auth.mjs';
import {enqueue,canon} from './life.mjs';
import {saveRecord} from './records.mjs';
import {invalidateDomainPlans} from './domain-plans.mjs';
const fail=(s,m)=>{throw new HttpError(s,m)};
const hash=x=>createHash('sha256').update(canon(x)).digest('hex');
export const domains={
 work:{label:'日常工作',purpose:'了解重要成果、当前工作和现实限制，不在资料收集阶段生成日计划。',kinds:['profile','goal','task','account','debt','repayment']},
 fitness:{label:'健身',purpose:'先了解训练目标、现状和限制，不诊断疾病，不生成训练处方，不凭空设定体能或阈值。',kinds:['profile','exercise','sleep']},
 diet:{label:'饮食',purpose:'先了解饮食目标、习惯和限制，不推算未知热量，不要求精确称重，不生成饮食处方。',kinds:['profile','intake','sleep','exercise']}
};
const definitions=[
 ['shared.time','时间与固定安排','大致有哪些固定安排、可用于工作和训练的时间？不需要精确到分钟。',['work','fitness','diet'],true],
 ['shared.sleep','睡眠与恢复','最近睡眠和恢复情况怎样？已有记录无需重复填写。',['work','fitness','diet'],false],
 ['work.goal','工作目标','近期最希望推进的成果是什么？长期方向若已有记录，优先沿用。',['work'],true],
 ['work.current','工作现状与阻碍','目前在推进哪些重要工作，主要卡在哪里？',['work'],true],
 ['work.cashflow','现金流约束','是否有必须优先保障的收入或还款要求？可以先说明大致约束，也可以稍后补。',['work'],false],
 ['fitness.goal','训练目标','你最希望通过训练改善什么？',['fitness'],true],
 ['fitness.baseline','训练现状','目前有什么训练习惯或经验？已有运动数据可以直接作为参考。',['fitness'],true],
 ['fitness.constraints','运动限制','是否有影响运动安排的伤痛或医生已经提出的限制？没有可以说明没有，也可以暂不提供。',['fitness'],true],
 ['fitness.conditions','训练条件','可以使用哪些场地和设备，有哪些偏好？',['fitness'],false],
 ['diet.goal','饮食目标','你希望饮食安排主要帮助解决什么问题？',['diet'],true],
 ['diet.routine','饮食习惯与条件','平时主要自己做饭、食堂还是外卖？有什么固定习惯和现实限制？',['diet'],true],
 ['diet.constraints','饮食限制','有什么食物过敏、忌口或已明确的饮食限制？没有可以说明没有，也可以暂不提供。',['diet'],true],
 ['diet.budget','饮食预算与偏好','饮食预算和口味有什么偏好？不需要精确记账。',['diet'],false]
].map(([key,label,question,domains,required])=>({key,label,question,domains,required}));
export {definitions};
export const intakeOutputSchema=z.object({summary:z.string().min(1).max(3000),evidence:z.array(z.object({field_key:z.string(),record_id:z.string().uuid(),record_version:z.number().int().min(1),value:z.string().min(1).max(10000),reason:z.string().min(1).max(1000)}).strict()).max(20),questions:z.array(z.object({field_key:z.string(),question:z.string().min(1).max(1000),reason:z.string().min(1).max(1000)}).strict()).max(3)}).strict();
function domainCheck(domain){if(!Object.hasOwn(domains,domain))fail(400,'未知专业角色');}
function fieldState(d,user,def){
 const link=d.prepare('SELECT * FROM intake_fields WHERE user_id=? AND field_key=?').get(user,def.key);
 const row=link?.record_id?d.prepare('SELECT * FROM records WHERE id=? AND user_id=?').get(link.record_id,user):null;
 const record=row?{id:row.id,version:row.version,deleted:!!row.deleted,kind:row.kind,data:JSON.parse(row.payload),updated_at:row.updated_at}:null;
 const evidence=JSON.parse(link?.evidence||'[]');
 const sourceChanged=evidence.some(e=>{const r=d.prepare('SELECT version,deleted FROM records WHERE id=? AND user_id=?').get(e.id,user);return !r||r.deleted||r.version!==e.version});
 const status=link?.deferred?'deferred':record&&!record.deleted&&record.kind==='profile'&&record.version===link.record_version&&record.data.status==='known'&&!sourceChanged?'known':record?'needs_review':'missing';
 return {...def,status,record,evidence,token:hash({link:link||null,record}),revision:link?.revision||0};
}
export function intakeSnapshot(d,user,domain){
 domainCheck(domain);const fields=definitions.filter(x=>x.domains.includes(domain)).map(x=>fieldState(d,user,x));
 const kinds=domains[domain].kinds;
 const records=d.prepare(`SELECT id,kind,payload,version,updated_at FROM records WHERE user_id=? AND deleted=0 AND kind IN (${kinds.map(()=>'?').join(',')}) ORDER BY id`).all(user,...kinds).map(r=>({id:r.id,kind:r.kind,data:JSON.parse(r.payload),version:r.version,updated_at:r.updated_at}));
 const context_hash=hash({fields,records});return {domain,role:domains[domain],fields,records,context_hash};
}
export function intakeOverview(user,domain,d=db()){
 const ctx=intakeSnapshot(d,user,domain);const reportRow=d.prepare('SELECT * FROM intake_reports WHERE user_id=? AND domain=?').get(user,domain);
 // Old proposals remain visible as history but must not be accepted against changed context.
 const report=reportRow?{...JSON.parse(reportRow.body),job_id:reportRow.job_id,current:reportRow.context_hash===ctx.context_hash,updated:reportRow.updated}:null;
 if(report)report.evidence=report.evidence.map(e=>({...e,current:ctx.fields.some(f=>f.key===e.field_key&&!['known','deferred'].includes(f.status))&&ctx.records.some(r=>r.id===e.record_id&&r.version===e.record_version)}));
 const outstanding=ctx.fields.filter(x=>x.required&&x.status!=='known');
 const jobs=d.prepare("SELECT id,status,request FROM agent_jobs WHERE user_id=? AND status IN ('queued','running') ORDER BY created DESC").all(user).filter(x=>JSON.parse(x.request).action==='intake.'+domain).map(x=>({id:x.id,status:x.status}));
 return {...ctx,report,jobs,state:jobs.length?'analyzing':!outstanding.length?'basics_collected':ctx.fields.some(x=>x.status==='known')||report?'collecting':'not_started',note:'初步资料已收集不代表可以直接制定专业方案；后续仍需专业判断与用户核对。'};
}
function queue(d,user,domain,now){
 const ctx=intakeSnapshot(d,user,domain),prefix=`intake:${domain}:${ctx.context_hash}`;
 const previous=d.prepare('SELECT id,status FROM agent_jobs WHERE user_id=? AND idem LIKE ? ORDER BY created DESC').all(user,prefix+'%');
 const reusable=previous.find(x=>['queued','running','succeeded'].includes(x.status));if(reusable)return {job_id:reusable.id,status:reusable.status};
 const active=ctx.fields.filter(x=>!['known','deferred'].includes(x.status));if(!active.length)return {job_id:null,status:'no_questions'};
 const job_id=enqueue(d,user,{idem:prefix+':'+previous.length,action:'intake.'+domain,payload:{context:ctx,instruction:'这是资料收集，不是制定计划。先读取全部已有资料，充分覆盖字段时提出 evidence 供用户核对，不直接改成事实。只向用户询问影响下一步的缺失信息，一轮最多3问；不重复询问 known 或 deferred 字段。提问必须说明用途；冲突内容列为待核实。对尚不足以推断的事情保持未知，不根据职业、体型等猜测。不得生成工作、训练或饮食方案。'}},now);
 return {job_id,status:'queued'};
}
export function startIntake(user,b,now=Date.now()){
 const v=z.object({domain:z.enum(['work','fitness','diet']),context_hash:z.string().length(64)}).strict().parse(b);
 return transaction(d=>{if(intakeSnapshot(d,user,v.domain).context_hash!==v.context_hash)fail(409,'资料已变化，请刷新后继续');return queue(d,user,v.domain,now)});
}
export function validateIntake(d,user,job,raw){
 const request=JSON.parse(job.request),domain=request.action.slice(7),ctx=request.payload.context;
 const output=intakeOutputSchema.parse(raw);const current=intakeSnapshot(d,user,domain);
 if(ctx.context_hash!==current.context_hash)fail(409,'资料已更新，本次沟通建议过期，请重新读取后继续');
 const allowed=current.fields.filter(x=>!['known','deferred'].includes(x.status)).map(x=>x.key);
 if(output.questions.some(x=>!allowed.includes(x.field_key))||output.evidence.some(x=>!allowed.includes(x.field_key)))fail(400,'不能重复询问已知或暂缓的资料');
 if(current.fields.some(x=>x.required&&allowed.includes(x.key))&&!output.questions.length&&!output.evidence.length)fail(400,'仍有关键资料缺失，请提出问题或提供可核对的已有资料');
 if(output.questions.some(q=>output.evidence.some(e=>e.field_key===q.field_key)))fail(400,'已有资料整理与追问不能重复同一字段');
 if(new Set(output.questions.map(x=>x.field_key)).size!==output.questions.length)fail(400,'问题不能重复');
 for(const evidence of output.evidence){const r=current.records.find(x=>x.id===evidence.record_id&&x.version===evidence.record_version);if(!r)fail(409,'引用资料不存在或版本已变化');}
 return output;
}
export function storeIntake(d,user,job,output,now){
 const request=JSON.parse(job.request);d.prepare('INSERT INTO intake_reports VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,domain) DO UPDATE SET job_id=excluded.job_id,context_hash=excluded.context_hash,body=excluded.body,updated=excluded.updated').run(user,request.action.slice(7),job.id,request.payload.context.context_hash,JSON.stringify(output),now);
}
function applyOne(d,user,actor,v,now){
 const def=definitions.find(x=>x.key===v.field_key&&x.domains.includes(v.domain));if(!def)fail(400,'字段不属于当前角色');const field=fieldState(d,user,def);
 if(field.token!==v.token)fail(409,'该项资料已被其他客户端修改，请刷新后核对');
 let answer=v.answer,source={method:'user_report',original_text:answer||''},related_ids=[],evidence=field.evidence;
 if(v.operation==='accept_evidence'){
  const view=intakeOverview(user,v.domain,d),report=view.report;
  if(!report||report.job_id!==v.report_job_id)fail(409,'该条整理建议已过期，请重新核对');
  const item=report.evidence[v.evidence_index];if(!item||!item.current||item.field_key!==def.key)fail(400,'整理建议不匹配');
  answer=item.value;source={method:'user_report',original_text:'用户确认已有资料整理：'+item.value};related_ids=[item.record_id];evidence=[{id:item.record_id,version:item.record_version}];
 }
 let record_id=field.record?.id||null,record_version=field.record?.version||null;
 if(['answer','accept_evidence'].includes(v.operation)){
  if(!answer)fail(400,'请提供真实回答，不要代用户补造资料');
  if(v.operation==='answer')evidence=[];
  // A linked record reclassified elsewhere is preserved; create a new profile instead.
  const reusable=field.record?.kind==='profile'&&!field.record.deleted;
  const record=saveRecord(user,actor,{id:reusable?field.record.id:randomUUID(),kind:'profile',version:reusable?field.record.version:0,data:{topic:def.label,statement:answer,status:'known',note:'资料收集字段：'+def.key},metadata:{source,certainty:'reported',related_ids}},d).record;
  record_id=record.id;record_version=record.version;
 }
 d.prepare('INSERT INTO intake_fields VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,field_key) DO UPDATE SET record_id=excluded.record_id,record_version=excluded.record_version,deferred=excluded.deferred,revision=excluded.revision,evidence=excluded.evidence').run(user,def.key,record_id,record_version,v.operation==='defer'?1:0,field.revision+1,JSON.stringify(evidence));
 // 阶段 3：关键资料变化 → 受影响领域的已确认方案标记需复核（不删除、不整套重算）。
 invalidateDomainPlans(d,user,def.domains,new Date(now).toISOString());
 // Invalidate old inference tasks immediately, allowing another executor to take over safely.
 const affected=def.domains;
 for(const j of d.prepare("SELECT id,request FROM agent_jobs WHERE user_id=? AND status IN ('queued','running')").all(user))if(affected.some(x=>JSON.parse(j.request).action==='intake.'+x))d.prepare("UPDATE agent_jobs SET status='cancelled',updated=? WHERE id=?").run(now,j.id);
}
export function updateIntake(user,actor,b,now=Date.now()){
 const base=z.object({request_id:z.string().uuid(),domain:z.enum(['work','fitness','diet'])}).strict();
 const single=base.extend({field_key:z.string(),token:z.string().length(64),operation:z.enum(['answer','defer','resume','accept_evidence']),answer:z.string().trim().min(1).max(10000).optional(),report_job_id:z.string().uuid().optional(),evidence_index:z.number().int().min(0).optional()}).strict();
 const many=base.extend({operation:z.literal('answer_many'),answers:z.array(z.object({field_key:z.string(),token:z.string().length(64),answer:z.string().trim().min(1).max(10000)}).strict()).min(1).max(20)}).strict();
 const v=z.union([single,many]).parse(b);
 return transaction(d=>{
  const digest=hash(v),old=d.prepare('SELECT * FROM intake_requests WHERE user_id=? AND request_id=?').get(user,v.request_id);if(old){if(old.hash!==digest)fail(409,'请求编号已用于其他内容');return {...JSON.parse(old.response),duplicate:true}}
  if(v.operation==='answer_many'){
   for(const a of v.answers)applyOne(d,user,actor,{...a,domain:v.domain,operation:'answer'},now);
  }else{
   applyOne(d,user,actor,v,now);
  }
  const result=v.operation==='answer_many'?{ok:true,fields:v.answers.map(a=>fieldState(d,user,definitions.find(x=>x.key===a.field_key)))}:{ok:true,field:fieldState(d,user,definitions.find(x=>x.key===v.field_key))};
  const saved={...result,duplicate:false};d.prepare('INSERT INTO intake_requests VALUES(?,?,?,?)').run(user,v.request_id,digest,JSON.stringify(saved));return saved;
 });
}
