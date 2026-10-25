// 领域状态四态与触发审计（阶段 4）
// 轻量确定性规则：资料不足→补资料（派分析但强制 missing）；无有效方案→重新分析；
// 该域有未完成结转→沿用方案但纳入统筹（attention）；其余→正常沿用（normal）。
// 未配置业务阈值（如"训练强度异常"）时不擅自判定异常；阈值有来源：energy_drop_threshold、
// overrun_factor 来自 life_settings.auto_adjust（用户可配置），input_drop/repeated_skip 为内置规则。
import {db} from './database.mjs';
import {currentPlan,plans} from './domain-plans.mjs';
export const states=['insufficient','normal','attention','adjust'];
export function assessDomain(d,user,domain,day,ctx,now=new Date()){
 const intake=ctx.intake?.[domain]||{};
 const missing=Array.isArray(intake.required_missing)?intake.required_missing:[];
 const cur=currentPlan(d,user,domain);
 const reasons=[];
 if(missing.length){reasons.push('关键资料未确认：'+missing.join('、')+'。数据缺失不算正常，不生成确定性方案，交由分析任务补资料并输出候选');return {state:'insufficient',decision:'analyze',reasons,missing,plan:null}}
 if(!cur){
  const latest=plans(user,domain,null,d).filter(p=>p.status==='needs_review'||p.status==='candidate').sort((a,b)=>b.version-a.version)[0];
  if(latest)reasons.push('没有已确认且未过复核时间的有效方案：最近方案状态为 '+latest.status+(latest.review_at<new Date(now).toISOString()?'，已过复核时间':''));
  else reasons.push('尚无领域方案，需先生成候选方案');
  return {state:'adjust',decision:'analyze',reasons,missing,plan:null}
 }
 const plan={version:cur.version,review_at:cur.review_at};
 const co=(ctx.carryover||[]).filter(c=>c.domain===domain);
 if(co.length){reasons.push('昨日该领域有 '+co.length+' 项未完成结转（'+co.slice(0,3).map(c=>'「'+c.title+'」').join('、')+'），沿用方案并纳入今日统筹');return {state:'attention',decision:'reuse',reasons,missing,plan}}
 const daysLeft=Math.ceil((new Date(cur.review_at)-now)/86400000);
 reasons.push('方案有效，'+Math.max(daysLeft,0)+' 天后到复核时间'+(daysLeft<=2?'（即将复核，仅提示）':''));
 reasons.push('未观测到需要调整的信号；相关业务阈值未配置时不擅自判定异常');
 return {state:'normal',decision:'reuse',reasons,missing,plan};
}
export function logDomainState(d,user,day,domain,st,now=new Date().toISOString()){
 d.prepare('INSERT INTO domain_state_log(user_id,day,domain,state,decision,reasons,missing,plan_version,plan_review_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(user,day,domain,st.state,st.decision,JSON.stringify(st.reasons),JSON.stringify(st.missing||[]),st.plan?st.plan.version:null,st.plan?st.plan.review_at:null,now);
}
// 查询：指定日期（默认最近记录日）+ 可选领域；另返回该日全局信号（审计 anomalies），供追溯"为什么"。
export function domainState(user,{day,domain}={},d=db()){
 const cond=['user_id=?'];const args=[user];
 if(domain){cond.push('domain=?');args.push(domain)}
 if(day)cond.push('day=?'),args.push(day);
 else cond.push('day=(SELECT MAX(day) FROM domain_state_log WHERE user_id=?)'),args.push(user);
 const rows=d.prepare(`SELECT * FROM domain_state_log WHERE ${cond.join(' AND ')} ORDER BY domain`).all(...args).map(r=>({day:r.day,domain:r.domain,state:r.state,decision:r.decision,reasons:JSON.parse(r.reasons),missing:JSON.parse(r.missing),plan_version:r.plan_version,plan_review_at:r.plan_review_at,created_at:r.created_at}));
 return {domains:rows,note:'当日全局异常信号见 daily context 的 day.audit.anomalies（input_drop / energy_drop / repeated_skip / time_overrun）'};
}
