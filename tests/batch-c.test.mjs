import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {db,closeDb} from '../server/database.mjs';
import {confirmPlan,currentPlan,adjustPlan,pendingAdjustments} from '../server/domain-plans.mjs';
import {domainState} from '../server/domain-state.mjs';

// 批次 C：整体验收串场——隔离 DB、模拟时钟、模拟外部服务（飞书发布由测试执行者回执），
// 按整改计划"整体验收场景"清单连续演一遍。
async function setup(){
 const dir=mkdtempSync(join(tmpdir(),'life-batchc-'));
 process.env.DATABASE_PATH=join(dir,'c.sqlite');
 const life=await import('../server/life.mjs');
 const q=await import('../server/agent-jobs.mjs');
 const intake=await import('../server/intake.mjs');
 let now=Date.now(),user='owner',k1='kb1',k2='kb2';
 db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'c@t.test','hash','date');
 db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run(k1,'h1',user,'AI1','write','date',now+365*86400000);
 db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run(k2,'h2',user,'AI2','write','date',now+365*86400000);
 life.registerExecutor(user,k1,{name:'AI1(飞书)',capabilities:['analysis','feishu'],max_parallel:6},now);
 life.registerExecutor(user,k2,{name:'AI2',capabilities:['analysis'],max_parallel:6},now);
 life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:true,domain_review_days:{work:7,fitness:7,diet:7},auto_adjust:{enabled:true,overrun_factor:2,energy_drop_threshold:2,skip_carryover:true}},now);
 // 只提供部分资料：work 齐，fitness/diet 缺（由 AI 沟通补齐）
 const answer=(dom,f,v)=>{const fd=intake.intakeOverview(user,dom,db()).fields.find(x=>x.key===f);intake.updateIntake(user,'website',{request_id:randomUUID(),domain:dom,field_key:f,token:fd.token,operation:'answer',answer:v},++now)};
 answer('work','work.goal','完成上线');answer('work','work.current','开发中');answer('work','shared.time','晚上有空');
 return {dir,life,q,intake,user,k1,k2,t:()=>++now};
}
const outFor=(j,ids)=>{
 if(j.action==='analysis.work'){const id=randomUUID();ids.work.push(id);return {summary:'工作',items:[{id,title:'推进项目',reason:'w'}],missing:[]}}
 if(j.action==='analysis.fitness'){const id=randomUUID();ids.fitness.push(id);return {summary:'训练',sessions:[{id,title:'力量训练',minutes:30,reason:'g'}],missing:[]}}
 if(j.action==='analysis.diet'){const id=randomUUID();ids.diet.push(id);return {summary:'饮食',meals:[{id,title:'早餐',reason:'g'}],missing:[]}}
 return null;
};
// 跑一天：generate→领一个提交一个→统筹提交→confirm。key 可指定（模拟执行者更换）。
async function runDay(s,day,{key,budget=90,confirm=true,confirmPlans=true,skipAnalyses=false,skipSubmitPlan=false,extraClaim=false}={}){
 const {life,q,user,t}=s;const k=key||s.k1;
 let d=life.overview(user,day).day;d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:budget,energy:3,fixed:'',note:''}},t());
 life.generate(user,{day,kind:'plan',version:d.version},t());
 const ids={work:[],fitness:[],diet:[]};let plan=null;const analyses=[];const claimed=[];
 for(let i=0;i<16&&!plan;i++){
  const j=q.claimJob(user,k,{},t()).job;if(!j)break;
  if(j.action==='daily.plan'){plan=j;break}
  if(j.action.startsWith('analysis.'))analyses.push(j.action);
  const out=outFor(j,ids);
  if(out===null){claimed.push(j);continue} // 非分析/非统筹任务（如 intake/feishu），留待专门处理
  if(extraClaim&&j.action==='analysis.work'){claimed.push(j);continue} // 执行中不提交（模拟正在执行）
  q.updateJob(user,k,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},t());
 }
 assert.ok(plan,'统筹任务可领取（'+day+'）');
 const p={summary:'计划'+day,items:[{id:randomUUID(),title:'推进项目',minutes:budget-20,reason:'w',domain:'work',source_id:ids.work[0]||null},{id:randomUUID(),title:'力量训练',minutes:15,reason:'g',domain:'fitness',source_id:ids.fitness[0]||null},{id:randomUUID(),title:'早餐',minutes:5,reason:'g',domain:'diet',source_id:ids.diet[0]||null}],buffer_minutes:0,deferred:[],missing:[]};
 if(!skipSubmitPlan)q.updateJob(user,k,plan.job_id,'result',{lease_token:plan.lease_token,status:'succeeded',output:p},t());
 d=life.overview(user,day).day;
 if(confirm&&!skipSubmitPlan){life.updateDay(user,{day,version:d.version,operation:'confirm',data:{}},t())}
 if(confirmPlans&&!skipSubmitPlan){confirmPlan(user,'work',1,'website');confirmPlan(user,'fitness',1,'website');confirmPlan(user,'diet',1,'website')}
 const planRow=db().prepare('SELECT plan FROM daily_days WHERE user_id=? AND day=?').get(user,day).plan;
 return {day,ids,plan,analyses,claimed,planRow:planRow?JSON.parse(planRow):null,planPayload:p};
}
// 执行已确认计划产生的飞书发布任务（模拟外部服务回执）
function publishAll(s,day,{partial=false,drop=null}={}){
 const {q,user,t}=s;const k=s.k1;const out=[];
 for(let i=0;i<8;i++){
  const j=q.claimJob(user,k,{},t()).job;if(!j)break;
  if(!j.action.startsWith('feishu.publish')){q.updateJob(user,k,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:{simulated:true,external_effect:false}},t());continue}
  const key=j.action==='feishu.publish.fitness'?'sessions':j.action==='feishu.publish.diet'?'meals':'items';
  const ids=(j.payload?.plan?.[key]||[]).map(x=>x.id);
  if(drop&&j.action===drop){out.push({action:j.action,status:'dropped'});continue} // 回传丢失：不提交
  if(partial&&ids.length>1){ // 部分成功
   q.updateJob(user,k,j.job_id,'result',{lease_token:j.lease_token,status:'needs_review',output:{external_effect:true,error:'部分成功',receipts:ids.slice(0,ids.length-1).map(id=>({item_id:id,external_id:'ext-'+id}))}},t());
   out.push({action:j.action,status:'needs_review',ids});
  }else{
   q.updateJob(user,k,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:{external_effect:true,receipts:ids.map(id=>({item_id:id,external_id:'ext-'+id}))}},t());
   out.push({action:j.action,status:'succeeded',ids});
  }
 }
 return out;
}

