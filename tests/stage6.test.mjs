import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {db,closeDb} from '../server/database.mjs';
import {confirmPlan,currentPlan,plans} from '../server/domain-plans.mjs';
test('stage6: execution feedback closes the loop - done never carried over; partial/skipped marks the domain plan needs_review; unknown stays untouched; optional reasons and no precise durations',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-stage6-'));process.env.DATABASE_PATH=join(dir,'s6.sqlite');
 const lifeMod=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 let now=Date.now(),day='2026-10-25',user='owner';
 try{
  db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'s6@t.test','hash','date');
  db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run('k0','h0',user,'AI','write','date',now+365*86400000);
  lifeMod.registerExecutor(user,'k0',{name:'AI',capabilities:['analysis'],max_parallel:1},now);
  lifeMod.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:false});
  const intakeM=await import('../server/intake.mjs');
  const answer=(dom,key,v)=>{const f=intakeM.intakeOverview(user,dom,db()).fields.find(x=>x.key===key);intakeM.updateIntake(user,'website',{request_id:randomUUID(),domain:dom,field_key:key,token:f.token,operation:'answer',answer:v},++now)};
  answer('work','work.goal','完成新版上线');answer('work','work.current','开发进行中');answer('work','shared.time','晚上有空');
  answer('fitness','fitness.goal','增肌');answer('fitness','fitness.baseline','每周三次力量训练');answer('fitness','fitness.constraints','无运动限制');answer('diet','diet.goal','控制体重');answer('diet','diet.routine','自己做饭');answer('diet','diet.constraints','无忌口');
  let d=lifeMod.overview(user,day).day;d=lifeMod.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},++now);
  lifeMod.generate(user,{day,kind:'plan',version:d.version},++now);
  const fitItem=randomUUID();
  let t=now,workItem=null;
  for(let i=0;i<4;i++){
   const j=q.claimJob(user,'k0',{},++t).job;assert.ok(j,'第 '+(i+1)+' 个任务可领取');
   const out=j.action==='analysis.fitness'?{summary:'训练',sessions:[{id:fitItem,title:'力量训练',minutes:30,reason:'g'}],missing:[]}:j.action==='analysis.diet'?{summary:'饮食',meals:[{id:randomUUID(),title:'早餐',reason:'g'}],missing:[]}:j.action==='analysis.work'?{summary:'工作',recommendations:['推进项目'],missing:[]}:{summary:'计划',items:[{id:randomUUID(),title:'推进项目',minutes:30,reason:'w',domain:'work'}],buffer_minutes:10,deferred:[],missing:[]};
   q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},++t);
  }
  confirmPlan(user,'fitness',1,'website');
  // 再生成次日计划并确认，为反馈做准备
  const next='2026-10-26';
  let d2=lifeMod.overview(user,next).day;d2=lifeMod.updateDay(user,{day:next,version:d2.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},++t);
  lifeMod.generate(user,{day:next,kind:'plan',version:d2.version},++t);
  for(let i=0;i<3;i++){const j=q.claimJob(user,'k0',{},++t).job;assert.ok(j);if(j.action==='daily.plan'){if(j.payload?.confirmed_plans?.fitness)workItem=null;q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:{summary:'次日计划',items:[{id:randomUUID(),title:'力量训练',minutes:30,reason:'沿用',domain:'fitness',source_id:fitItem},{id:randomUUID(),title:'推进项目',minutes:30,reason:'w',domain:'work'},{id:randomUUID(),title:'早餐',minutes:10,reason:'d',domain:'diet'}],buffer_minutes:5,deferred:[],missing:[]}},++t);continue}
   const out=j.action==='analysis.work'?{summary:'工作',recommendations:['推进项目'],missing:[]}:{summary:'饮食',meals:[{id:randomUUID(),title:'早餐',reason:'g'}],missing:[]};
   q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},++t)}
  const planItems=JSON.parse(db().prepare('SELECT plan FROM daily_days WHERE user_id=? AND day=?').get(user,next).plan).items;
  const fitPlanItem=planItems.find(x=>x.domain==='fitness'),workPlanItem=planItems.find(x=>x.domain==='work'),dietPlanItem=planItems.find(x=>x.domain==='diet');
  let d3=lifeMod.overview(user,next).day;
  lifeMod.updateDay(user,{day:next,version:d3.version,operation:'confirm',data:{}},++t);
  // 1) 部分完成：实际时长可空（不要求精确耗时），带原因 → fitness 方案标需复核
  d3=lifeMod.overview(user,next).day;
  lifeMod.updateDay(user,{day:next,version:d3.version,operation:'feedback',data:{item_id:fitPlanItem.id,status:'partial',actual_minutes:null,note:'只完成热身'}},++t);
  const fp=currentPlan(db(),user,'fitness');
  assert.equal(fp,null,'fitness 已确认方案被标记复核，不再是有效方案');
  assert.equal(plans(user,'fitness','needs_review',db()).length,1,'复核状态可查');
  // 2) 未完成 → work 无已确认方案时静默跳过（不报错）；同日其他域不受影响
  d3=lifeMod.overview(user,next).day;
  lifeMod.updateDay(user,{day:next,version:d3.version,operation:'feedback',data:{item_id:workPlanItem.id,status:'skipped',actual_minutes:null,note:'临时开会'}},++t);
  // 3) 完成 → 不重复结转：完成事项不进入下一轮统筹候选，未完成带标记结转
  d3=lifeMod.overview(user,next).day;
  lifeMod.updateDay(user,{day:next,version:d3.version,operation:'feedback',data:{item_id:dietPlanItem.id,status:'done',actual_minutes:10,note:''}},++t);
  const nextNext='2026-10-27';
  const ov=lifeMod.overview(user,nextNext);
  assert.ok(!ov.carryover.some(x=>x.title==='早餐'),'已完成事项不重复结转');
  assert.ok(ov.carryover.some(x=>x.title==='推进项目'&&x.skipped>=1),'未完成事项带 skipped 标记结转供统筹参考');
  // 4) 未反馈保持未知：feedback 记录里没有该事项
  const dayRow=db().prepare('SELECT feedback FROM daily_days WHERE user_id=? AND day=?').get(user,next);
  const fb=JSON.parse(dayRow.feedback);
  assert.ok(!('no-such-item' in fb),'未反馈事项不产生任何记录');
  assert.ok(fb[fitPlanItem.id]?.status==='partial'&&fb[workPlanItem.id]?.status==='skipped','反馈按事项独立保存');
  assert.equal(fb[fitPlanItem.id].actual_minutes,null,'实际时长可选，不强制精确耗时');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
