import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {db,transaction} from './database.mjs';
import {HttpError} from './auth.mjs';
import {auditContext} from './audit.mjs';
import {definitions as intakeDefs} from './intake.mjs';
import {currentPlan} from './domain-plans.mjs';
import {assessDomain,logDomainState} from './domain-state.mjs';
export const fail=(s,m)=>{throw new HttpError(s,m)};
export const canon=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const dateSchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s);
const text=z.string().trim().min(1).max(2000);
export const today=(now=Date.now())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export const clockTime=(now=Date.now())=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(now));
// Pure day-string arithmetic in Asia/Shanghai (day is an en-CA formatted local date).
const shiftDay=(day,n)=>{const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
export const nextDay=day=>shiftDay(day,1);
const inputSchema=z.object({available_minutes:z.number().int().min(0).max(1440).nullable().default(null),energy:z.number().int().min(1).max(5).nullable().default(null),fixed:z.string().max(4000).default(''),note:z.string().max(4000).default('')}).strict();
const itemSchema=z.object({id:z.string().uuid(),title:text,minutes:z.number().int().min(1).max(1440),reason:text,task_id:z.string().uuid().nullable().default(null),domain:z.enum(['work','fitness','diet']).optional(),source_id:z.string().uuid().nullable().optional()}).strict();
export const planSchema=z.object({summary:text,items:z.array(itemSchema).max(40),buffer_minutes:z.number().int().min(0).max(1440),deferred:z.array(text).max(40),missing:z.array(text).max(20)}).strict();
export const analysisSchema=z.object({summary:text,recommendations:z.array(text).max(30),missing:z.array(text).max(20)}).strict();
const fitnessItem=z.object({id:z.string().uuid(),title:text,minutes:z.number().int().min(5).max(300),reason:text}).strict();
export const fitnessPlanSchema=z.object({summary:text,sessions:z.array(fitnessItem).max(20),missing:z.array(text).max(20)}).strict();
const dietItem=z.object({id:z.string().uuid(),title:text,reason:text}).strict();
export const dietPlanSchema=z.object({summary:text,meals:z.array(dietItem).max(30),missing:z.array(text).max(20)}).strict();
export const reviewSchema=z.object({summary:text,observations:z.array(text).max(30),adjustments:z.array(text).max(30),missing:z.array(text).max(20)}).strict();
export const publishSchema=z.object({external_effect:z.literal(true),receipts:z.array(z.object({item_id:z.string(),external_id:text,url:z.string().url().optional()}).strict()).min(1).max(41)}).strict();
const autoAdjustSchema=z.object({enabled:z.boolean(),overrun_factor:z.number().min(1).max(5),energy_drop_threshold:z.number().int().min(1).max(5),skip_carryover:z.boolean()}).strict();
const settingsSchema=z.object({enabled:z.boolean(),plan_time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),review_time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),feishu:z.boolean(),auto_adjust:autoAdjustSchema}).strict();
const settingsDefaults={enabled:false,plan_time:'07:00',review_time:'21:00',feishu:false,auto_adjust:{enabled:true,overrun_factor:2,energy_drop_threshold:2,skip_carryover:true}};
export function settings(user,d=db()){const b=JSON.parse(d.prepare('SELECT body FROM life_settings WHERE user_id=?').get(user)?.body||'{}');return {...settingsDefaults,...b,auto_adjust:{...settingsDefaults.auto_adjust,...(b.auto_adjust||{})}}}
export function saveSettings(user,b){const {actor='website',...rest}=b;const value=settingsSchema.parse({...rest,auto_adjust:{...settingsDefaults.auto_adjust,...(rest.auto_adjust||{})}});db().prepare('INSERT INTO life_settings VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body').run(user,JSON.stringify(value));db().prepare('INSERT INTO agent_audit(user_id,event,job_id,created) VALUES(?,?,?,?)').run(user,'settings.update:'+actor,null,Date.now());return value}
export function ensureDay(d,user,day,now){dateSchema.parse(day);d.prepare("INSERT OR IGNORE INTO daily_days(user_id,day,input,updated) VALUES(?,?,?,?)").run(user,day,JSON.stringify(inputSchema.parse({})),now);return d.prepare('SELECT * FROM daily_days WHERE user_id=? AND day=?').get(user,day)}
export function unpackDay(r){return {...r,input:JSON.parse(r.input),plan:r.plan?JSON.parse(r.plan):null,feedback:JSON.parse(r.feedback),review:r.review?JSON.parse(r.review):null,fitness:r.fitness?JSON.parse(r.fitness):null,diet:r.diet?JSON.parse(r.diet):null,confirmed:!!r.confirmed}}
export function records(d,user){return d.prepare("SELECT r.id,r.kind,r.payload,r.version,m.body FROM records r LEFT JOIN record_metadata m ON m.record_id=r.id WHERE r.user_id=? AND r.deleted=0 AND r.kind IN ('goal','task','sleep','exercise','intake','environment','phone_usage','mood','profile') ORDER BY r.id").all(user).map(r=>({id:r.id,kind:r.kind,version:r.version,data:JSON.parse(r.payload),metadata:r.body?JSON.parse(r.body):{}}))}
export const fingerprint=r=>createHash('sha256').update(canon(r)).digest('hex');
// Shared-profile collection status per domain (server side, mirrors intake fields without importing intake.mjs at call time).
function intakeStatus(d,user){
 const rows=d.prepare('SELECT field_key,deferred,record_id,record_version FROM intake_fields WHERE user_id=?').all(user);
 const byKey=new Map(rows.map(r=>[r.field_key,r]));
 const statusFor=def=>{const link=byKey.get(def.key);if(link?.deferred)return 'deferred';if(!link?.record_id)return 'missing';
  const rec=d.prepare('SELECT version,deleted,payload FROM records WHERE id=? AND user_id=?').get(link.record_id,user);
  if(!rec||rec.deleted||rec.version!==link.record_version)return 'needs_review';
  return JSON.parse(rec.payload).status==='known'?'known':'needs_review';};
 const out={};
 for(const domain of ['work','fitness','diet']){
  const fields=intakeDefs.filter(x=>x.domains.includes(domain)).map(x=>({key:x.key,label:x.label,question:x.question,required:x.required,status:statusFor(x)}));
  out[domain]={fields,required_missing:fields.filter(f=>f.required&&f.status!=='known').map(f=>f.label),needs_review:fields.filter(f=>f.status==='needs_review').map(f=>f.label),known:fields.filter(f=>f.status==='known').map(f=>f.label)};
 }
 return out;
}
export function context(d,user,day){const current=unpackDay(ensureDay(d,user,day,Date.now()));const since=shiftDay(day,-7);const recent=d.prepare('SELECT * FROM daily_days WHERE user_id=? AND day>=? AND day<? ORDER BY day DESC LIMIT 30').all(user,since,day).map(unpackDay);const all=records(d,user);const s=settings(user,d);const audit=auditContext(d,user,day,{all,recent,adjust:s.auto_adjust});return {day:{...current,audit:audit.issues,anomalies:audit.anomalies},recent,records:all,records_version:fingerprint(all),guards:audit.guards,carryover:audit.carryover,intake:intakeStatus(d,user)}}
 export function enqueue(d,user,{idem,action,payload={},dependencies=[],day=null,version=null,target='*'},now){
 const old=d.prepare('SELECT id,status FROM agent_jobs WHERE user_id=? AND idem=?').get(user,idem);
 if(old){// 失败/取消可重新排队（无外部效果）；needs_review 保留待核对，不自动复活
  if(['failed','cancelled'].includes(old.status))d.prepare("UPDATE agent_jobs SET status='queued',lease=NULL,result=NULL,updated=? WHERE id=?").run(now,old.id);
  return old.id;
 }
 const id=randomUUID(),effect=action.startsWith('feishu.publish')?1:0;
 d.prepare(`INSERT INTO agent_jobs(id,user_id,target_key_id,idem,request,status,created,updated,capability,dependencies,effect,day,base_version) VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?,?)`).run(id,user,target,idem,canon({mode:'live',action,payload}),now,now,effect?'feishu':'analysis',JSON.stringify(dependencies),effect,day,version);return id;
}
export function generate(user,b,now=Date.now()){
 const {day,kind,version}=z.object({day:dateSchema,kind:z.enum(['plan','review']),version:z.number().int()}).strict().parse(b);
 return transaction(d=>{
  const current=ensureDay(d,user,day,now);if(current.version!==version)fail(409,'页面已变化，请刷新后重试');
  const old=d.prepare('SELECT status FROM agent_jobs WHERE user_id=? AND idem=?').get(user,`${day}:${version}:${kind}`);
  let next=version;
  if(old&&['failed','cancelled','needs_review'].includes(old.status)){
   next++;d.prepare('UPDATE daily_days SET version=version+1,updated=? WHERE user_id=? AND day=?').run(now,user,day);
  }
  return generateIn(d,user,day,kind,next,now);
 });
}
function generateIn(d,user,day,kind,version,now){
 const r=ensureDay(d,user,day,now);if(r.version!==version)fail(409,'页面已变化，请刷新后重试');
 if(kind==='plan'&&r.confirmed)fail(409,'请先撤回当前计划，再重新生成');
 const ctx=context(d,user,day),prefix=`${day}:${version}:${kind}`;
 const common={context:ctx,instruction:'以共享数据为依据；缺失信息明确列出，不虚构完成情况。不诊断疾病，不执行外部操作。'};
 if(kind==='review')return {job_id:enqueue(d,user,{idem:prefix,action:'daily.review',day,version,payload:common},now)};
 // 阶段 3/4：逐域评估状态——正常/关注沿用已确认方案（不派分析）；资料不足/无有效方案重新分析；同一天已有未完成同类分析时不重复派发；每次生成写入触发审计。
 const confirmed={},states={};
 for(const domain of ['work','fitness','diet']){
  const st=assessDomain(d,user,domain,day,ctx,new Date(now));
  const dup=d.prepare("SELECT request,day FROM agent_jobs WHERE user_id=? AND status IN ('queued','running')").all(user).some(x=>{const rr=JSON.parse(x.request);return rr.action==='analysis.'+domain&&x.day===day});
  if(dup){st.reasons.push('当天已有未完成的同类分析任务，不重复派发');st.decision='reuse'}
  logDomainState(d,user,day,domain,st,new Date(now).toISOString());
  states[domain]=st;
  if(st.decision==='reuse'){const cur=currentPlan(d,user,domain);if(cur)confirmed[domain]=cur}
 }
 const analyze=domain=>states[domain].decision==='analyze';
 const work=analyze('work')?enqueue(d,user,{idem:prefix+':work',action:'analysis.work',day,version,payload:{...common,role:'目标与工作分析：权衡目标、截止时间、耗时与优先级，提出可执行建议。工作关键资料（目标/现状）未确认时列入 missing，不编造完成情况。'}},now):null;
 const fitness=analyze('fitness')?enqueue(d,user,{idem:prefix+':fitness',action:'analysis.fitness',day,version,payload:{...common,role:'健身方案：结合训练目标、现状与运动记录给出次日可行的训练安排（含时长），不诊断伤病。若训练目标、现状或限制等关键资料尚未确认（见 context.intake.fitness.required_missing / needs_review），在 missing 中列出并输出“暂无法制定完整方案”的候选，不编造训练内容。'}},now):null;
 const diet=analyze('diet')?enqueue(d,user,{idem:prefix+':diet',action:'analysis.diet',day,version,payload:{...common,role:'饮食方案：结合目标、习惯与预算给出次日可行的饮食安排，不设定医学结论。若饮食目标、习惯或限制等关键资料尚未确认（见 context.intake.diet.required_missing / needs_review），在 missing 中列出并输出“暂无法制定完整方案”的候选，不编造饮食安排。'}},now):null;
 const deps=[work,fitness,diet].filter(Boolean);
 return {job_id:enqueue(d,user,{idem:prefix,action:'daily.plan',day,version,dependencies:deps,payload:{...common,confirmed_plans:confirmed,domain_states:states,role:'统筹：综合已确认方案（confirmed_plans，直接引用其事项 id 作 source_id）与本次前置分析结果，形成唯一无冲突的计划草案。domain_states 说明各领域状态与沿用/分析原因。任务使用 UUID；每项须标明 domain（work/fitness/diet）和来源 source_id（引用被选中的方案事项 id），未选中的专业事项放入 deferred 并说明。时间预算由服务器校验：总耗时加机动不得超过已知可用时间；固定安排（context.day.input.fixed）占用的时间要计入预算，无法从文本解析时在 missing 中说明，不硬排精确时间槽。重要临时事项（context.records 中新增的 task/note 类记录）与昨日结转（carryover）优先纳入今日计划，避免无限拖延；核对清单（audit）中已完成或过期的记录仅作提示，周期事项照常安排。'}},now)};
}
export function updateDay(user,b,now=Date.now()){
 const v=z.object({day:dateSchema,version:z.number().int(),operation:z.enum(['input','feedback','confirm','reopen']),data:z.unknown().optional(),actor:z.string().max(80).optional()}).strict().parse(b);
 return transaction(d=>{const r=ensureDay(d,user,v.day,now);if(r.version!==v.version)fail(409,'数据已变化，请刷新后重试');
 if(v.operation==='input'){const input=inputSchema.parse(v.data);if(r.confirmed)fail(409,'请先撤回计划，再修改规划条件');d.prepare('UPDATE daily_days SET input=?,plan=NULL,review=NULL,fitness=NULL,diet=NULL,version=version+1,updated=? WHERE user_id=? AND day=?').run(JSON.stringify(input),now,user,v.day)}
 if(v.operation==='feedback'){
  if(!r.plan||!r.confirmed)fail(409,'请先确认计划');
  const data=z.object({item_id:z.string().uuid(),status:z.enum(['done','partial','skipped']),actual_minutes:z.number().int().min(0).max(1440).nullable(),note:z.string().max(2000)}).strict().parse(v.data);
  const item=JSON.parse(r.plan).items.find(x=>x.id===data.item_id);
  if(!item)fail(400,'计划中没有此事项');
  const feedback=JSON.parse(r.feedback);feedback[data.item_id]={...data,updated:now};d.prepare('UPDATE daily_days SET feedback=?,review=NULL,version=version+1,updated=? WHERE user_id=? AND day=?').run(JSON.stringify(feedback),now,user,v.day);
  // 阶段 6：明确反馈异常（未完成/部分完成）→ 该领域已确认方案标记需复核（幂等，无方案静默跳过）。
  // 复核只做标记，不自动重新分析；下一轮生成时由领域状态规则决定是否重新分析，普通波动不触发。
  if((data.status==='skipped'||data.status==='partial')&&item.domain){
   const iso=new Date(now).toISOString();
   d.prepare("UPDATE domain_plans SET status='needs_review',updated_at=? WHERE user_id=? AND domain=? AND status='confirmed' AND review_at>?").run(iso,user,item.domain,iso);
  }
 }
 if(v.operation==='confirm'){
  if(!r.plan)fail(409,'还没有计划草案');if(r.confirmed)return unpackDay(r);
  const plan=JSON.parse(r.plan);
  // 只从同一份确认快照（plan）派生三域展示与发布：统筹未选中的专业事项不发布、不展示。
  const byDomain=domain=>plan.items.filter(x=>x.domain===domain);
  const fitnessItems=byDomain('fitness'),dietItems=byDomain('diet');
  const prior=JSON.parse(r.fitness||'{}'),priorDiet=JSON.parse(r.diet||'{}');
  const fitnessSnapshot=fitnessItems.length?{summary:prior.summary||'训练安排',sessions:fitnessItems.map(i=>({id:i.source_id||i.id,title:i.title,minutes:i.minutes,reason:i.reason}))}:null;
  const dietSnapshot=dietItems.length?{summary:priorDiet.summary||'饮食安排',meals:dietItems.map(i=>({id:i.source_id||i.id,title:i.title,reason:i.reason}))}:null;
  d.prepare('UPDATE daily_days SET confirmed=1,fitness=?,diet=?,version=version+1,updated=? WHERE user_id=? AND day=?').run(fitnessSnapshot?JSON.stringify(fitnessSnapshot):null,dietSnapshot?JSON.stringify(dietSnapshot):null,now,user,v.day);
  if(settings(user,d).feishu){
   enqueue(d,user,{idem:`${v.day}:publish:${r.version+1}`,action:'feishu.publish',day:v.day,version:r.version+1,payload:{plan,instruction:'将已确认计划发布到飞书并创建待办。以任务 job_id 和事项 id 作去重标识，操作前查重；回传每个事项的外部 ID。部分成功后失败必须回传 needs_review 和已有回执，不能整批重做。'}},now);
   if(fitnessSnapshot)enqueue(d,user,{idem:`${v.day}:publish-fitness:${r.version+1}`,action:'feishu.publish.fitness',day:v.day,version:r.version+1,payload:{plan:fitnessSnapshot,instruction:'将已确认计划中选中的健身事项发布到飞书并创建训练清单（含每项时长）。按事项 id 查重；回传每个训练项的外部 ID；部分成功失败回传 needs_review 与已有回执。'}},now);
   if(dietSnapshot)enqueue(d,user,{idem:`${v.day}:publish-diet:${r.version+1}`,action:'feishu.publish.diet',day:v.day,version:r.version+1,payload:{plan:dietSnapshot,instruction:'将已确认计划中选中的饮食事项发布到飞书并创建饮食安排清单。按事项 id 查重；回传每个餐项的外部 ID；部分成功失败回传 needs_review 与已有回执。'}},now);
  }
  d.prepare('INSERT INTO agent_audit(user_id,event,job_id,created) VALUES(?,?,?,?)').run(user,'day.confirm:'+(v.actor||'website'),null,now);
 }
 if(v.operation==='reopen'){
  if(d.prepare("SELECT 1 FROM agent_jobs WHERE user_id=? AND day=? AND effect=1 AND status IN ('running','needs_review')").get(user,v.day))fail(409,'飞书操作尚在执行或待核对，请先处理该任务');
  if(d.prepare("SELECT 1 FROM agent_jobs WHERE user_id=? AND day=? AND effect=1 AND status='succeeded'").get(user,v.day))fail(409,'计划已发布到飞书，当前版本不支持自动修改已发布计划，请保留计划并记录反馈');
  d.prepare("UPDATE agent_jobs SET status='cancelled',updated=? WHERE user_id=? AND day=? AND status='queued'").run(now,user,v.day);
  d.prepare('UPDATE daily_days SET confirmed=0,plan=NULL,feedback=\'{}\',review=NULL,fitness=NULL,diet=NULL,version=version+1,updated=? WHERE user_id=? AND day=?').run(now,user,v.day);
  d.prepare('INSERT INTO agent_audit(user_id,event,job_id,created) VALUES(?,?,?,?)').run(user,'day.reopen:'+(v.actor||'website'),null,now);
 }
 return unpackDay(ensureDay(d,user,v.day,now));});
}
export function tick(now=Date.now()){
 return transaction(d=>{let n=0;for(const {id:user} of d.prepare('SELECT id FROM users').all()){
 const s=settings(user,d);if(!s.enabled)continue;
 const day=today(now),time=clockTime(now);
 for(const kind of ['plan','review']){
  if(time<s[kind+'_time'])continue;
  // 复盘针对今天；晚间规划明确针对明天，避免生成当天已过期计划。
  const target=kind==='plan'?nextDay(day):day;
  const r=ensureDay(d,user,target,now);
  if(kind==='plan'&&(r.plan||r.confirmed)||kind==='review'&&(!r.confirmed||r.review))continue;
  const marker=`schedule:${target}:${kind}`;
  const marked=d.prepare('SELECT 1 FROM agent_audit WHERE user_id=? AND event=?').get(user,marker);
  // New feedback/input invalidates older analysis. Schedule its current version once.
  if(d.prepare('SELECT 1 FROM agent_jobs WHERE user_id=? AND idem=?').get(user,`${target}:${r.version}:${kind}`))continue;
  generateIn(d,user,target,kind,r.version,now);
  if(!marked)d.prepare('INSERT INTO agent_audit(user_id,event,created) VALUES(?,?,?)').run(user,marker,now);n++;
 }
 }return {created:n};});
}
export function registerExecutor(user,key,b,now=Date.now()){
 const v=z.object({name:z.string().trim().min(1).max(80),capabilities:z.array(z.enum(['analysis','feishu'])).min(1).max(2),max_parallel:z.number().int().safe().min(1).default(1)}).strict().parse(b);
 const old=db().prepare('SELECT * FROM executors WHERE key_id=?').get(key);if(old&&!old.enabled)fail(403,'执行者已暂停，请在网站恢复');
 db().prepare('INSERT INTO executors(key_id,user_id,name,capabilities,max_parallel,last_seen) VALUES(?,?,?,?,?,?) ON CONFLICT(key_id) DO UPDATE SET name=excluded.name,capabilities=excluded.capabilities,max_parallel=excluded.max_parallel,last_seen=excluded.last_seen').run(key,user,v.name,JSON.stringify([...new Set(v.capabilities)]),v.max_parallel,now);
 return {executor_id:key,...v};
}
export function setExecutor(user,b){const v=z.object({key_id:z.string(),enabled:z.boolean(),max_parallel:z.number().int().safe().min(1)}).strict().parse(b);const r=db().prepare('UPDATE executors SET enabled=?,max_parallel=? WHERE key_id=? AND user_id=?').run(v.enabled?1:0,v.max_parallel,v.key_id,user);if(!r.changes)fail(404,'执行者不存在');return {ok:true}}
export function overview(user,day){dateSchema.parse(day);const ctx=context(db(),user,day);const executors=db().prepare('SELECT e.*,k.expires_at,k.name AS key_name FROM executors e LEFT JOIN api_keys k ON k.id=e.key_id WHERE e.user_id=?').all(user).map(r=>({...r,capabilities:JSON.parse(r.capabilities),online:!!r.expires_at&&r.expires_at>Date.now()&&!!r.enabled&&r.last_seen>Date.now()-180000}));return {day:ctx.day,carryover:ctx.carryover,settings:settings(user),executors};}
