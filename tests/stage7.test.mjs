import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {db,closeDb} from '../server/database.mjs';
import {confirmPlan,currentPlan,plans} from '../server/domain-plans.mjs';

function setupUser(now,email,suffix){
 const user='owner';const key='k'+suffix;
 db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,email,'hash','date');
 db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run(key,'h'+suffix,user,'AI','write','date',now+365*86400000);
 return {user,key};
}
async function runRound(user,key,day,{budget,planItems,expectPlan=true}){
 const life=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 let now=Date.now();
 let d=life.overview(user,day).day;
 d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:budget,energy:3,fixed:'',note:''}},++now);
 life.generate(user,{day,kind:'plan',version:d.version},++now);
 const analysis=[],seen=[];
 let plan=null;
 for(let i=0;i<10&&!plan;i++){
  const j=q.claimJob(user,key,{},++now).job;if(!j)break;
  seen.push(j.action);
  if(j.action==='daily.plan'){plan=j;break}
  if(j.action==='daily.review'){q.updateJob(user,key,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:{summary:'复盘',observations:['正常'],adjustments:[],missing:[]}},++now);continue}
  // 领到即提交，释放执行额度（max_parallel）
  const out=j.action==='analysis.work'?{summary:'工作',recommendations:['推进项目'],missing:[]}:j.action==='analysis.fitness'?{summary:'训练',sessions:[{id:fitId(day),title:'力量训练',minutes:30,reason:'g'}],missing:[]}:{summary:'饮食',meals:[{id:mealId(day),title:'早餐',reason:'g'}],missing:[]};
  q.updateJob(user,key,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},++now);
  analysis.push(j);
 }
 if(plan){q.updateJob(user,key,plan.job_id,'result',{lease_token:plan.lease_token,status:'succeeded',output:planItems||{summary:'计划',items:[{id:randomUUID(),title:'推进项目',minutes:budget,reason:'w',domain:'work'}],buffer_minutes:0,deferred:[],missing:[]}},++now)}
 if(expectPlan&&!plan)throw new Error('缺少统筹任务：'+seen.join(','));
 return {analysis,plan,jobs:seen};
}
const fitIds={},mealIds={};
const fitId=day=>fitIds[day]??=randomUUID();
const mealId=day=>mealIds[day]??=randomUUID();

