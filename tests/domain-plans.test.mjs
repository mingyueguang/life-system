import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {db,closeDb} from '../server/database.mjs';
import {plans as plansApi,currentPlan,confirmPlan,adjustPlan} from '../server/domain-plans.mjs';
test('stage3: domain plans persist with basis, validity, version and confirmation; confirmed plans are reused; key-fact edits only invalidate the affected domain',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-plan3-'));process.env.DATABASE_PATH=join(dir,'p3.sqlite');
 const lifeMod=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 const now=Date.now(),day='2026-10-25',next='2026-10-26',user='owner';
 try{
  db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'p3@example.test','hash','date');
  db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run('k0','h0',user,'AI','write','date',now+365*86400000);
  lifeMod.registerExecutor(user,'k0',{name:'AI',capabilities:['analysis'],max_parallel:1},now);
  lifeMod.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:false});
  // 补齐 fitness 关键资料：缺资料时按阶段 4 规则不会沿用已确认方案，先补全使"确认→沿用"场景成立
  const intakeM3=await import('../server/intake.mjs');
  let _t0=now;
  for(const key of ['fitness.goal','fitness.baseline','fitness.constraints','shared.time']){const f=intakeM3.intakeOverview(user,'fitness',db()).fields.find(x=>x.key===key);intakeM3.updateIntake(user,'website',{request_id:randomUUID(),domain:'fitness',field_key:key,token:f.token,operation:'answer',answer:key==='fitness.goal'?'增肌':key==='fitness.baseline'?'每周三次力量训练':key==='fitness.constraints'?'无运动限制':'晚上有空'},++_t0)}
  // 首次：三域分析成功 → 生成三条候选方案（有版本、复核时间、来源任务）
  let d=lifeMod.overview(user,day).day;d=lifeMod.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},now);
  lifeMod.generate(user,{day,kind:'plan',version:d.version},now);
  const fitItem=randomUUID(),mealItem=randomUUID();
  let t=now;
  for(let i=0;i<4;i++){
   const j=q.claimJob(user,'k0',{},++t).job;assert.ok(j,'首次流程第 '+(i+1)+' 个任务可领取');
   const out=j.action==='analysis.fitness'?{summary:'训练',sessions:[{id:fitItem,title:'力量训练',minutes:30,reason:'g'}],missing:[]}:j.action==='analysis.diet'?{summary:'饮食',meals:[{id:mealItem,title:'早餐',reason:'g'}],missing:['饮食目标未确认']}:j.action==='analysis.work'?{summary:'工作',recommendations:['推进项目'],missing:[]}:{summary:'首次计划',items:[{id:randomUUID(),title:'推进项目',minutes:30,reason:'w',domain:'work'}],buffer_minutes:10,deferred:[],missing:[]};
   q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},++t);
  }
  const all=plansApi(user,null,null,db());
  for(const domain of ['work','fitness','diet']){
   const rows=all.filter(x=>x.domain===domain);
   assert.equal(rows.length,1,'每个领域生成一个候选方案');
   assert.equal(rows[0].status,'candidate');
   assert.ok(rows[0].review_at>new Date().toISOString(),'方案带复核时间');
   assert.ok(rows[0].source_job_id,'方案记录来源任务');
   assert.equal(rows[0].version,1);
  }
  // 用户确认 fitness 方案；再次生成次日计划 → fitness 不再派发分析（正常沿用），统筹引用其事项通过校验
  confirmPlan(user,'fitness',1,'website');
  assert.ok(currentPlan(db(),user,'fitness'),'确认后成为当前有效方案');
  let nd=lifeMod.overview(user,next).day;nd=lifeMod.updateDay(user,{day:next,version:nd.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},now+86400000);
  lifeMod.generate(user,{day:next,kind:'plan',version:nd.version},now+86400000);
  const claims=[];let tt=now+86400000;
  for(let i=0;i<3;i++){
   const j=q.claimJob(user,'k0',{},++tt).job;assert.ok(j,'第 '+(i+1)+' 个任务可领取');claims.push(j);
   if(j.action!=='daily.plan'){
    const out=j.action==='analysis.fitness'?{summary:'训练',sessions:[{id:randomUUID(),title:'x',minutes:30,reason:'g'}],missing:['训练目标未确认']}:j.action==='analysis.diet'?{summary:'饮食',meals:[{id:randomUUID(),title:'y',reason:'g'}],missing:['饮食目标未确认']}:{summary:'工作',recommendations:['推进'],missing:[]};
    q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},++tt);
   }
  }
  assert.ok(!claims.some(x=>x.action==='analysis.fitness'),'已确认领域方案被沿用，不再派发 fitness 分析');
  assert.ok(claims.some(x=>x.action==='analysis.work')&&claims.some(x=>x.action==='analysis.diet'),'未确认领域照常分析');
  const planJob=claims.find(x=>x.action==='daily.plan');
  assert.ok(planJob.payload.confirmed_plans.fitness,'统筹上下文携带已确认方案');
  const plan={summary:'次日计划',items:[{id:randomUUID(),title:'力量训练',minutes:30,reason:'沿用确认方案',task_id:null,domain:'fitness',source_id:fitItem},{id:randomUUID(),title:'推进项目',minutes:30,reason:'工作',task_id:null,domain:'work'}],buffer_minutes:10,deferred:[],missing:[]};
  q.updateJob(user,'k0',planJob.job_id,'result',{lease_token:planJob.lease_token,status:'succeeded',output:plan},++tt);
  // 用户纠正健身资料 → 仅 fitness 方案需复核；work 确认方案不受影响
  confirmPlan(user,'work',1,'website');
  const intakeM=await import('../server/intake.mjs');
  const goalField=intakeM.intakeOverview(user,'fitness',db()).fields.find(f=>f.key==='fitness.goal');
  intakeM.updateIntake(user,'website',{request_id:randomUUID(),domain:'fitness',field_key:'fitness.goal',token:goalField.token,operation:'answer',answer:'增肌'},now+86400000+4);
  const after=plansApi(user,null,null,db());
  assert.equal(after.find(x=>x.domain==='fitness'&&x.version===1).status,'needs_review','纠正关键资料后该域方案标记需复核');
  assert.equal(after.find(x=>x.domain==='work'&&x.version===1).status,'confirmed','其他领域方案不受影响，不会整套重算');
  assert.ok(!currentPlan(db(),user,'fitness'),'需复核方案不再是当前有效方案');
  assert.ok(currentPlan(db(),user,'work'),'工作方案仍可沿用');
  // 调整接口：对已确认方案申请调整
  const adj=adjustPlan(user,'work','训练计划调整后重新核对工作安排','AI');
  assert.equal(adj.status,'needs_review');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
