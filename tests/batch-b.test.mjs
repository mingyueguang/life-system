import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {db,closeDb} from '../server/database.mjs';
import {confirmPlan,currentPlan,adjustPlan,pendingAdjustments} from '../server/domain-plans.mjs';
import {domainState} from '../server/domain-state.mjs';

// 批次 B 专项测试：状态驱动分析（第四步）+ 统一统筹与外部执行（第五步）
async function setup({feishu=false}){
 const dir=mkdtempSync(join(tmpdir(),'life-batchb-'));
 process.env.DATABASE_PATH=join(dir,'b.sqlite');
 const life=await import('../server/life.mjs');
 const q=await import('../server/agent-jobs.mjs');
 const intake=await import('../server/intake.mjs');
 let now=Date.now(),user='owner',key='kb';
 db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'b@t.test','hash','date');
 db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run(key,'hb',user,'AI','write','date',now+365*86400000);
 life.registerExecutor(user,key,{name:'AI',capabilities:['analysis',...(feishu?['feishu']:[])],max_parallel:6},now);
 life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu,domain_review_days:{work:7,fitness:7,diet:7},auto_adjust:{enabled:true,overrun_factor:2,energy_drop_threshold:2,skip_carryover:true}},now);
 const answer=(dom,f,v)=>{const fd=intake.intakeOverview(user,dom,db()).fields.find(x=>x.key===f);intake.updateIntake(user,'website',{request_id:randomUUID(),domain:dom,field_key:f,token:fd.token,operation:'answer',answer:v},++now)};
 answer('work','work.goal','完成上线');answer('work','work.current','开发中');answer('work','shared.time','晚上有空');
 answer('fitness','fitness.goal','增肌');answer('fitness','fitness.baseline','每周三次');answer('fitness','fitness.constraints','无限制');
 answer('diet','diet.goal','控体重');answer('diet','diet.routine','自己做');answer('diet','diet.constraints','无忌口');
 return {dir,life,q,intake,user,key,t:()=>++now};
}
// 执行某个 day 的分析任务（已领取的任务列表），提交对应域输出，返回本日新生成的事项 ID 映射
function submitAnalyses(q,user,key,nowFn,jobs){
 const ids={work:[],fitness:[],diet:[]};
 for(const j of jobs){
  let out;
  if(j.action==='analysis.work'){const id=randomUUID();ids.work.push(id);out={summary:'工作',items:[{id,title:'推进项目',reason:'w'}],missing:[]}}
  else if(j.action==='analysis.fitness'){const id=randomUUID();ids.fitness.push(id);out={summary:'训练',sessions:[{id,title:'力量训练',minutes:30,reason:'g'}],missing:[]}}
  else if(j.action==='analysis.diet'){const id=randomUUID();ids.diet.push(id);out={summary:'饮食',meals:[{id,title:'早餐',reason:'g'}],missing:[]}}
  else continue;
  q.updateJob(user,key,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},nowFn());
 }
 return ids;
}
// 首日：补资料→输入→generate→领完分析→提交→领 plan→提交→确认三域方案。返回本日捕获的 ID 与 plan 任务
async function day1Full(s,{planItems=null,budget=90,confirm=true}={}){
 const {life,q,user,key,t}=s;
 const day='2026-10-25';
 let d=life.overview(user,day).day;d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:budget,energy:3,fixed:'',note:''}},t());
 life.generate(user,{day,kind:'plan',version:d.version},t());
 const ids={work:[],fitness:[],diet:[]};
 let plan=null;
 for(let i=0;i<12&&!plan;i++){
  const j=q.claimJob(user,key,{},t()).job;if(!j)break;
  if(j.action==='daily.plan'){plan=j;break}
  // 领一个提交一个，及时释放执行额度，保证统筹任务可领取
  let out;
  if(j.action==='analysis.work'){const id=randomUUID();ids.work.push(id);out={summary:'工作',items:[{id,title:'推进项目',reason:'w'}],missing:[]}}
  else if(j.action==='analysis.fitness'){const id=randomUUID();ids.fitness.push(id);out={summary:'训练',sessions:[{id,title:'力量训练',minutes:30,reason:'g'}],missing:[]}}
  else if(j.action==='analysis.diet'){const id=randomUUID();ids.diet.push(id);out={summary:'饮食',meals:[{id,title:'早餐',reason:'g'}],missing:[]}}
  else continue;
  q.updateJob(user,key,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},t());
 }
 assert.ok(plan,'统筹任务可领取');
 const p=planItems||{summary:'首日计划',items:[{id:randomUUID(),title:'推进项目',minutes:budget-20,reason:'w',domain:'work',source_id:ids.work[0]||null},{id:randomUUID(),title:'力量训练',minutes:15,reason:'g',domain:'fitness',source_id:ids.fitness[0]||null},{id:randomUUID(),title:'早餐',minutes:5,reason:'g',domain:'diet',source_id:ids.diet[0]||null}],buffer_minutes:0,deferred:[],missing:[]};
 q.updateJob(user,key,plan.job_id,'result',{lease_token:plan.lease_token,status:'succeeded',output:p},t());
 d=life.overview(user,day).day;life.updateDay(user,{day,version:d.version,operation:'confirm',data:{}},t());
 if(confirm){confirmPlan(user,'work',1,'website');confirmPlan(user,'fitness',1,'website');confirmPlan(user,'diet',1,'website')}
 return {day,ids,plan,p};
}
// 后续日：generate→领 plan→提交 plan（无分析任务，因为三域已确认）
async function laterDay(s,day,planItems,budget=90,patchNewId=null){
 const {life,q,user,key,t}=s;
 let d=life.overview(user,day).day;d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:budget,energy:3,fixed:'',note:''}},t());
 life.generate(user,{day,kind:'plan',version:d.version},t());
 let plan=null;const analyses=[];const newIds={work:null,fitness:null,diet:null};
 for(let i=0;i<12&&!plan;i++){
  const j=q.claimJob(user,key,{},t()).job;if(!j)break;
  if(j.action==='daily.plan'){plan=j;break}
  if(j.action.startsWith('analysis.'))analyses.push(j.action);
  // 意外产生的分析任务提交空候选并记录其 ID（计划如需引用该域来源时用新 ID），避免阻塞
  let out;
  if(j.action==='analysis.fitness'){const id=randomUUID();newIds.fitness=id;out={summary:'候选',sessions:[{id,title:'力量训练新',minutes:30,reason:'g'}],missing:['候选']}}
  else if(j.action==='analysis.diet'){const id=randomUUID();newIds.diet=id;out={summary:'候选',meals:[{id,title:'y',reason:'g'}],missing:['候选']}}
  else if(j.action==='analysis.work'){const id=randomUUID();newIds.work=id;out={summary:'候选',items:[{id,title:'z',reason:'w'}],missing:[]}}
  else continue;
  q.updateJob(user,key,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},t());
 }
 assert.ok(plan,'统筹任务可领取（'+day+'）');
 for(const it of planItems.items){if(patchNewId&&patchNewId(newIds)&&newIds[it.domain]){it.source_id=newIds[it.domain]}}
 q.updateJob(user,key,plan.job_id,'result',{lease_token:plan.lease_token,status:'succeeded',output:planItems},t());
 const row=db().prepare('SELECT plan FROM daily_days WHERE user_id=? AND day=?').get(user,day);
 return {analyses,plan,planRow:row.plan?JSON.parse(row.plan):null,instruction:plan.payload?.role||'',newIds};
}
const planWith=(ids,budget)=>({summary:'沿用计划',items:[{id:randomUUID(),title:'推进项目',minutes:budget-20,reason:'w',domain:'work',source_id:ids.work[0]},{id:randomUUID(),title:'力量训练',minutes:15,reason:'沿用',domain:'fitness',source_id:ids.fitness[0]},{id:randomUUID(),title:'早餐',minutes:5,reason:'沿用',domain:'diet',source_id:ids.diet[0]}],buffer_minutes:0,deferred:[],missing:[]});