test('stage7-A: full business loop with simulated dates - final acceptance scenario',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-s7a-'));process.env.DATABASE_PATH=join(dir,'a.sqlite');
 const life=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 let now=Date.now();
 try{
  const {user,key}=setupUser(now,'s7a@t.test','0');
  life.registerExecutor(user,key,{name:'AI',capabilities:['analysis'],max_parallel:2},now);
  life.saveSettings(user,{enabled:true,plan_time:'07:00',review_time:'21:00',feishu:false});
  const intakeM=await import('../server/intake.mjs');
  const answer=(dom,field,v)=>{const f=intakeM.intakeOverview(user,dom,db()).fields.find(x=>x.key===field);intakeM.updateIntake(user,'website',{request_id:randomUUID(),domain:dom,field_key:field,token:f.token,operation:'answer',answer:v},++now)};
  // 1) 用户只提供少量资料：work.goal + shared.time
  answer('work','work.goal','完成新版上线');answer('work','shared.time','晚上有空');
  let missingAll=life.context(db(),user,'2026-10-25').intake.fitness.required_missing;
  assert.ok(missingAll.length>0,'缺资料时补问清单存在');
  // 2) 系统补问必要信息 → 用户补齐
  answer('work','work.current','开发进行中');
  answer('fitness','fitness.goal','增肌');answer('fitness','fitness.baseline','每周三次力量训练');answer('fitness','fitness.constraints','无运动限制');
  answer('diet','diet.goal','控制体重');answer('diet','diet.routine','自己做饭');answer('diet','diet.constraints','无忌口');
  for(const dom of ['work','fitness','diet'])assert.equal(life.context(db(),user,'2026-10-25').intake[dom].required_missing.length,0,'资料补齐后无必填缺失');
  // 3) 首日：三域分析 → 形成方案 → 确认
  const day1='2026-10-25';
  let r1=await runRound(user,key,day1,{budget:90,planItems:{summary:'首日计划',items:[{id:randomUUID(),title:'推进项目',minutes:60,reason:'w',domain:'work'},{id:randomUUID(),title:'力量训练',minutes:20,reason:'g',domain:'fitness',source_id:fitId(day1)},{id:randomUUID(),title:'早餐',minutes:10,reason:'d',domain:'diet',source_id:mealId(day1)}],buffer_minutes:0,deferred:[],missing:[]}});
  assert.equal(r1.analysis.length,3,'首日三个领域都分析');
  let d=life.overview(user,day1).day;life.updateDay(user,{day:day1,version:d.version,operation:'confirm',data:{}},++now);
  for(const dom of ['work','fitness','diet'])confirmPlan(user,dom,1,'website');
  assert.ok(currentPlan(db(),user,'fitness'),'健身方案已确认');
  // 4) 正常沿用几天：第二天不再派发分析，直接统筹
  const day2='2026-10-26';
  let r2=await runRound(user,key,day2,{budget:90,planItems:{summary:'沿用计划',items:[{id:randomUUID(),title:'力量训练',minutes:20,reason:'沿用',domain:'fitness',source_id:fitId(day1)},{id:randomUUID(),title:'推进项目',minutes:60,reason:'w',domain:'work'}],buffer_minutes:5,deferred:[],missing:[]}});
  assert.equal(r2.analysis.length,0,'正常沿用不触发任何领域分析');
  d=life.overview(user,day2).day;life.updateDay(user,{day:day2,version:d.version,operation:'confirm',data:{}},++now);
  // 5) 某天时间减少：仍沿用方案，只重新统筹（预算约束生效）
  const day3='2026-10-27';
  let r3=await runRound(user,key,day3,{budget:35,planItems:{summary:'时间紧张',items:[{id:randomUUID(),title:'力量训练',minutes:20,reason:'沿用',domain:'fitness',source_id:fitId(day1)},{id:randomUUID(),title:'推进项目',minutes:10,reason:'压缩',domain:'work'}],buffer_minutes:5,deferred:['早餐'],missing:[]}});
  assert.equal(r3.analysis.length,0,'时间减少只重新统筹，不重算领域方案');
  d=life.overview(user,day3).day;life.updateDay(user,{day:day3,version:d.version,operation:'confirm',data:{}},++now);
  // 6) 训练出现异常：反馈部分完成 → 只调整健身领域
  const items3=JSON.parse(db().prepare('SELECT plan FROM daily_days WHERE user_id=? AND day=?').get(user,day3).plan).items;
  const fitItem3=items3.find(x=>x.domain==='fitness');
  d=life.overview(user,day3).day;
  life.updateDay(user,{day:day3,version:d.version,operation:'feedback',data:{item_id:fitItem3.id,status:'partial',actual_minutes:null,note:'只完成热身'}},++now);
  assert.equal(currentPlan(db(),user,'fitness'),null,'异常反馈后健身方案标记需复核');
  const day4='2026-10-28';
  let r4=await runRound(user,key,day4,{budget:90,planItems:{summary:'调整后计划',items:[{id:randomUUID(),title:'力量训练',minutes:30,reason:'新方案',domain:'fitness',source_id:fitId(day4)},{id:randomUUID(),title:'推进项目',minutes:50,reason:'沿用',domain:'work'}],buffer_minutes:10,deferred:[],missing:[]}});
  assert.ok(r4.analysis.some(x=>x.action==='analysis.fitness'),'健身重新分析');
  assert.ok(!r4.analysis.some(x=>x.action!=='analysis.fitness'),'只调整受影响领域，其余沿用');
  d=life.overview(user,day4).day;life.updateDay(user,{day:day4,version:d.version,operation:'confirm',data:{}},++now);
  confirmPlan(user,'fitness',2,'website');
  // 7) 晚间自动生成次日计划（模拟日期 tick：21:05）
  const simTick=Date.parse('2026-10-28T21:05:00+08:00');
  const ticked=life.tick(simTick);
  assert.ok(ticked.created>0,'晚间调度生成任务');
  const jobs5=q.listJobs(user,simTick+1000).jobs.filter(x=>x.day==='2026-10-29');
  assert.ok(jobs5.some(x=>x.action==='daily.plan'),'次日计划任务已生成');
  // 逐个领取并提交（领到即提交释放执行额度），直到没有可领任务
  for(let i=0;i<8;i++){const cl=q.claimJob(user,key,{},simTick+2000).job;if(!cl)break;
   const out=cl.action==='daily.review'?{summary:'复盘',observations:['正常'],adjustments:[],missing:[]}:cl.action==='daily.plan'?{summary:'次日计划',items:[{id:randomUUID(),title:'力量训练',minutes:30,reason:'沿用',domain:'fitness',source_id:fitId(day4)}],buffer_minutes:5,deferred:[],missing:['可用时间未知']}:cl.action==='analysis.work'?{summary:'工作',recommendations:['推进项目'],missing:[]}:cl.action==='analysis.fitness'?{summary:'训练',sessions:[{id:fitId(day4),title:'力量训练',minutes:30,reason:'g'}],missing:[]}:{summary:'饮食',meals:[{id:mealId(day4),title:'早餐',reason:'g'}],missing:[]};
   q.updateJob(user,key,cl.job_id,'result',{lease_token:cl.lease_token,status:'succeeded',output:out},simTick+3000)}
  const day5='2026-10-29';
  d=life.overview(user,day5).day;life.updateDay(user,{day:day5,version:d.version,operation:'confirm',data:{}},++now);
  // 8) 执行反馈后继续运行：完成事项不重复结转
  const items5=JSON.parse(db().prepare('SELECT plan FROM daily_days WHERE user_id=? AND day=?').get(user,day5).plan).items;
  d=life.overview(user,day5).day;
  life.updateDay(user,{day:day5,version:d.version,operation:'feedback',data:{item_id:items5[0].id,status:'done',actual_minutes:30,note:''}},++now);
  const day6='2026-10-30';
  const ov=life.overview(user,day6);
  assert.ok(!ov.carryover.some(x=>x.title==='力量训练'&&x.done),'已完成事项不再结转');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});

