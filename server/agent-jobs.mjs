import {randomUUID} from 'node:crypto';
import {db,transaction} from './database.mjs';
import {HttpError} from './auth.mjs';
const fail=(status,message)=>{throw new HttpError(status,message)};
const str=(v,max=200)=>typeof v==='string'&&v.length>0&&v.length<=max;
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const canonical=v=>JSON.stringify(v,(_,x)=>obj(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const view=r=>({job_id:r.id,target_key_id:r.target_key_id,...JSON.parse(r.request),status:r.status,result:r.result?JSON.parse(r.result):null,created_at:r.created,updated_at:r.updated});
function audit(d,u,event,id,now){d.prepare('INSERT INTO agent_audit(user_id,event,job_id,created) VALUES(?,?,?,?)').run(u,event,id,now)}
function expire(d,u,now){d.prepare("UPDATE agent_jobs SET status='needs_review',updated=? WHERE user_id=? AND status='running' AND expires<=?").run(now,u,now)}
export function listJobs(user,now=Date.now()){
 return transaction(d=>{expire(d,user,now);return {jobs:d.prepare('SELECT * FROM agent_jobs WHERE user_id=? ORDER BY created DESC,id LIMIT 100').all(user).map(view),mode:'simulation_only',model_connected:false}});
}
export function createJob(user,b,now=Date.now()){
 if(!obj(b)||!str(b.idempotency_key)||!str(b.target_key_id)||b.mode!=='simulation'||b.action!=='simulation.noop'||!obj(b.payload))fail(400,'当前仅支持 simulation.noop 模拟任务，并需指定执行密钥');
 const request=canonical({mode:b.mode,action:b.action,payload:b.payload});
 return transaction(d=>{
  if(!d.prepare("SELECT 1 FROM api_keys WHERE id=? AND user_id=? AND scope='worker' AND expires_at>?").get(b.target_key_id,user,now))fail(400,'请选择仍有效的任务执行密钥');
  const old=d.prepare('SELECT * FROM agent_jobs WHERE user_id=? AND idem=?').get(user,b.idempotency_key);
  if(old){if(old.request!==request||old.target_key_id!==b.target_key_id)fail(409,'操作编号已用于不同任务');return view(old)}
  const id=randomUUID();d.prepare('INSERT INTO agent_jobs(id,user_id,target_key_id,idem,request,status,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(id,user,b.target_key_id,b.idempotency_key,request,'queued',now,now);audit(d,user,'created',id,now);return view(d.prepare('SELECT * FROM agent_jobs WHERE id=?').get(id));
 });
}
export function claimJob(user,key,b,now=Date.now()){
 if(!obj(b)||(b.job_id!==undefined&&!str(b.job_id)))fail(400,'任务编号格式错误');
 return transaction(d=>{expire(d,user,now);
  const r=b.job_id?d.prepare("SELECT * FROM agent_jobs WHERE id=? AND user_id=? AND target_key_id=? AND status='queued'").get(b.job_id,user,key):d.prepare("SELECT * FROM agent_jobs WHERE user_id=? AND target_key_id=? AND status='queued' ORDER BY created,id LIMIT 1").get(user,key);
  if(!r)return {job:null};const lease=randomUUID(),expires=now+120000;
  d.prepare("UPDATE agent_jobs SET status='running',lease=?,expires=?,updated=? WHERE id=?").run(lease,expires,now,r.id);audit(d,user,'claimed',r.id,now);
  return {job:{...view({...r,status:'running',updated:now}),lease_token:lease,lease_expires_at:expires}};
 });
}
export function updateJob(user,key,id,action,b,now=Date.now()){
 if(!obj(b))fail(400,'需要 JSON 对象');
 // Persist expiry even when rejecting a stale update.
 expire(db(),user,now);
 return transaction(d=>{
  const r=d.prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=? AND target_key_id=?').get(id,user,key);
  if(!r)fail(404,'任务不存在');
  if(!str(b.lease_token)||b.lease_token!==r.lease)fail(409,'领取凭据已失效');
  if(action==='result'){
   if(!['succeeded','failed','needs_review'].includes(b.status)||!obj(b.output))fail(400,'执行结果格式错误');
   if(b.status==='succeeded'&&(b.output.simulated!==true||b.output.external_effect!==false))fail(400,'模拟任务成功结果必须声明 simulated=true、external_effect=false');
   const result=canonical({status:b.status,output:b.output});
   if(r.result===result)return {ok:true,duplicate:true};
   if(r.status!=='running'||r.expires<=now)fail(409,'任务已结束或领取超时，需核对后处理');
   d.prepare('UPDATE agent_jobs SET status=?,result=?,updated=? WHERE id=?').run(b.status,result,now,id);audit(d,user,'result:'+b.status,id,now);return {ok:true};
  }
  if(action!=='heartbeat')fail(404,'未知操作');
  if(r.status!=='running'||r.expires<=now)fail(409,'领取已超时');
  d.prepare('UPDATE agent_jobs SET expires=?,updated=? WHERE id=?').run(now+120000,now,id);return {lease_expires_at:now+120000};
 });
}
export function resolveJob(user,id,b,now=Date.now()){
 if(!obj(b)||!['cancel','requeue'].includes(b.decision)||!str(b.reason,2000))fail(400,'需提供处理方式和原因');
 return transaction(d=>{expire(d,user,now);const r=d.prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=?').get(id,user);if(!r)fail(404,'任务不存在');
  if(b.decision==='cancel'&&!['queued','failed','needs_review'].includes(r.status))fail(409,'当前任务状态不能取消');
  if(b.decision==='requeue'){
   if(!['needs_review','failed'].includes(r.status)||b.confirmed_no_effect!==true)fail(409,'先确认没有外部效果，再重新排队');
   if(!d.prepare("SELECT 1 FROM api_keys WHERE id=? AND user_id=? AND scope='worker' AND expires_at>?").get(r.target_key_id,user,now))fail(409,'执行密钥已失效，请创建新测试任务');
  }
  d.prepare('UPDATE agent_jobs SET status=?,lease=NULL,expires=NULL,result=NULL,updated=? WHERE id=?').run(b.decision==='cancel'?'cancelled':'queued',now,id);audit(d,user,canonical({decision:b.decision,reason:b.reason,previous_result:r.result}),id,now);return {ok:true};
 });
}
export function saveEvent(user,key,b,now=Date.now()){
 if(!obj(b)||!str(b.event_id)||b.type!=='simulation.feedback'||!obj(b.data))fail(400,'仅支持 simulation.feedback 模拟事件');
 return transaction(d=>{const data=canonical(b),old=d.prepare('SELECT * FROM agent_events WHERE id=?').get(b.event_id);if(old){if(old.user_id!==user||old.key_id!==key||old.body!==data)fail(409,'事件编号冲突');return {ok:true,duplicate:true}}
  d.prepare('INSERT INTO agent_events VALUES(?,?,?,?,?)').run(b.event_id,user,key,data,now);return {ok:true};
 });
}