test('B1: 单次未完成不废弃领域方案——沿用+结转，不触发重算',async()=>{
 const s=await setup({});const {life,q,user,key,t}=s;
 try{
  const d1=await day1Full(s);
  // 次日：正常沿用，无分析；执行中单次未完成（skipped）
  const day2='2026-10-26';
  const r2=await laterDay(s,day2,planWith(d1.ids,90));
  assert.deepEqual(r2.analyses,[],'正常沿用不派发任何领域分析');
  let d=life.overview(user,day2).day;life.updateDay(user,{day:day2,version:d.version,operation:'confirm',data:{}},t());
  const fitItem2=r2.planRow.items.find(x=>x.domain==='fitness');
  d=life.overview(user,day2).day;
  life.updateDay(user,{day:day2,version:d.version,operation:'feedback',data:{item_id:fitItem2.id,status:'skipped',actual_minutes:null,note:'临时有事'}},t());
  assert.ok(currentPlan(db(),user,'fitness'),'单次未完成不废弃健身方案');
  assert.equal(db().prepare("SELECT 1 FROM domain_plans WHERE user_id=? AND domain='fitness' AND status='needs_review'").get(user),undefined,'未因单次未完成标记 needs_review');
  // 再次日：fitness 沿用方案，不触发重算；结转纳入统筹
  const day3='2026-10-27';
  const r3=await laterDay(s,day3,planWith(d1.ids,90));
  assert.deepEqual(r3.analyses,[],'单次未完成不触发领域重算');
  const st=domainState(user,{day:day3},db()).domains.find(x=>x.domain==='fitness');
  assert.equal(st.decision,'reuse','单次未完成仍沿用方案');
  assert.ok(st.state==='attention'||st.state==='normal','状态为关注/正常');
  assert.ok(st.signals.length>0,'状态含可查询信号来源');
 }finally{closeDb();rmSync(s.dir,{recursive:true,force:true})}
});