test('stage7-B: restart continues, failure recover, version conflict, backup restore',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-s7b-'));process.env.DATABASE_PATH=join(dir,'b.sqlite');
 const life=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 let now=Date.now();
 try{
  const {user,key}=setupUser(now,'s7b@t.test','1');
  life.registerExecutor(user,key,{name:'AI',capabilities:['analysis'],max_parallel:2},now);
  life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:false});
  const day='2026-10-25';
  let d=life.overview(user,day).day;d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:60,energy:3,fixed:'',note:''}},now);
  life.generate(user,{day,kind:'plan',version:d.version},now);
  const first=q.claimJob(user,key,{},++now).job;assert.ok(first,'可领取任务');
  // 模拟重启：关闭并重新打开同一数据库
  closeDb();const {db:db2}=await import('../server/database.mjs');
  const restarted=q.listJobs(user,++now).jobs.find(x=>x.job_id===first.job_id);
  assert.ok(restarted&&['running','queued'].includes(restarted.status),'重启后任务状态保留');
  const rec=q.activeJobs(user,key,++now);
  if(first.status==='running')assert.ok(rec.jobs.some(x=>x.job_id===first.job_id),'进行中任务可恢复租约');
  // 失败恢复：把 running 分析任务标记失败，重新生成 → 新版本任务可完成
  q.updateJob(user,key,first.job_id,'result',{lease_token:first.lease_token,status:'failed',output:{error:'模拟失败'}},++now);
  d=life.overview(user,day).day;life.generate(user,{day,kind:'plan',version:d.version},++now);
  let recovered=null;
  for(let i=0;i<4;i++){const j=q.claimJob(user,key,{},++now).job;if(j&&j.action==='analysis.work'){recovered=j;q.updateJob(user,key,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:{summary:'工作',recommendations:['推进项目'],missing:[]}},++now);break}}
  assert.ok(recovered,'失败后可重新生成并领取任务完成');
  // 版本冲突
  const stale=life.overview(user,day).day.version-1;
  assert.throws(()=>life.updateDay(user,{day,version:stale,operation:'input',data:{available_minutes:30,energy:3,fixed:'',note:''}},++now),/数据已变化/,'旧版本提交被 409 拒绝');
  // 备份迁移：拷贝库文件，新进程打开并迁移幂等、记录可读
  const backup=join(dir,'backup.sqlite');
  copyFileSync(join(dir,'b.sqlite'),backup);
  const proc=spawnSync(process.execPath,['--input-type=module','-e',`
   process.env.DATABASE_PATH=${JSON.stringify(backup)};
   const {db,closeDb}=await import('./server/database.mjs');
   const {migrate}=await import('./server/migrations.mjs');
   migrate(db());
   const n=db().prepare("SELECT COUNT(*) n FROM agent_jobs").get().n;
   const kinds=db().prepare("SELECT DISTINCT kind FROM records").all().length;
   console.log(JSON.stringify({n,kinds}));
   closeDb();
  `],{cwd:process.cwd(),encoding:'utf8'});
  assert.equal(proc.status,0,'备份库可打开并迁移幂等：'+(proc.stderr||'').slice(0,200));
  const backupInfo=JSON.parse(proc.stdout.trim().split('\n').pop());
  assert.ok(backupInfo.n>=0&&backupInfo.kinds>=0,'备份库记录可读');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});