test('C: 整体验收——部分资料提问/换执行者接续/数日沿用/依赖更新/异常域/发布回执/回传丢失重启/无过期覆盖',async()=>{
 const s=await setup();const {life,q,intake,user,k1,k2,t}=s;
 try{
  // —— 阶段 1：部分资料 → AI 提问；换执行者接续，不重复询问已知 ——
  const overview1=intake.intakeOverview(user,'fitness',db());
  const ctxHash1=overview1.context_hash;
  const ijob=intake.startIntake(user,{domain:'fitness',context_hash:ctxHash1},t());
  assert.ok(ijob.job_id,'fitness 资料沟通任务已创建');
  const claimed=q.claimJob(user,k1,{},t()).job;
  assert.equal(claimed.action,'intake.fitness','AI1 领取资料沟通任务');
  const questions=claimed.payload?.context?.fields?.filter((f)=>f.status!=='known'&&f.status!=='deferred').map((f)=>f.key)||[];
  const q1=questions[0];
  assert.ok(q1,'沟通任务输出待问字段（用户只提供了 work 资料）');
  // 用户回答一个问题（fitness.goal）
  const fd=intake.intakeOverview(user,'fitness',db()).fields.find((x)=>x.key==='fitness.goal');
  intake.updateIntake(user,'website',{request_id:randomUUID(),domain:'fitness',field_key:'fitness.goal',token:fd.token,operation:'answer',answer:'增肌'},t());
  // 换执行者 AI2 接续：新一轮沟通不得重复询问已答的 goal
  const ctxHash2=intake.intakeOverview(user,'fitness',db()).context_hash;
  const ijob2=intake.startIntake(user,{domain:'fitness',context_hash:ctxHash2},t());
  const claimed2=q.claimJob(user,k2,{},t()).job;
  assert.equal(claimed2.action,'intake.fitness','AI2 接续领取资料沟通任务');
  const fields2=claimed2.payload?.context?.fields?.filter((f)=>f.status!=='known'&&f.status!=='deferred')||[];
  assert.ok(!fields2.some((f)=>f.key==='fitness.goal'),'AI2 不重复询问已知信息（goal 已答）');
  // 用户答齐 fitness 与 diet
  for(const [dom,fields] of [['fitness',[['fitness.baseline','每周三次'],['fitness.constraints','无限制']]],['diet',[['diet.goal','控体重'],['diet.routine','自己做'],['diet.constraints','无忌口']]]]){
   for(const [f,v] of fields){const ff=intake.intakeOverview(user,dom,db()).fields.find((x)=>x.key===f);intake.updateIntake(user,'website',{request_id:randomUUID(),domain:dom,field_key:f,token:ff.token,operation:'answer',answer:v},t())}
  }
  const fitSnap=intake.intakeStatus(db(),user);
  assert.equal(fitSnap.fitness.required_missing.length,0,'fitness 关键资料齐（goal/baseline/constraints）');
  // —— 阶段 2：首日三域生成并确认方案 ——
  const d1=await runDay(s,'2026-10-25');
  assert.deepEqual(d1.analyses.sort(),['analysis.diet','analysis.fitness','analysis.work'].sort(),'三域同时首次分析');
  for(const dom of ['work','fitness','diet']){
   assert.ok(currentPlan(db(),user,dom),dom+' 方案已确认');
  }
  // 确认后发布任务产生（模拟外部服务：整日+健身+饮食）
  const pub1=publishAll(s,'2026-10-25');
  assert.equal(pub1.filter((x)=>x.action.startsWith('feishu.publish')).length,3,'确认后产生 3 个发布任务');
  assert.equal(life.publishReceipts(user,'2026-10-25',db()).receipts.filter((x)=>x.status==='succeeded').length>=3,true,'发布回执持久化');
  // —— 阶段 3：连续数日正常沿用 ——
  const d2=await runDay(s,'2026-10-26',{confirmPlans:false});
  assert.deepEqual(d2.analyses,[],'正常沿用不派发领域分析');
  publishAll(s,'2026-10-26'); // 清掉当日确认产生的发布任务
  // —— 阶段 4：修改可用时间且存在执行中的分析 → 依赖正确更新，过期结果被拒 ——
  adjustPlan(user,'diet','饮食方案需调整','website',new Date(t()).toISOString()); // 制造 diet 待重算（执行中的分析）
  let d=life.overview(user,'2026-10-27').day;d=life.updateDay(user,{day:'2026-10-27',version:d.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},t());
  life.generate(user,{day:'2026-10-27',kind:'plan',version:d.version},t());
  const held=q.claimJob(user,k1,{},t()).job;
  assert.ok(held&&held.action==='analysis.diet','已领取执行中的分析任务');
  // 执行中改可用时间 → 版本变化
  d=life.overview(user,'2026-10-27').day;life.updateDay(user,{day:'2026-10-27',version:d.version,operation:'input',data:{available_minutes:60,energy:3,fixed:'',note:''}},t());
  // 旧任务回传被拒（已失效/版本过期），不回写
  assert.throws(()=>q.updateJob(user,k1,held.job_id,'result',{lease_token:held.lease_token,status:'succeeded',output:{summary:'x',items:[],missing:[]}},t()),/409|任务已结束|已变化|失效/,'执行中改资料后旧分析结果被拒绝');
  const d3=await runDay(s,'2026-10-27',{budget:60,confirmPlans:false});
  assert.ok(d3.planRow.items.every((it)=>it.minutes<=60-20+20),'新版本统筹按新预算形成');
  publishAll(s,'2026-10-27'); // 清掉当日确认产生的发布任务
  // —— 阶段 5：单次未完成不废弃方案 ——
  d=life.overview(user,'2026-10-27').day;
  const fitItem=d3.planRow.items.find((x)=>x.domain==='fitness');
  life.updateDay(user,{day:'2026-10-27',version:d.version,operation:'feedback',data:{item_id:fitItem.id,status:'skipped',actual_minutes:null,note:'临时有事'}},t());
  assert.ok(currentPlan(db(),user,'fitness'),'单次未完成不废弃健身方案');
  assert.equal(db().prepare("SELECT 1 FROM domain_plans WHERE user_id=? AND domain='fitness' AND status='needs_review'").get(user),undefined,'不因单次未完成标 needs_review');
  // —— 阶段 6：调整请求 → 只分析受影响领域 ——
  // 阶段 4 的可用时间变化触发了 diet 重算并生成 candidate v2；确认后回到正常沿用（只让 fitness 单独触发重算）
  const dietVersions=db().prepare('SELECT version,status FROM domain_plans WHERE user_id=? AND domain=? ORDER BY version').all(user,'diet');
  const dietLatest=dietVersions[dietVersions.length-1];
  if(dietLatest&&dietLatest.status!=='confirmed')confirmPlan(user,'diet',dietLatest.version,'website');
  adjustPlan(user,'fitness','膝盖不适，训练需减量','website',new Date(t()).toISOString());
  assert.equal(pendingAdjustments(db(),user,'fitness',new Date(t()+1000).toISOString()).length,1,'调整请求持久化');
  const d4=await runDay(s,'2026-10-28',{confirm:false,confirmPlans:false});
  assert.ok(d4.analyses.includes('analysis.fitness'),'调整请求触发健身域重算');
  assert.ok(!d4.analyses.includes('analysis.work')&&!d4.analyses.includes('analysis.diet'),'其他域不受影响沿用');
  const st=domainState(user,{day:'2026-10-28'},db());
  assert.ok(st.current.every((x,i,a)=>a.findIndex((y)=>y.domain===x.domain)===i),'current 每域仅一条（最新判断，不含过期评估）');
  assert.equal(st.current.filter((x)=>x.domain==='fitness').length,1,'current fitness 唯一');
  const fit=st.domains.find((x)=>x.domain==='fitness');
  assert.equal(fit.state,'adjust');
  assert.ok(fit.signals.some((x)=>x.source==='adjust'),'调整信号可查询');
  assert.equal(fit.pending_adjustments,1,'pending 明细可查');
  // 重算成功提交后调整请求标记 handled，原因不丢失
  const handled=db().prepare("SELECT reason,status,handled_by FROM plan_adjustments WHERE user_id=? AND domain='fitness'").all(user);
  assert.equal(handled.filter((x)=>x.status==='handled').length,1,'分析成功后调整请求标记已处理');
  assert.ok(handled.some((x)=>x.reason==='膝盖不适，训练需减量'),'调整原因不丢失');
  assert.ok(handled.some((x)=>x.handled_by&&x.handled_by.includes('analysis:')),'处理人记录分析任务');
  // —— 阶段 7：确认后发布，部分成功只补缺失、重复确认不新建发布批次 ——
  const d4b=await runDay(s,'2026-10-28',{confirm:false,confirmPlans:false});
  d=life.overview(user,'2026-10-28').day;
  // 提交统筹并确认（用第一次 runDay 的统筹结果已被 confirm=false 跳过；此处确认当前草案）
  if(!d.confirmed){
   life.updateDay(user,{day:'2026-10-28',version:d.version,operation:'confirm',data:{}},t());
   for(const dom of ['work','fitness','diet']){
    const rows=db().prepare('SELECT version,status FROM domain_plans WHERE user_id=? AND domain=? ORDER BY version DESC').all(user,dom);
    const latest=rows[0];
    if(latest&&latest.status!=='confirmed')confirmPlan(user,dom,latest.version,'website');
   }
  }
  const pub2=publishAll(s,'2026-10-28',{partial:true});
  const partialJob=pub2.find((x)=>x.status==='needs_review');
  assert.ok(partialJob,'部分成功场景出现');
  const recs=life.publishReceipts(user,'2026-10-28',db()).receipts.filter((x)=>x.action===partialJob.action);
  const missingCount=partialJob.ids.length-recs.filter((x)=>x.status==='succeeded').length;
  assert.equal(recs.filter((x)=>x.status==='unknown').length,missingCount,'未回执事项标记 unknown（只补缺失）');
  assert.equal(recs.filter((x)=>x.status==='succeeded').length,partialJob.ids.length-1,'已成功回执持久化');
  // 重复确认不新建发布批次
  const before=db().prepare("SELECT COUNT(*) n FROM agent_jobs WHERE user_id=? AND day=? AND json_extract(request,'$.action') LIKE ?").get(user,'2026-10-28','feishu.publish%').n;
  d=life.overview(user,'2026-10-28').day;life.updateDay(user,{day:'2026-10-28',version:d.version,operation:'confirm',data:{}},t());
  const after=db().prepare("SELECT COUNT(*) n FROM agent_jobs WHERE user_id=? AND day=? AND json_extract(request,'$.action') LIKE ?").get(user,'2026-10-28','feishu.publish%').n;
  assert.equal(after,before,'重复确认不新建发布批次');
  // —— 阶段 8：回传丢失 → active 恢复；执行者更换不能拿到他人任务；重启后任务状态保持 ——
  const d8=await runDay(s,'2026-10-29',{confirm:false,confirmPlans:false,skipSubmitPlan:true});
  assert.ok(d8.plan,'统筹任务已领取（模拟回传丢失，不提交）');
  const active1=q.activeJobs(user,k1).jobs;
  assert.ok(active1.some((x)=>x.job_id===d8.plan.job_id),'原执行者可恢复丢失回传的任务（GET /jobs/active 返回原租约）');
  const active2=q.activeJobs(user,k2).jobs;
  assert.ok(!active2.some((x)=>x.job_id===d8.plan.job_id),'执行者更换（AI2）拿不到 AI1 的 running 任务');
  const dayBeforeRestart=life.overview(user,'2026-10-29');
  closeDb(); // 模拟重启：关闭数据库连接
  db();
  const dayAfterRestart=life.overview(user,'2026-10-29');
  assert.deepEqual(dayAfterRestart.day.version,dayBeforeRestart.day.version,'重启后当日数据版本保持');
  assert.equal(db().prepare('SELECT status FROM agent_jobs WHERE id=?').get(d8.plan.job_id).status,'running','重启后任务状态保持（结果不明不自动重做）');
  // 重启后原执行者补交（用原租约；租约未过期）
  q.updateJob(user,k1,d8.plan.job_id,'result',{lease_token:d8.plan.lease_token,status:'succeeded',output:d8.planPayload},t());
  // —— 阶段 9：同输入复用不重复派发分析（无重复待办）；无过期结果覆盖 ——
  const d9=life.overview(user,'2026-10-29').day;
  life.generate(user,{day:'2026-10-29',kind:'plan',version:d9.version},t());
  const dupAna=db().prepare("SELECT COUNT(*) n FROM agent_jobs WHERE user_id=? AND day=? AND json_extract(request,'$.action') LIKE 'analysis.%'").get(user,'2026-10-29').n;
  assert.equal(dupAna,0,'同输入重复生成不派发重复分析（分析复用）');
  const dup=db().prepare("SELECT COUNT(*) n FROM agent_jobs WHERE user_id=? AND day=? AND json_extract(request,'$.action')='daily.plan' AND status IN ('queued','running')").get(user,'2026-10-29');
  assert.equal(dup.n,1,'无重复待办堆积（旧统筹已完结，仅新统筹待处理）');
  const d9b=life.overview(user,'2026-10-29').day;
  assert.equal(d9b.version,d9.version,'同输入重复生成不推进版本（无过期覆盖）');
 }finally{closeDb();rmSync(s.dir,{recursive:true,force:true})}
});
