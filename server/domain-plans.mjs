// 领域方案：可持续沿用的工作/健身/饮食方案（阶段 3）
// 方案有依据（source_job_id）、有效期（review_at）、版本与确认状态；
// 用户纠正关键资料后由 intake 联动标记 needs_review；确认只从用户侧（网站会话）执行。
import {db,transaction} from './database.mjs';
import {HttpError} from './auth.mjs';
import {z} from 'zod';
const fail=(s,m)=>{throw new HttpError(s,m)};
const iso=z.string().datetime({offset:true});
const domainEnum=z.enum(['work','fitness','diet']);
const DEFAULT_REVIEW_DAYS=7;
export function view(row){
 const body=JSON.parse(row.body);
 return {domain:row.domain,version:row.version,status:row.status,plan:body,review_at:row.review_at,confirmed_at:row.confirmed_at,source_job_id:row.source_job_id,created_at:row.created_at,updated_at:row.updated_at};
}
// 当前有效方案：最新已确认且未过复核时间的版本；无则 null。
export function currentPlan(d,user,domain){
 domainEnum.parse(domain);
 const rows=d.prepare("SELECT * FROM domain_plans WHERE user_id=? AND domain=? AND status='confirmed' AND review_at>? ORDER BY version DESC LIMIT 1").all(user,domain,new Date().toISOString());
 return rows[0]?view(rows[0]):null;
}
export function plans(user,domain,status,d=db()){
 const cond=['user_id=?'];const args=[user];
 if(domain){domainEnum.parse(domain);cond.push('domain=?');args.push(domain)}
 if(status){z.enum(['candidate','confirmed','needs_review','superseded','rejected']).parse(status);cond.push('status=?');args.push(status)}
 return d.prepare(`SELECT * FROM domain_plans WHERE ${cond.join(' AND ')} ORDER BY domain,version DESC LIMIT 100`).all(...args).map(view);
}
// 新方案落库为 candidate（由 analysis 任务成功结果触发）。
export function savePlan(d,user,domain,{plan,source_job_id,review_at=new Date(Date.now()+DEFAULT_REVIEW_DAYS*86400000).toISOString(),status='candidate'},now=new Date().toISOString()){
 domainEnum.parse(domain);
 const next=(d.prepare('SELECT COALESCE(MAX(version),0)+1 n FROM domain_plans WHERE user_id=? AND domain=?').get(user,domain).n);
 d.prepare('INSERT INTO domain_plans VALUES(?,?,?,?,?,?,?,?,?,?)').run(user,domain,next,JSON.stringify(plan),status,null,review_at,source_job_id,now,now);
 return {domain,version:next,status};
}
// 确认方案：用户（网站会话）确认某个候选为有效版本；其余候选/旧版标记 superseded。
export function confirmPlan(user,domain,version,actor,now=new Date().toISOString()){
 domainEnum.parse(domain);if(!Number.isInteger(version)||version<1)fail(400,'版本无效');
 return transaction(d=>{
  const row=d.prepare('SELECT * FROM domain_plans WHERE user_id=? AND domain=? AND version=?').get(user,domain,version);
  if(!row)fail(404,'方案不存在');
  if(row.status!=='candidate'&&row.status!=='needs_review')fail(409,'只有候选或需复核的方案可以确认');
  d.prepare("UPDATE domain_plans SET status='superseded' WHERE user_id=? AND domain=? AND version<? AND status IN ('candidate','confirmed')").run(user,domain,version);
  d.prepare('UPDATE domain_plans SET status=?,confirmed_at=?,updated_at=? WHERE user_id=? AND domain=? AND version=?').run('confirmed',now,now,user,domain,version);
  return view(d.prepare('SELECT * FROM domain_plans WHERE user_id=? AND domain=? AND version=?').get(user,domain,version));
 });
}
// 申请调整：新事实或用户要求重算 → 当前有效方案标记 needs_review（不删除、不整套重算）。
export function adjustPlan(user,domain,reason,actor,now=new Date().toISOString()){
 domainEnum.parse(domain);if(typeof reason!=='string'||!reason.trim()||reason.length>1000)fail(400,'请说明调整原因');
 return transaction(d=>{
  const current=currentPlan(d,user,domain);
  if(!current)fail(404,'没有已确认的方案需要调整');
  const updated=d.prepare("UPDATE domain_plans SET status='needs_review',updated_at=? WHERE user_id=? AND domain=? AND version=? AND status='confirmed'").run(now,user,domain,current.version);
  if(!updated.changes)fail(409,'方案已变化，请刷新后重试');
  return {domain,version:current.version,status:'needs_review',reason,actor,updated_at:now};
 });
}
// 资料变化联动：某个领域的档案被修改后，标记其有效方案需复核。
export function invalidateDomainPlans(d,user,domains,now=new Date().toISOString()){
 for(const domain of domains)d.prepare("UPDATE domain_plans SET status='needs_review',updated_at=? WHERE user_id=? AND domain=? AND status='confirmed' AND review_at>?").run(now,user,domain,now);
}