test('B2: 持久偏离（repeated_skip）触发该域重新分析，其他域沿用',async()=>{
 const s=await setup({});const {life,q,user,key,t}=s;
 try{
  const d1=await day1Full(s);
  for(const [day,budget] of [['2026-10-26',90],['2026-10-27',90]]){
   const r=await laterDay(s,day,planWith(d1.ids,budget));
   assert.deepEqual(r.analyses,[],day+' 正常沿用');
   let dd=life.overview(user,day).day;life.updateDay(user,{day,version:dd.version,operation:'confirm',data:{}},t());
   const item=r.planRow.items.find(x=>x.domain==='fitness');
   dd=life.overview(user,day).day;
   life.updateDay(user,{day,version:dd.version,operation:'feedback',data:{item_id:item.id,status:'skipped',actual_minutes:null,note:'又没练'}},t());
  }
  // 再次日：repeated_skip（近7天≥2次）→ fitness adjust/analyze；work/diet 沿用
  const day3='2026-10-28';
  const r3=await laterDay(s,day3,planWith(d1.ids,90),90,(newIds)=>newIds.fitness?'fitness':'');
  assert.ok(r3.analyses.includes('analysis.fitness'),'repeated_skip 触发健身重新分析');
  assert.ok(!r3.analyses.includes('analysis.work'),'工作领域不受影响，沿用');
  assert.ok(!r3.analyses.includes('analysis.diet'),'饮食领域不受影响，沿用');
  const st=domainState(user,{day:day3},db()).domains.find(x=>x.domain==='fitness');
  assert.equal(st.state,'adjust');
  assert.ok(st.signals.some(x=>x.source==='audit'&&x.rule.includes('repeated_skip')),'持久偏离信号来源与规则可查询');
 }finally{closeDb();rmSync(s.dir,{recursive:true,force:true})}
});

