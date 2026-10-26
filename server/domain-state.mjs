// 领域状态四态与触发审计（阶段 4，批次 B 强化为信号驱动）
// 四态：资料不足(insufficient) / 正常(normal) / 需关注(attention) / 需调整(adjust)。
// 每个信号记录来源(source)、判断规则(rule)、处理结果(result)与说明(detail)：
//   - intake：关键资料未确认 → 补资料（派分析但强制 missing），缺失不算正常；
//   - adjust：待处理调整请求（持久化 plan_adjustments）→ 该域重新分析；
//   - plan：无有效方案 / 复核时间已到 → 重新分析；方案将到期仅提示，不重算；
//   - feedback：昨日未完成结转（carryover）→ 沿用方案但纳入统筹（attention）；
//   - audit：repeated_skip / time_overrun 持久偏离 → 该域重新分析（adjust）；
//     单次部分完成/未完成只保留反馈并评估（carryover/attention），不直接废弃领域方案。
// 阈值有来源：energy_drop_threshold / overrun_factor 来自 life_settings.auto_adjust（用户可配置）；
// repeated_skip 与复核周期为内置可配置规则（domain_review_days），不擅自判定其他异常。
import {db} from './database.mjs';
import {currentPlan,plans,pendingAdjustments} from './domain-plans.mjs';
export const states=['insufficient','normal','attention','adjust'];
const REVIEW_WINDOW_DAYS=2; // 距复核时间 ≤2 天时仅提示（即将复核），不触发重算
function sig(source,rule,result,detail){return {source,rule,result,detail}}
// 审计异常按域归类：repeated_skip/time_overrun 带 domain；input_drop/energy_drop 为当日全局软信号。
function anomaliesByDomain(ctx){
 const out={};
 for(const a of ctx.day?.anomalies||[]){
  const dom=a.domain||'*';
  (out[dom]=out[dom]||[]).push(a);
 }
 return out;
}
export function assessDomain(d,user,domain,day,ctx,now=new Date()){
 const intake=ctx.intake?.[domain]||{};
 const missing=Array.isArray(intake.required_missing)?intake.required_missing:[];
 const cur=currentPlan(d,user,domain,now);
 const pending=pendingAdjustments(d,user,domain,new Date(now).toISOString());
 const reasons=[],signals=[];
 if(missing.length){
  signals.push(sig('intake','关键资料未确认（required_missing 非空）','analyze','该域资料不足，不能显示为正常；派分析任务补资料并输出候选'));
  reasons.push('关键资料未确认：'+missing.join('、')+'。数据缺失不算正常，不生成确定性方案，交由分析任务补资料并输出候选');
  return {state:'insufficient',decision:'analyze',reasons,signals,missing,plan:null,pending_adjustments:pending.length};
 }
 if(pending.length){
  signals.push(sig('adjust','存在待处理调整请求（plan_adjustments）','analyze','该域有 '+pending.length+' 项待处理调整请求，触发重新分析，成功后将请求标记已处理'));
  reasons.push('领域有 '+pending.length+' 项待处理调整请求，触发重新分析');
  return {state:'adjust',decision:'analyze',reasons,signals,missing,plan:cur?{version:cur.version,review_at:cur.review_at}:null,pending_adjustments:pending.length};
 }
 if(!cur){
  const latest=plans(user,domain,null,d).filter(p=>p.status==='needs_review'||p.status==='candidate').sort((a,b)=>b.version-a.version)[0];
  if(latest)reasons.push('没有已确认且未过复核时间的有效方案：最近方案状态为 '+latest.status+(latest.review_at<new Date(now).toISOString()?'，已过复核时间':''));
  else reasons.push('尚无领域方案，需先生成候选方案');
  signals.push(sig('plan','没有当前有效方案或复核时间已到','analyze','需要生成或更新领域方案'));
  return {state:'adjust',decision:'analyze',reasons,signals,missing,plan:null,pending_adjustments:0};
 }
 const plan={version:cur.version,review_at:cur.review_at};
 const anomalies=anomaliesByDomain(ctx);
 // 持久偏离（重复跳过 / 严重超时）→ 需调整，只分析受影响领域
 const hard=anomalies[domain]||[];
 if(hard.length){
  const names=hard.map(a=>a.detail).join('；');
  signals.push(sig('audit','repeated_skip 或 time_overrun 持久偏离（阈值见 life_settings.auto_adjust）','analyze',names));
  reasons.push('观测到持久偏离信号：'+names);
  return {state:'adjust',decision:'analyze',reasons,signals,missing,plan,pending_adjustments:0};
 }
 const co=(ctx.carryover||[]).filter(c=>c.domain===domain);
 const daysLeft=Math.ceil((new Date(cur.review_at)-now)/86400000);
 if(co.length){
  signals.push(sig('feedback','昨日该领域有未完成结转（carryover）','reuse','沿用方案并纳入今日统筹；单次未完成保留反馈评估，不废弃领域方案'));
  reasons.push('昨日该领域有 '+co.length+' 项未完成结转（'+co.slice(0,3).map(c=>'「'+c.title+'」').join('、')+'），沿用方案并纳入今日统筹');
  return {state:'attention',decision:'reuse',reasons,signals,missing,plan};
 }
 // 当日全局软信号（时间/精力骤降）：需关注、沿用方案并提请确认，不自动重算
 const soft=(anomalies['*']||[]).filter(a=>['input_drop','energy_drop'].includes(a.code));
 if(soft.length){
  const names=soft.map(a=>a.detail).join('；');
  signals.push(sig('audit','input_drop / energy_drop 当日软信号（阈值见 life_settings.auto_adjust）','reuse','沿用方案并在统筹中提请确认，不自动重算'));
  reasons.push('观测到软信号：'+names);
  return {state:'attention',decision:'reuse',reasons,signals,missing,plan};
 }
 signals.push(sig('plan','方案有效且未到复核时间','reuse','正常沿用，不派发分析'));
 reasons.push('方案有效，'+Math.max(daysLeft,0)+' 天后到复核时间'+(daysLeft<=REVIEW_WINDOW_DAYS?'（即将复核，仅提示）':''));
 reasons.push('未观测到需要调整的信号；相关业务阈值未配置时不擅自判定异常');
 return {state:'normal',decision:'reuse',reasons,signals,missing,plan,pending_adjustments:0};
}
export function logDomainState(d,user,day,domain,st,now=new Date().toISOString()){
 d.prepare('INSERT INTO domain_state_log(user_id,day,domain,state,decision,reasons,missing,plan_version,plan_review_at,signals,pending_adjustments,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(user,day,domain,st.state,st.decision,JSON.stringify(st.reasons),JSON.stringify(st.missing||[]),st.plan?st.plan.version:null,st.plan?st.plan.review_at:null,JSON.stringify(st.signals||[]),st.pending_adjustments??0,now);
}
// 查询：指定日期（默认最近记录日）+ 可选领域；另返回该日全局信号（审计 anomalies），供追溯"为什么"。
export function domainState(user,{day,domain}={},d=db()){
 const cond=['user_id=?'];const args=[user];
 if(domain){cond.push('domain=?');args.push(domain)}
 if(day)cond.push('day=?'),args.push(day);
 else cond.push('day=(SELECT MAX(day) FROM domain_state_log WHERE user_id=?)'),args.push(user);
 const rows=d.prepare(`SELECT * FROM domain_state_log WHERE ${cond.join(' AND ')} ORDER BY domain`).all(...args).map(r=>({day:r.day,domain:r.domain,state:r.state,decision:r.decision,reasons:JSON.parse(r.reasons),signals:JSON.parse(r.signals||'[]'),missing:JSON.parse(r.missing),plan_version:r.plan_version,plan_review_at:r.plan_review_at,pending_adjustments:r.pending_adjustments,created_at:r.created_at}));
 const curDay=d.prepare('SELECT MAX(day) day FROM domain_state_log WHERE user_id=?').get(user).day;
 // current = 最近生成日每域最新一条评估（同一生成日可能多次评估，按 created_at 取每域最新，避免客户端读到过期判断）
 const current=curDay?(()=>{const all=d.prepare(`SELECT * FROM domain_state_log WHERE user_id=? AND day=?${domain?' AND domain=?':''} ORDER BY domain,created_at DESC`).all(user,curDay,...(domain?[domain]:[]));
  const seen=new Set(),out=[];
  for(const r of all){if(seen.has(r.domain))continue;seen.add(r.domain);out.push({day:r.day,domain:r.domain,state:r.state,decision:r.decision,reasons:JSON.parse(r.reasons),signals:JSON.parse(r.signals||'[]'),missing:JSON.parse(r.missing),plan_version:r.plan_version,plan_review_at:r.plan_review_at,pending_adjustments:r.pending_adjustments,created_at:r.created_at})}
  return out;})():[];
 return {current,domains:rows,note:'current 为最近一次生成日的领域状态（当前判断，服务器确定最新）；domains 为查询结果（不传 day=最近一天，传 day=该日历史）；历史完整保留在 domain_state_log，可按 day/domain 回溯。当日全局异常信号见 daily context 的 day.audit.anomalies（input_drop / energy_drop / repeated_skip / time_overrun）；每态 signals 记录触发来源与判断规则'};
}
