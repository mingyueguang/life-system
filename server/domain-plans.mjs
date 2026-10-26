// 领域方案：可持续沿用的工作/健身/饮食方案（阶段 3，批次 A 加固）
// 方案有依据（source_job_id + basis_hash 输入指纹）、有效期（review_at，可配置复核周期）、版本与确认状态；
// 用户纠正关键资料后由 intake 联动标记 needs_review；调整请求持久化保存，跨重启/跨执行者可读；
// 确认只从用户侧（网站会话或 AI 对话同意后转达）执行；并发确认与依据变化由服务器拦截。
import {db,transaction} from './database.mjs';
import {HttpError} from './auth.mjs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {records,fingerprint} from './life.mjs';
const fail=(s,m)=>{throw new HttpError(s,m)};
const iso=z.string().datetime({offset:true});
const domainEnum=z.enum(['work','fitness','diet']);
// 复核周期默认值：有依据（领域方案一周复核一次，可在设置 domain_review_days 调整；按域配置，不全局硬编码）。
export const DEFAULT_REVIEW_DAYS={work:7,fitness:7,diet:7};
export function view(row){
 const body=JSON.parse(row.body);
 return {domain:row.domain,version:row.version,status:row.status,plan:body,review_at:row.review_at,confirmed_at:row.confirmed_at,source_job_id:row.source_job_id,basis_hash:row.basis_hash||null,created_at:row.created_at,updated_at:row.updated_at};
}
// 方案依据指纹：与统筹校验同源的 records 指纹；方案基于的资料一旦变化，确认时被拦截。
export function planBasis(d,user){return fingerprint(records(d,user))}
// 当前有效方案：最新已确认且未过复核时间的版本；无则 null。now 可注入，便于模拟跨日/到期测试。
export function currentPlan(d,user,domain,now=new Date()){
 domainEnum.parse(domain);
 const rows=d.prepare("SELECT * FROM domain_plans WHERE user_id=? AND domain=? AND status='confirmed' AND review_at>?").all(user,domain,new Date(now).toISOString());
 return rows[0]?view(rows[0]):null;
}
export function plans(user,domain,status,d=db()){
 const cond=['user_id=?'];const args=[user];
 if(domain){domainEnum.parse(domain);cond.push('domain=?');args.push(domain)}
 if(status){z.enum(['candidate','confirmed','needs_review','superseded','rejected']).parse(status);cond.push('status=?');args.push(status)}
 return d.prepare(`SELECT * FROM domain_plans WHERE ${cond.join(' AND ')} ORDER BY domain,version DESC LIMIT 100`).all(...args).map(view);
}
// 调整请求：持久化保存（原因/提出者/时间/关联方案版本/处理状态），跨重启、跨执行者可读。
export function adjustmentRequests(user,{domain,status}={},d=db()){
 const cond=['user_id=?'];const args=[user];
 if(domain){domainEnum.parse(domain);cond.push('domain=?');args.push(domain)}
 if(status){z.enum(['pending','handled','cancelled']).parse(status);cond.push('status=?');args.push(status)}
 const rows=d.prepare(`SELECT * FROM plan_adjustments WHERE ${cond.join(' AND ')} ORDER BY created_at,id`).all(...args);
 return rows.map(r=>({id:r.id,domain:r.domain,reason:r.reason,requester:r.requester,related_version:r.related_version,status:r.status,created_at:r.created_at,handled_at:r.handled_at,handled_by:r.handled_by}));
}
export function pendingAdjustments(d,user,domain,now=new Date().toISOString()){
 return adjustmentRequests(user,{domain,status:'pending'},d).filter(a=>a.created_at<=now);
}
// 新方案落库为 candidate（由 analysis 任务成功结果触发）。basis_hash 记录生成时的输入指纹。
export function savePlan(d,user,domain,{plan,source_job_id,basis_hash,review_at,status='candidate'},now=new Date().toISOString()){
 domainEnum.parse(domain);
 const next=(d.prepare('SELECT COALESCE(MAX(version),0)+1 n FROM domain_plans WHERE user_id=? AND domain=?').get(user,domain).n);
 const reviewAt=review_at||new Date(new Date(now).getTime()+DEFAULT_REVIEW_DAYS[domain]*86400000).toISOString();
 d.prepare('INSERT INTO domain_plans VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(user,domain,next,JSON.stringify(plan),status,null,reviewAt,source_job_id,now,now,basis_hash);
 return {domain,version:next,status};
}
// 分析任务已处理调整请求：成功后把该域 pending 请求标记 handled（关联新方案版本），供后续追溯。
export function markAdjustmentsHandled(d,user,domain,{by,new_version,now=new Date().toISOString()}){
 d.prepare("UPDATE plan_adjustments SET status='handled',handled_at=?,handled_by=? WHERE user_id=? AND domain=? AND status='pending'").run(now,by+(new_version?`（新方案 v${new_version}）`:''),user,domain);
}
// 确认方案：用户确认某个候选/需复核方案为当前有效版本；其余旧版本标记 superseded。
// 批次 A 加固：①存在更新版本已确认 → 409 并发冲突；②方案依据指纹已变化 → 409 拒绝旧候选；
// ③需复核（含过期）方案确认 = 继续沿用 → 记录新的有效期（按该域复核周期），避免"确认成功但立即不可用"。
export function confirmPlan(user,domain,version,actor,now=new Date().toISOString(),reviewDays=DEFAULT_REVIEW_DAYS){
 domainEnum.parse(domain);if(!Number.isInteger(version)||version<1)fail(400,'版本无效');
 const days=reviewDays&&Number.isInteger(reviewDays[domain])&&reviewDays[domain]>=1?reviewDays[domain]:DEFAULT_REVIEW_DAYS[domain];
 return transaction(d=>{
  const row=d.prepare('SELECT * FROM domain_plans WHERE user_id=? AND domain=? AND version=?').get(user,domain,version);
  if(!row)fail(404,'方案不存在');
  const nowIso=new Date(now).toISOString();
  const expired=row.status==='confirmed'&&row.review_at<=nowIso;
  if(row.status!=='candidate'&&row.status!=='needs_review'&&!expired)fail(409,'只有候选、需复核或已过期的方案可以确认');
  const newer=d.prepare("SELECT 1 FROM domain_plans WHERE user_id=? AND domain=? AND status='confirmed' AND version>?").get(user,domain,version);
  if(newer)fail(409,'已有更新的有效方案（v'+(d.prepare('SELECT version FROM domain_plans WHERE user_id=? AND domain=? AND status=? ORDER BY version DESC LIMIT 1').get(user,domain,'confirmed').version)+'），请刷新后重新确认，不能覆盖较新版本');
  if(row.basis_hash){const current=planBasis(d,user);if(row.basis_hash!==current)fail(409,'方案依据的资料已变化，该候选已过期，请重新生成后再确认');}
  const reviewAt=row.review_at>nowIso?row.review_at:new Date(new Date(nowIso).getTime()+days*86400000).toISOString();
  d.prepare("UPDATE domain_plans SET status='superseded' WHERE user_id=? AND domain=? AND version<? AND status IN ('candidate','confirmed')").run(user,domain,version);
  d.prepare('UPDATE domain_plans SET status=?,confirmed_at=?,review_at=?,updated_at=? WHERE user_id=? AND domain=? AND version=?').run('confirmed',nowIso,reviewAt,nowIso,user,domain,version);
  // 确认人写入审计（执行者 keyId 或 'website'）。
  d.prepare('INSERT INTO agent_audit(user_id,event,job_id,created) VALUES(?,?,?,?)').run(user,'plan.confirm:'+actor,null,Date.now());
  return view(d.prepare('SELECT * FROM domain_plans WHERE user_id=? AND domain=? AND version=?').get(user,domain,version));
 });
}
// 申请调整：新事实或用户要求重算 → 持久化调整请求 + 当前有效方案标记 needs_review（不删除、不整套重算）。
export function adjustPlan(user,domain,reason,actor,now=new Date().toISOString()){
 domainEnum.parse(domain);if(typeof reason!=='string'||!reason.trim()||reason.length>1000)fail(400,'请说明调整原因');
 const id=randomUUID();
 return transaction(d=>{
  const current=currentPlan(d,user,domain,new Date(now));
  if(!current)fail(404,'没有已确认的方案需要调整');
  const updated=d.prepare("UPDATE domain_plans SET status='needs_review',updated_at=? WHERE user_id=? AND domain=? AND version=? AND status='confirmed'").run(now,user,domain,current.version);
  if(!updated.changes)fail(409,'方案已变化，请刷新后重试');
  d.prepare('INSERT INTO plan_adjustments VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user,domain,reason,actor,current.version,'pending',now,null,null);
  return {adjustment_id:id,domain,version:current.version,status:'needs_review',reason,requester:actor,created_at:now,note:'调整请求已持久化，下一轮分析会读取并说明处理'};
 });
}
// 资料变化联动：某个领域的档案被修改后，标记其有效方案需复核。
export function invalidateDomainPlans(d,user,domains,now=new Date().toISOString()){
 for(const domain of domains)d.prepare("UPDATE domain_plans SET status='needs_review',updated_at=? WHERE user_id=? AND domain=? AND status='confirmed' AND review_at>?").run(now,user,domain,now);
}