test('B3: 待处理调整请求由状态机判定 adjust/analyze 并触发该域重算',async()=>{
 const s=await setup({});const {life,q,intake,user,key,t}=s;
 try{
  const d1=await day1Full(s);
  const adjNow=t();
  adjustPlan(user,'fitness','膝盖不适，训练需减量','website',new Date(adjNow).toISOString());
  assert.equal(pendingAdjustments(db(),user,'fitness',new Date(adjNow+10000).toISOString()).length,1,'调整请求已持久化');
  const day2='2026-10-26';
  const r2=await laterDay(s,day2,planWith(d1.ids,90),90,(newIds)=>newIds.fitness?'fitness':'');
  assert.ok(r2.analyses.includes('analysis.fitness'),'待处理调整请求触发健身重算');
  assert.ok(!r2.analyses.includes('analysis.work'),'工作方案仍沿用');
  const st=domainState(user,{day:day2},db()).domains.find(x=>x.domain==='fitness');
  assert.equal(st.state,'adjust');
  assert.ok(st.signals.some(x=>x.source==='adjust'&&x.rule.includes('调整请求')),'调整信号来源与规则可查询');
  assert.equal(st.pending_adjustments,1,'状态记录待处理调整请求数');
 }finally{closeDb();rmSync(s.dir,{recursive:true,force:true})}
});

test('B4: 发布回执持久化——部分成功只补缺失，不整批重做；重复确认不新建发布批次',async()=>{
 const s=await setup({feishu:true});const {life,q,user,key,t}=s;
 try{
  const d1=await day1Full(s,{confirm:false});
  // 确认（启用飞书 → 三份发布任务）
  let d=life.overview(user,d1.day).day;life.updateDay(user,{day:d1.day,version:d.version,operation:'confirm',data:{}},t());
  confirmPlan(user,'work',1,'website');confirmPlan(user,'fitness',1,'website');confirmPlan(user,'diet',1,'website');
  const pubs=[];
  for(let i=0;i<10;i++){
   const j=q.claimJob(user,key,{},t()).job;if(!j)break;
   if(j.action.startsWith('feishu.publish')){pubs.push(j);continue}
   q.updateJob(user,key,j.job_id,'result',{lease_token:j.lease_token,status:'failed',output:{error:'跳过'}},t());
  }
  assert.ok(pubs.some(x=>x.action==='feishu.publish')&&pubs.some(x=>x.action==='feishu.publish.fitness')&&pubs.some(x=>x.action==='feishu.publish.diet'),'确认后并行产生三份发布任务');
  // 整日发布部分成功：2 项成功、1 项结果不明 → needs_review + 回执
  const full=pubs.find(x=>x.action==='feishu.publish');
  const fullIds=full.payload.plan.items.map(x=>x.id);
  q.updateJob(user,key,full.job_id,'result',{lease_token:full.lease_token,status:'needs_review',output:{external_effect:true,error:'部分成功',receipts:fullIds.slice(0,2).map(id=>({item_id:id,external_id:'ext-'+id}))}},t());
  const fitPub=pubs.find(x=>x.action==='feishu.publish.fitness');
  q.updateJob(user,key,fitPub.job_id,'result',{lease_token:fitPub.lease_token,status:'succeeded',output:{external_effect:true,receipts:fitPub.payload.plan.sessions.map(x=>({item_id:x.id,external_id:'fit-'+x.id}))}},t());
  const dietPub=pubs.find(x=>x.action==='feishu.publish.diet');
  q.updateJob(user,key,dietPub.job_id,'result',{lease_token:dietPub.lease_token,status:'succeeded',output:{external_effect:true,receipts:dietPub.payload.plan.meals.map(x=>({item_id:x.id,external_id:'diet-'+x.id}))}},t());
  // 回执持久化可查询
  const receipts=life.publishReceipts(user,d1.day,db());
  const fullRecs=receipts.receipts.filter(x=>x.action==='feishu.publish');
  assert.equal(fullRecs.length,3,'整日发布三条事项回执全部持久化');
  assert.deepEqual(fullRecs.map(x=>x.status).sort(),['succeeded','succeeded','unknown'],'部分成功：已成功与结果不明分开标记');
  assert.ok(receipts.receipts.some(x=>x.action==='feishu.publish.fitness'&&x.status==='succeeded'),'专业发布回执持久化');
  // 部分成功进入待核对；未确认无外部效果时拒绝整批重做
  const fullJobNow=q.listJobs(user,t()).jobs.find(x=>x.job_id===full.job_id);
  assert.equal(fullJobNow.status,'needs_review','部分成功进入待核对');
  assert.throws(()=>q.resolveJob(user,full.job_id,{decision:'requeue',reason:'恢复发布',confirmed_no_effect:false}),/没有外部效果/,'未确认无外部效果时拒绝整批重做');
  // 重复确认返回原结果，不创建新发布批次
  const overview=life.overview(user,d1.day).day;
  const retry=life.updateDay(user,{day:d1.day,version:overview.version,operation:'confirm',data:{}},t());
  assert.ok(retry.confirmed,'重复确认返回原结果');
  const publishJobs=q.listJobs(user,t()).jobs.filter(x=>x.day===d1.day&&x.action.startsWith('feishu.publish'));
  assert.equal(publishJobs.length,3,'重复确认不创建新的发布批次');
 }finally{closeDb();rmSync(s.dir,{recursive:true,force:true})}
});

