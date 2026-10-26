import {validateIntake,storeIntake,intakeSnapshot} from './intake.mjs';
import {savePlan,planBasis,markAdjustmentsHandled} from './domain-plans.mjs';
import {contract} from './protocol.mjs';
import {randomUUID} from 'node:crypto';
import {db,transaction} from './database.mjs';
import {fail,canon,planSchema,analysisSchema,fitnessPlanSchema,dietPlanSchema,reviewSchema,publishSchema,records,fingerprint,settings} from './life.mjs';
const leaseMs=r=>JSON.parse(r.request).mode==='live'&&!r.effect?600000:120000;
const str=(v,max=200)=>typeof v==='string'&&v.length>0&&v.length<=max;
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const view=r=>({job_id:r.id,target_key_id:r.target_key_id,executor_id:r.claimed_key_id,...JSON.parse(r.request),status:r.status,dependencies:JSON.parse(r.dependencies),attempts:r.attempts,day:r.day,result:r.result?JSON.parse(r.result):null,created_at:r.created,updated_at:r.updated});
function audit(d,u,event,id,now){d.prepare('INSERT INTO agent_audit(user_id,event,job_id,created) VALUES(?,?,?,?)').run(u,event,id,now)}
function maintain(d,u,now){
 for(const r of d.prepare("SELECT * FROM agent_jobs WHERE user_id=? AND status IN ('queued','running')").all(u)){
  const request=JSON.parse(r.request);
  if(request.action.startsWith('intake.')&&intakeSnapshot(d,u,request.action.slice(7)).context_hash!==request.payload.context.context_hash)d.prepare("UPDATE agent_jobs SET status='cancelled',updated=? WHERE id=?").run(now,r.id);
 }

 for(const r of d.prepare("SELECT * FROM agent_jobs WHERE user_id=? AND status='running' AND effect=0 AND day IS NOT NULL").all(u)){
  const version=d.prepare('SELECT version FROM daily_days WHERE user_id=? AND day=?').get(u,r.day)?.version;
  if(version!==r.base_version)d.prepare("UPDATE agent_jobs SET status='cancelled',updated=? WHERE id=?").run(now,r.id);
 }

 for(const r of d.prepare("SELECT * FROM agent_jobs WHERE user_id=? AND status='running' AND expires<=?").all(u,now)){
  const safe=!r.effect&&JSON.parse(r.request).mode==='live'&&r.attempts<3;
  d.prepare('UPDATE agent_jobs SET status=?,lease=NULL,updated=? WHERE id=?').run(safe?'queued':'needs_review',now,r.id);audit(d,u,safe?'expired:retry':'expired:review',r.id,now);
 }
 for(const r of d.prepare("SELECT * FROM agent_jobs WHERE user_id=? AND status='queued'").all(u)){
  const deps=JSON.parse(r.dependencies).map(id=>d.prepare('SELECT status FROM agent_jobs WHERE id=? AND user_id=?').get(id,u));
  if(deps.some(x=>!x||['cancelled','failed','needs_review'].includes(x.status))){d.prepare("UPDATE agent_jobs SET status='failed',result=?,updated=? WHERE id=?").run(canon({status:'failed',output:{error:'前置任务未完成，请核对或重新生成'}}),now,r.id);continue}
  if(r.day&&!r.effect){const day=d.prepare('SELECT version FROM daily_days WHERE user_id=? AND day=?').get(u,r.day);if(!day||day.version!==r.base_version)d.prepare("UPDATE agent_jobs SET status='cancelled',updated=? WHERE id=?").run(now,r.id)}
 }
}
export function maintainJobs(now=Date.now()){return transaction(d=>{for(const u of d.prepare('SELECT id FROM users').all())maintain(d,u.id,now)})}
export function listJobs(user,now=Date.now()){return transaction(d=>{maintain(d,user,now);return {jobs:d.prepare('SELECT * FROM agent_jobs WHERE user_id=? ORDER BY created DESC,id LIMIT 100').all(user).map(view),mode:'collaboration',model_connected:false}})}
export function createJob(user,b,now=Date.now()){
 if(!obj(b)||!str(b.idempotency_key)||!str(b.target_key_id)||b.mode!=='simulation'||b.action!=='simulation.noop'||!obj(b.payload))fail(400,'手动测试仅支持 simulation.noop，并需指定执行密钥');
 const request=canon({mode:b.mode,action:b.action,payload:b.payload});return transaction(d=>{
  if(!d.prepare("SELECT 1 FROM api_keys WHERE id=? AND user_id=? AND scope IN ('worker','write') AND expires_at>?").get(b.target_key_id,user,now))fail(400,'请选择有效的 AI 读写密钥');
  const old=d.prepare('SELECT * FROM agent_jobs WHERE user_id=? AND idem=?').get(user,b.idempotency_key);if(old){if(old.request!==request||old.target_key_id!==b.target_key_id)fail(409,'操作编号已用于不同任务');return view(old)}
  const id=randomUUID();d.prepare('INSERT INTO agent_jobs(id,user_id,target_key_id,idem,request,status,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(id,user,b.target_key_id,b.idempotency_key,request,'queued',now,now);audit(d,user,'created',id,now);return view(d.prepare('SELECT * FROM agent_jobs WHERE id=?').get(id));});
}
export function claimJob(user,key,b,now=Date.now()){
 if(!obj(b)||(b.job_id!==undefined&&!str(b.job_id)))fail(400,'任务编号格式错误');
 return transaction(d=>{maintain(d,user,now);
 const k=d.prepare("SELECT * FROM api_keys WHERE id=? AND user_id=? AND scope IN ('write','worker') AND expires_at>?").get(key,user,now);if(!k)fail(401,'执行密钥失效');
 // Legacy clients can still claim their simulation; live jobs require explicit capability registration.
 const executor=d.prepare('SELECT * FROM executors WHERE key_id=? AND user_id=?').get(key,user);
 if(executor&&!executor.enabled)fail(403,'执行者已暂停');
 if(executor)d.prepare('UPDATE executors SET last_seen=? WHERE key_id=?').run(now,key);
 const running=d.prepare("SELECT COUNT(*) n FROM agent_jobs WHERE user_id=? AND claimed_key_id=? AND status='running'").get(user,key).n;
 if(running>=(executor?.max_parallel||1))return {job:null,reason:'capacity',recover_url:'/api/agent/v1/jobs/active',active_jobs:d.prepare("SELECT id,expires FROM agent_jobs WHERE claimed_key_id=? AND status='running'").all(key)};
 const caps=executor?JSON.parse(executor.capabilities):[];
 const rows=d.prepare("SELECT * FROM agent_jobs WHERE user_id=? AND (target_key_id=? OR target_key_id='*') AND status='queued' ORDER BY created,id").all(user,key);
 for(const r of rows){
  if(b.job_id&&b.job_id!==r.id)continue;
  const request=JSON.parse(r.request);if(request.mode==='live'&&!caps.includes(r.capability))continue;
  const deps=JSON.parse(r.dependencies).map(id=>d.prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=?').get(id,user));if(deps.some(x=>x?.status!=='succeeded'))continue;
  const lease=randomUUID(),expires=now+leaseMs(r);
  d.prepare("UPDATE agent_jobs SET status='running',claimed_key_id=?,lease=?,expires=?,attempts=attempts+1,updated=? WHERE id=?").run(key,lease,expires,now,r.id);audit(d,user,'claimed',r.id,now);
  const job={...view({...r,status:'running',claimed_key_id:key,attempts:r.attempts+1,updated:now}),lease_token:lease,lease_expires_at:expires,heartbeat_interval_seconds:30,contract:contract(request.action),dependency_results:deps.map(x=>({job_id:x.id,action:JSON.parse(x.request).action,result:JSON.parse(x.result)}))};
  return {job};
 }
 return {job:null,reason:executor?'no_eligible_task':'registration_required_for_live_jobs',next:executor?null:{method:'POST',path:'/api/agent/v1/executors/register',example:{name:'平台和账号标识',capabilities:['analysis'],max_parallel:1}},protocol_url:'/api/agent/v1/protocol'};
 });
}
// 阶段 2：关键资料未确认时，方案必须显式声明缺失，禁止输出确定性方案（可保留候选，但不得宣称完整）。
function requireMissing(req,domain,output){
 const intake=req.payload.context?.intake?.[domain];
 const missing=Array.isArray(intake?.required_missing)?intake.required_missing:[];
 if(missing.length&&!(Array.isArray(output.missing)&&output.missing.length))fail(400,'关键资料缺失（'+missing.join('、')+'）时必须列出 missing，不能输出确定性方案');
}
function validateOutput(d,user,r,output,status){
 const req=JSON.parse(r.request);
 if(req.action.startsWith('intake.')){validateIntake(d,user,r,output);return}
 if(req.action==='simulation.noop'){if(output.simulated!==true||output.external_effect!==false)fail(400,'模拟结果必须声明 simulated=true、external_effect=false');return}
 if(req.action==='analysis.fitness'){fitnessPlanSchema.parse(output);requireMissing(req,'fitness',output)}
 else if(req.action==='analysis.diet'){dietPlanSchema.parse(output);requireMissing(req,'diet',output)}
 else if(req.action.startsWith('analysis.'))analysisSchema.parse(output);
 if(req.action==='daily.plan'){
  const p=planSchema.parse(output),available=req.payload.context.day.input.available_minutes;
  if(new Set(p.items.map(x=>x.id)).size!==p.items.length)fail(400,'计划事项 ID 重复');
  if(available!==null&&p.items.reduce((n,x)=>n+x.minutes,0)+p.buffer_minutes>available)fail(400,'计划超过当天可用时间');
  if(available===null&&!p.missing.length)fail(400,'可用时间未知，需要列入缺失信息');
  const tasks=req.payload.context.records.filter(x=>x.kind==='task');
  // 否定记录与已完成待办不能作为有效引用；source_id 必须指向被选中的前置方案事项。
  if(p.items.some(x=>x.task_id&&!tasks.some(t=>t.id===x.task_id&&!t.data.done&&t.metadata?.review?.status!=='rejected')))fail(400,'关联待办不存在、已经完成或已被否定');
  const depResults=JSON.parse(r.dependencies).map(id=>d.prepare('SELECT request,result FROM agent_jobs WHERE id=? AND user_id=?').get(id,user)).filter(Boolean).map(x=>({action:JSON.parse(x.request).action,result:JSON.parse(x.result)}));
  // source_id 必须命中本次前置分析项或已确认领域方案项（阶段 3 沿用）。
  const confirmedPlans=req.payload.confirmed_plans||{};
  const sourceOk=i=>{
   if(!i.source_id)return true;
   if(depResults.some(dr=>{const o=dr.result?.output||{};const list=dr.action==='analysis.fitness'?o.sessions:dr.action==='analysis.diet'?o.meals:dr.action.startsWith('analysis.')?o.items:null;return !!list&&list.some(x=>x.id===i.source_id);}))return true;
   const cp=confirmedPlans[i.domain];if(!cp)return false;
   const items=i.domain==='fitness'?cp.plan.sessions:i.domain==='diet'?cp.plan.meals:(cp.plan.items||[]);
   return Array.isArray(items)&&items.some(x=>x?.id===i.source_id);
  };
  if(p.items.some(i=>!sourceOk(i)))fail(400,'计划事项引用的专业方案项不存在');
  // 批次 A 第二步：关键资料缺失的领域事项只能作为候选（deferred），不得进入正式执行清单。
  const intake=req.payload.context.intake||{};
  const blocked=p.items.filter(i=>i.domain&&(intake[i.domain]?.required_missing||[]).length>0);
  if(blocked.length)fail(400,'领域「'+[...new Set(blocked.map(i=>i.domain))].join('、')+'」关键资料尚未确认（'+[...new Set(blocked.flatMap(i=>intake[i.domain].required_missing||[]))].join('、')+'），相关安排只能作为候选放入 deferred，不能进入正式执行清单');
  if(req.payload.context.records_version!==fingerprint(records(d,user)))fail(409,'业务数据已变化，请重新生成计划');
 }
 if(req.action==='daily.review')reviewSchema.parse(output);
 if(req.action.startsWith('feishu.publish')){
  const v=publishSchema.parse(output);
  const key=req.action==='feishu.publish.fitness'?'sessions':req.action==='feishu.publish.diet'?'meals':'items';
  const ids=(req.payload.plan[key]||[]).map(x=>x.id);
  if(!ids.length)ids.push('summary');
  if(status==='succeeded'&&(v.receipts.length!==ids.length||new Set(v.receipts.map(x=>x.item_id)).size!==ids.length||v.receipts.some(x=>!ids.includes(x.item_id))))fail(400,'成功回执必须覆盖每个事项，且不能重复');
  if(status==='needs_review'){
   if(!v.receipts.length&&!Array.isArray(v.publish_missing))fail(400,'部分成功需给出已有回执（receipts）或结果不明事项（publish_missing）');
   if(v.receipts.some(x=>!ids.includes(x.item_id)))fail(400,'回执事项不在本次发布范围内');
  }
 }
 if(r.day&&!r.effect){const day=d.prepare('SELECT * FROM daily_days WHERE user_id=? AND day=?').get(user,r.day);if(!day||day.version!==r.base_version)fail(409,'每日数据已变化，本次结果已过期，请重新生成');}
}
export function updateJob(user,key,id,action,b,now=Date.now()){
 if(!obj(b))fail(400,'需要 JSON 对象');transaction(d=>maintain(d,user,now));
 return transaction(d=>{const r=d.prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=? AND claimed_key_id=?').get(id,user,key);if(!r)fail(404,'任务不存在或不属于当前执行者');
 if(!str(b.lease_token)||b.lease_token!==r.lease)fail(409,'领取凭据已失效');
 if(action==='result'){
  if(!['succeeded','failed','needs_review'].includes(b.status)||!obj(b.output))fail(400,'执行结果格式错误');
  const status=r.effect&&b.status==='failed'?'needs_review':b.status;
  const result=canon({status,output:b.output});if(r.result===result)return {ok:true,duplicate:true};
  if(r.status!=='running'||r.expires<=now)fail(409,'任务已结束或领取超时，需核对后处理');
  if(b.status==='succeeded'){try{validateOutput(d,user,r,b.output,b.status)}catch(e){if(e?.name==='ZodError'){e.issues.forEach(i=>i.path.unshift('output'));e.example=contract(JSON.parse(r.request).action).success_example}throw e}}
  d.prepare('UPDATE agent_jobs SET status=?,result=?,updated=? WHERE id=?').run(status,canon({status,output:b.output}),now,id);audit(d,user,'result:'+status,id,now);
  const actionName=JSON.parse(r.request).action;
  // 批次 B（第五步）：发布回执持久化——成功或需核对（部分成功）都写入，外部执行者可查询
  // 已成功事项与结果不明事项，恢复时只补缺失，不整批重做。
  // 部分成功：output.receipts 中返回的项已取得外部 ID，记为 succeeded；
  //           其余事项（未返回回执 / output.publish_missing 标记的）记为 unknown，供核对后补发。
  if(actionName.startsWith('feishu.publish')&&r.day&&(Array.isArray(b.output?.receipts)||Array.isArray(b.output?.publish_missing))){
   const key=actionName==='feishu.publish.fitness'?'sessions':actionName==='feishu.publish.diet'?'meals':'items';
   const planIds=(JSON.parse(r.request).payload?.plan?.[key]||[]).map(x=>x.id);
   d.prepare('DELETE FROM publish_receipts WHERE user_id=? AND day=? AND action=?').run(user,r.day,actionName);
   for(const rec of b.output.receipts||[])d.prepare('INSERT OR REPLACE INTO publish_receipts(user_id,day,action,item_id,external_id,status,created) VALUES(?,?,?,?,?,?,?)').run(user,r.day,actionName,rec.item_id,rec.external_id||'','succeeded',now);
   const missing=Array.isArray(b.output.publish_missing)?b.output.publish_missing:(b.status!=='succeeded'?planIds.filter(id=>!(b.output.receipts||[]).some(x=>x.item_id===id)):[]);
   for(const id of missing)d.prepare('INSERT OR REPLACE INTO publish_receipts(user_id,day,action,item_id,external_id,status,created) VALUES(?,?,?,?,?,?,?)').run(user,r.day,actionName,id,'','unknown',now);
  }
  if(status==='succeeded'&&actionName.startsWith('intake.'))storeIntake(d,user,r,b.output,now);
  // 批次 A 第三步：方案落库记录依据指纹（basis_hash）与按域复核周期（domain_review_days，可配置）；
  // 分析成功即视为已处理该域待复核的调整请求（持久化标记 handled）。
  if(status==='succeeded'&&actionName.startsWith('analysis.')){
   const dom=actionName.slice('analysis.'.length),s=settings(user,d),reviewDays=(s.domain_review_days||{})[dom]||7;
   const created=savePlan(d,user,dom,{plan:b.output,source_job_id:r.id,basis_hash:planBasis(d,user),review_at:new Date(now+reviewDays*86400000).toISOString()},new Date(now).toISOString());
   markAdjustmentsHandled(d,user,dom,{by:'analysis:'+r.id,new_version:created.version,now:new Date(now).toISOString()});
  }
  if(status==='succeeded'&&['daily.plan','daily.review'].includes(actionName)){
   const col=actionName==='daily.plan'?'plan':'review';
   d.prepare(`UPDATE daily_days SET ${col}=?,version=version+1,updated=? WHERE user_id=? AND day=? AND version=?`).run(JSON.stringify(b.output),now,user,r.day,r.base_version);
  }
  // Domain plans are intermediate products: saved without bumping the day version,
  // so the coordinating daily.plan keeps its base_version valid.
  if(status==='succeeded'&&['analysis.fitness','analysis.diet'].includes(actionName)){
   const col=actionName==='analysis.fitness'?'fitness':'diet';
   const n=d.prepare(`UPDATE daily_days SET ${col}=?,updated=? WHERE user_id=? AND day=? AND version=?`).run(JSON.stringify(b.output),now,user,r.day,r.base_version);
   if(!n.changes)fail(409,'每日数据已变化，本次结果已过期，请重新生成');
  }
  return {ok:true,status};
 }
 if(action!=='heartbeat')fail(404,'未知操作');if(r.status!=='running'||r.expires<=now)fail(409,'领取已超时');
 d.prepare('UPDATE agent_jobs SET expires=?,updated=? WHERE id=?').run(now+leaseMs(r),now,id);d.prepare('UPDATE executors SET last_seen=? WHERE key_id=?').run(now,key);return {lease_expires_at:now+leaseMs(r)};});
}
export function resolveJob(user,id,b,now=Date.now()){
 if(!obj(b)||!['cancel','requeue'].includes(b.decision)||!str(b.reason,2000))fail(400,'需提供处理方式和原因');
 return transaction(d=>{maintain(d,user,now);const r=d.prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=?').get(id,user);if(!r)fail(404,'任务不存在');
 if(!['queued','failed','needs_review'].includes(r.status))fail(409,'当前任务状态不能处理');
 if(b.decision==='requeue'){
  if(!['needs_review','failed'].includes(r.status)||b.confirmed_no_effect!==true)fail(409,'先确认没有外部效果，再重新排队');
  if(r.target_key_id!=='*'&&!d.prepare("SELECT 1 FROM api_keys WHERE id=? AND user_id=? AND scope IN ('worker','write') AND expires_at>?").get(r.target_key_id,user,now))fail(409,'执行密钥已失效');
  if(r.day&&!r.effect&&d.prepare('SELECT version FROM daily_days WHERE user_id=? AND day=?').get(user,r.day)?.version!==r.base_version)fail(409,'输入已变化，请重新生成流程');
 }
 audit(d,user,canon({decision:b.decision,reason:b.reason,previous_result:r.result}),id,now);
 d.prepare('UPDATE agent_jobs SET status=?,lease=NULL,expires=NULL,result=NULL,attempts=0,updated=? WHERE id=?').run(b.decision==='cancel'?'cancelled':'queued',now,id);return {ok:true};});
}
export function saveEvent(user,key,b,now=Date.now()){
 if(!obj(b)||!str(b.event_id)||b.type!=='simulation.feedback'||!obj(b.data))fail(400,'仅支持 simulation.feedback，真实反馈使用 daily/update');
 return transaction(d=>{const data=canon(b),old=d.prepare('SELECT * FROM agent_events WHERE id=?').get(b.event_id);if(old){if(old.user_id!==user||old.key_id!==key||old.body!==data)fail(409,'事件编号冲突');return {ok:true,duplicate:true}}d.prepare('INSERT INTO agent_events VALUES(?,?,?,?,?)').run(b.event_id,user,key,data,now);return {ok:true}});
}

export function activeJobs(user,key,now=Date.now()){
 return transaction(d=>{maintain(d,user,now);
 const jobs=d.prepare("SELECT * FROM agent_jobs WHERE user_id=? AND claimed_key_id=? AND status='running' AND expires>?").all(user,key,now).map(r=>({...view(r),lease_token:r.lease,lease_expires_at:r.expires,remaining_seconds:Math.ceil((r.expires-now)/1000),heartbeat_interval_seconds:30,contract:contract(JSON.parse(r.request).action),dependency_results:JSON.parse(r.dependencies).map(id=>{const dep=d.prepare('SELECT request,result FROM agent_jobs WHERE id=? AND user_id=?').get(id,user);return {job_id:id,action:JSON.parse(dep.request).action,result:JSON.parse(dep.result)}})}));
 return {jobs,recovery:'返回原租约，不续期、不重置任务。若外部操作可能已完成，先核对结果，勿重复执行。'};
 });
}
