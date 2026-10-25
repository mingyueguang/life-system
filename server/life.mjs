import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {db,transaction} from './database.mjs';
import {HttpError} from './auth.mjs';
import {auditContext} from './audit.mjs';
export const fail=(s,m)=>{throw new HttpError(s,m)};
export const canon=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const dateSchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s);
const text=z.string().trim().min(1).max(2000);
export const today=(now=Date.now())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export const clockTime=(now=Date.now())=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(now));
const inputSchema=z.object({available_minutes:z.number().int().min(0).max(1440).nullable().default(null),energy:z.number().int().min(1).max(5).nullable().default(null),fixed:z.string().max(4000).default(''),note:z.string().max(4000).default('')}).strict();
const itemSchema=z.object({id:z.string().uuid(),title:text,minutes:z.number().int().min(1).max(1440),reason:text,task_id:z.string().uuid().nullable().default(null)}).strict();
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
export function saveSettings(user,b){const value=settingsSchema.parse({...b,auto_adjust:{...settingsDefaults.auto_adjust,...(b.auto_adjust||{})}});db().prepare('INSERT INTO life_settings VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body').run(user,JSON.stringify(value));return value}
export function ensureDay(d,user,day,now){dateSchema.parse(day);d.prepare("INSERT OR IGNORE INTO daily_days(user_id,day,input,updated) VALUES(?,?,?,?)").run(user,day,JSON.stringify(inputSchema.parse({})),now);return d.prepare('SELECT * FROM daily_days WHERE user_id=? AND day=?').get(user,day)}
export function unpackDay(r){return {...r,input:JSON.parse(r.input),plan:r.plan?JSON.parse(r.plan):null,feedback:JSON.parse(r.feedback),review:r.review?JSON.parse(r.review):null,fitness:r.fitness?JSON.parse(r.fitness):null,diet:r.diet?JSON.parse(r.diet):null,confirmed:!!r.confirmed}}
export function records(d,user){return d.prepare("SELECT id,kind,payload,version FROM records WHERE user_id=? AND deleted=0 AND kind IN ('goal','task','sleep','exercise','intake','environment','phone_usage','mood') ORDER BY id").all(user).map(r=>({id:r.id,kind:r.kind,version:r.version,data:JSON.parse(r.payload)}))}
export const fingerprint=r=>createHash('sha256').update(canon(r)).digest('hex');
export function context(d,user,day){const current=unpackDay(ensureDay(d,user,day,Date.now()));const recent=d.prepare('SELECT * FROM daily_days WHERE user_id=? AND day<? ORDER BY day DESC LIMIT 7').all(user,day).map(unpackDay);const all=records(d,user);const s=settings(user,d);const audit=auditContext(d,user,day,{all,recent,adjust:s.auto_adjust});return {day:{...current,audit:audit.issues,anomalies:audit.anomalies},recent,records:all,records_version:fingerprint(all),guards:audit.guards,carryover:audit.carryover}}
 export function enqueue(d,user,{idem,action,payload={},dependencies=[],day=null,version=null,target='*'},now){
 const old=d.prepare('SELECT id FROM agent_jobs WHERE user_id=? AND idem=?').get(user,idem);if(old)return old.id;
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
 const work=enqueue(d,user,{idem:prefix+':work',action:'analysis.work',day,version,payload:{...common,role:'目标与工作分析：权衡目标、截止时间、耗时与优先级，提出可执行建议。'}},now);
 const fitness=enqueue(d,user,{idem:prefix+':fitness',action:'analysis.fitness',day,version,payload:{...common,role:'健身方案：结合训练目标、现状与运动记录给出次日可行的训练安排（含时长），不诊断伤病。'}},now);
 const diet=enqueue(d,user,{idem:prefix+':diet',action:'analysis.diet',day,version,payload:{...common,role:'饮食方案：结合目标、习惯与预算给出次日可行的饮食安排，不设定医学结论。'}},now);
 return {job_id:enqueue(d,user,{idem:prefix,action:'daily.plan',day,version,dependencies:[work,fitness,diet],payload:{...common,role:'统筹：综合工作/健身/饮食三份前置方案与核对清单，形成唯一无冲突的计划草案。任务使用 UUID；总耗时加机动时间不得超过已知可用时间；未知时间写入 missing。优先考虑昨日未完成结转事项（carryover）并纳入今天计划，避免无限拖延；核对清单（audit）中已完成或过期的记录仅作提示，周期事项照常安排。'}},now)};
}
export function updateDay(user,b,now=Date.now()){
 const v=z.object({day:dateSchema,version:z.number().int(),operation:z.enum(['input','feedback','confirm','reopen']),data:z.unknown().optional()}).strict().parse(b);
 return transaction(d=>{const r=ensureDay(d,user,v.day,now);if(r.version!==v.version)fail(409,'数据已变化，请刷新后重试');
 if(v.operation==='input'){const input=inputSchema.parse(v.data);if(r.confirmed)fail(409,'请先撤回计划，再修改规划条件');d.prepare('UPDATE daily_days SET input=?,plan=NULL,review=NULL,version=version+1,updated=? WHERE user_id=? AND day=?').run(JSON.stringify(input),now,user,v.day)}
 if(v.operation==='feedback'){
  if(!r.plan||!r.confirmed)fail(409,'请先确认计划');
  const data=z.object({item_id:z.string().uuid(),status:z.enum(['done','partial','skipped']),actual_minutes:z.number().int().min(0).max(1440).nullable(),note:z.string().max(2000)}).strict().parse(v.data);
  if(!JSON.parse(r.plan).items.some(x=>x.id===data.item_id))fail(400,'计划中没有此事项');
  const feedback=JSON.parse(r.feedback);feedback[data.item_id]={...data,updated:now};d.prepare('UPDATE daily_days SET feedback=?,review=NULL,version=version+1,updated=? WHERE user_id=? AND day=?').run(JSON.stringify(feedback),now,user,v.day);
 }
 if(v.operation==='confirm'){
  if(!r.plan)fail(409,'还没有计划草案');if(r.confirmed)return unpackDay(r);
  d.prepare('UPDATE daily_days SET confirmed=1,version=version+1,updated=? WHERE user_id=? AND day=?').run(now,user,v.day);
  if(settings(user,d).feishu){
   const plan=JSON.parse(r.plan);
   enqueue(d,user,{idem:`${v.day}:publish:${r.version+1}`,action:'feishu.publish',day:v.day,version:r.version+1,payload:{plan,instruction:'将已确认计划发布到飞书并创建待办。以任务 job_id 和事项 id 作去重标识，操作前查重；回传每个事项的外部 ID。部分成功后失败必须回传 needs_review 和已有回执，不能整批重做。'}},now);
   if(r.fitness)enqueue(d,user,{idem:`${v.day}:publish-fitness:${r.version+1}`,action:'feishu.publish.fitness',day:v.day,version:r.version+1,payload:{plan:JSON.parse(r.fitness),instruction:'将当日健身方案发布到飞书并创建训练清单（含每项时长）。按事项 id 查重；回传每个训练项的外部 ID；部分成功失败回传 needs_review 与已有回执。'}},now);
   if(r.diet)enqueue(d,user,{idem:`${v.day}:publish-diet:${r.version+1}`,action:'feishu.publish.diet',day:v.day,version:r.version+1,payload:{plan:JSON.parse(r.diet),instruction:'将当日饮食方案发布到飞书并创建饮食安排清单。按事项 id 查重；回传每个餐项的外部 ID；部分成功失败回传 needs_review 与已有回执。'}},now);
  }
 }
 if(v.operation==='reopen'){
  if(d.prepare("SELECT 1 FROM agent_jobs WHERE user_id=? AND day=? AND effect=1 AND status IN ('running','needs_review')").get(user,v.day))fail(409,'飞书操作尚在执行或待核对，请先处理该任务');
  if(d.prepare("SELECT 1 FROM agent_jobs WHERE user_id=? AND day=? AND effect=1 AND status='succeeded'").get(user,v.day))fail(409,'计划已发布到飞书，当前版本不支持自动修改已发布计划，请保留计划并记录反馈');
  d.prepare("UPDATE agent_jobs SET status='cancelled',updated=? WHERE user_id=? AND day=? AND status='queued'").run(now,user,v.day);
  d.prepare('UPDATE daily_days SET confirmed=0,plan=NULL,feedback=\'{}\',review=NULL,version=version+1,updated=? WHERE user_id=? AND day=?').run(now,user,v.day);
 }
 return unpackDay(ensureDay(d,user,v.day,now));});
}
export function tick(now=Date.now()){
 return transaction(d=>{let n=0;for(const {id:user} of d.prepare('SELECT id FROM users').all()){
 const s=settings(user,d);if(!s.enabled)continue;const day=today(now),r=ensureDay(d,user,day,now),time=clockTime(now);
 for(const kind of ['plan','review']){
  if(time<s[kind+'_time']||kind==='plan'&&(r.plan||r.confirmed)||kind==='review'&&(!r.confirmed||r.review))continue;
  const marker=`schedule:${day}:${kind}`;
  const marked=d.prepare('SELECT 1 FROM agent_audit WHERE user_id=? AND event=?').get(user,marker);
  // New feedback/input invalidates older analysis. Schedule its current version once.
  if(d.prepare('SELECT 1 FROM agent_jobs WHERE user_id=? AND idem=?').get(user,`${day}:${r.version}:${kind}`))continue;
  generateIn(d,user,day,kind,r.version,now);
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