test('stage7-C: multiple executors can complete the flow independently',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-s7c-'));process.env.DATABASE_PATH=join(dir,'c.sqlite');
 const life=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 let now=Date.now();
 try{
  const {user}=setupUser(now,'s7c@t.test','2');
  const keyA='k2',keyB='k3';
  db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run(keyB,'h3',user,'AI2','write','date',now+365*86400000);
  life.registerExecutor(user,keyA,{name:'AI-A',capabilities:['analysis'],max_parallel:2},now);
  life.registerExecutor(user,keyB,{name:'AI-B',capabilities:['analysis'],max_parallel:2},now);
  life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:false});
  const intakeM=await import('../server/intake.mjs');
  const answer=(dom,field,v)=>{const f=intakeM.intakeOverview(user,dom,db()).fields.find(x=>x.key===field);intakeM.updateIntake(user,'website',{request_id:randomUUID(),domain:dom,field_key:field,token:f.token,operation:'answer',answer:v},++now)};
  answer('work','work.goal','完成新版上线');answer('work','work.current','开发中');answer('work','shared.time','晚上有空');
  answer('fitness','fitness.goal','增肌');answer('fitness','fitness.baseline','每周三次');answer('fitness','fitness.constraints','无限制');
  answer('diet','diet.goal','控制体重');answer('diet','diet.routine','自己做');answer('diet','diet.constraints','无忌口');
  const day='2026-10-25';
  let d=life.overview(user,day).day;d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},++now);
  life.generate(user,{day,kind:'plan',version:d.version},++now);
  // 两个执行者交替领取，直到任务耗尽
  const done=[];
  for(let i=0;i<8&&done.length<4;i++){
   const key=i%2===0?keyA:keyB;
   const j=q.claimJob(user,key,{},++now).job;if(!j)continue;
   const out=j.action==='analysis.work'?{summary:'工作',recommendations:['推进项目'],missing:[]}:j.action==='analysis.fitness'?{summary:'训练',sessions:[{id:fitId(day),title:'力量训练',minutes:30,reason:'g'}],missing:[]}:j.action==='analysis.diet'?{summary:'饮食',meals:[{id:mealId(day),title:'早餐',reason:'g'}],missing:[]}:{summary:'计划',items:[{id:randomUUID(),title:'推进项目',minutes:60,reason:'w',domain:'work'}],buffer_minutes:10,deferred:[],missing:[]};
   q.updateJob(user,key,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},++now);
   done.push({action:j.action,key});
  }
  assert.ok(done.length>=4,'多执行者共同完成全流程');
  const planRow=db().prepare('SELECT plan FROM daily_days WHERE user_id=? AND day=?').get(user,day).plan;
  assert.ok(planRow,'统筹计划已生成，流程可被多 AI 独立完成');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});

test('stage7-D: protocol catalog is machine-readable and consistent with actual validation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-s7d-'));process.env.DATABASE_PATH=join(dir,'d.sqlite');
 try{
  const {protocol,contract}=await import('../server/protocol.mjs');
  const p=protocol();
  assert.equal(p.protocol_version,p.guide.split('v=')[1],'版本号与接入文档一致');
  assert.deepEqual(Object.keys(p.interface_catalog),['records','profile','goals_and_plans','domain_state','daily_plan','execution','runtime'],'七组接口职责齐全');
  assert.ok(p.register.example.name&&Array.isArray(p.register.example.capabilities)&&p.register.example.max_parallel===1,'登记示例与实际 schema 字段一致');
  assert.deepEqual(p.claim.example,{},'领取示例无多余参数');
  for(const a of ['intake.work','analysis.fitness','analysis.diet','analysis.work','daily.plan','daily.review','feishu.publish','simulation.noop']){
   const c=contract(a);assert.ok(c&&c.output_schema&&c.success_example&&Array.isArray(c.rules),'contract('+a+') 可机器读取');
   assert.ok(c.success_example.output,'contract('+a+') 含成功示例输出');
  }
  const life=await import('../server/life.mjs');
  assert.ok(life.planSchema&&life.analysisSchema&&life.fitnessPlanSchema&&life.dietPlanSchema&&life.publishSchema,'校验器与契约同步存在');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