test('B5: available_minutes 净时间口径 + 复盘未返回时生成待复盘草案',async()=>{
 const s=await setup({});const {life,q,user,key,t}=s;
 try{
  const d1=await day1Full(s,{budget:60});
  // 统筹指令明确净时间口径
  assert.ok(d1.plan.payload.role.includes('净时间'),'统筹指令明确 available_minutes 为净时间口径，不重复扣减 fixed');
  // 超预算被服务器拒绝
  const day2='2026-10-26';
  let dd=life.overview(user,day2).day;dd=life.updateDay(user,{day:day2,version:dd.version,operation:'input',data:{available_minutes:60,energy:3,fixed:'会议',note:''}},t());
  life.generate(user,{day:day2,kind:'plan',version:dd.version},t());
  let plan2=null;
  for(let i=0;i<10&&!plan2;i++){
   const j=q.claimJob(user,key,{},t()).job;if(!j)break;
   if(j.action==='daily.plan'){plan2=j;break}
   const out=j.action==='analysis.fitness'?{summary:'候选',sessions:[{id:randomUUID(),title:'x',minutes:30,reason:'g'}],missing:['候选']}:j.action==='analysis.diet'?{summary:'候选',meals:[{id:randomUUID(),title:'y',reason:'g'}],missing:['候选']}:{summary:'候选',items:[{id:randomUUID(),title:'z',reason:'w'}],missing:[]};
   q.updateJob(user,key,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},t());
  }
  assert.ok(plan2,'统筹任务可领取');
  const overPlan={summary:'超预算',items:[{id:randomUUID(),title:'推进项目',minutes:50,reason:'w',domain:'work',source_id:d1.ids.work[0]},{id:randomUUID(),title:'力量训练',minutes:30,reason:'g',domain:'fitness',source_id:d1.ids.fitness[0]}],buffer_minutes:10,deferred:[],missing:[]};
  let rejected=false;
  try{q.updateJob(user,key,plan2.job_id,'result',{lease_token:plan2.lease_token,status:'succeeded',output:overPlan},t())}catch(e){rejected=e?.status===400||/超过当天可用时间/.test(String(e?.message||e))}
  assert.ok(rejected,'超出净时间预算（60 分钟）的计划被服务器拒绝');
  // 复盘未返回：次日统筹指令带"待复盘草案"标注
  const day3='2026-10-27';
  const r3=await laterDay(s,day3,planWith(d1.ids,60),60);
  assert.ok(r3.instruction.includes('待复盘草案'),'复盘未返回时次日草案标注为待复盘草案');
 }finally{closeDb();rmSync(s.dir,{recursive:true,force:true})}
});
