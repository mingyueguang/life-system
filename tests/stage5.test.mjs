import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {db,closeDb} from '../server/database.mjs';
import {currentPlan,confirmPlan} from '../server/domain-plans.mjs';
test('stage5: server enforces time budget; plain record writes do not trigger re-planning; plan items link to domain sources without forced time slots',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-stage5-'));process.env.DATABASE_PATH=join(dir,'s5.sqlite');
 const lifeMod=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 let now=Date.now(),day='2026-10-25',user='owner';
 try{
  db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'s5@t.test','hash','date');
  db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run('k0','h0',user,'AI','write','date',now+365*86400000);
  lifeMod.registerExecutor(user,'k0',{name:'AI',capabilities:['analysis'],max_parallel:1},now);
  lifeMod.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:false});
  const intakeM=await import('../server/intake.mjs');
  const answer=(dom,key,v)=>{const f=intakeM.intakeOverview(user,dom,db()).fields.find(x=>x.key===key);intakeM.updateIntake(user,'website',{request_id:randomUUID(),domain:dom,field_key:key,token:f.token,operation:'answer',answer:v},++now)};
  answer('work','work.goal','完成新版上线');answer('work','work.current','开发进行中');answer('work','shared.time','晚上有空');
  answer('fitness','fitness.goal','增肌');answer('fitness','fitness.baseline','每周三次力量训练');answer('fitness','fitness.constraints','无运动限制');
  answer('diet','diet.goal','控制体重');answer('diet','diet.routine','自己做饭');answer('diet','diet.constraints','无忌口');
  let d=lifeMod.overview(user,day).day;d=lifeMod.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:60,energy:3,fixed:'每天 09:00-10:00 例会',note:'今晚准备周报'}},++now);
  lifeMod.generate(user,{day,kind:'plan',version:d.version},++now);
  const fitItem=randomUUID();
  let t=now;
  for(let i=0;i<4;i++){
   const j=q.claimJob(user,'k0',{},++t).job;assert.ok(j,'第 '+(i+1)+' 个任务可领取');
   const out=j.action==='analysis.fitness'?{summary:'训练',sessions:[{id:fitItem,title:'力量训练',minutes:30,reason:'g'}],missing:[]}:j.action==='analysis.diet'?{summary:'饮食',meals:[{id:randomUUID(),title:'早餐',reason:'g'}],missing:[]}:j.action==='analysis.work'?{summary:'工作',items:[{id:randomUUID(),title:'推进项目',reason:'w'}],missing:[]}:{summary:'计划',items:[{id:randomUUID(),title:'推进项目',minutes:30,reason:'w',domain:'work'}],buffer_minutes:10,deferred:[],missing:[]};
   q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},++t);
  }
  confirmPlan(user,'fitness',1,'website');
  // 1) 服务器强制时间预算：可用 60 分钟，计划 70+10 分钟 → 400
  d=lifeMod.overview(user,day).day;d=lifeMod.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:60,energy:3,fixed:'',note:''}},++t);
  lifeMod.generate(user,{day,kind:'plan',version:d.version},++t);
  // 同输入重复生成：分析任务复用，只派发新的统筹任务。
  let planJob=null,prev=t;
  for(let i=0;i<3&&!planJob;i++){const j=q.claimJob(user,'k0',{},++t).job;if(!j)break;if(j.action==='daily.plan'){planJob=j;break}
   const out=j.action==='analysis.work'?{summary:'工作',items:[{id:randomUUID(),title:'推进项目',reason:'w'}],missing:[]}:{summary:'饮食',meals:[{id:randomUUID(),title:'早餐',reason:'g'}],missing:[]};
   q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},++t)}
  // fitness 已确认沿用 → 实际只有 diet/work 分析 + 统筹
  assert.ok(planJob,'统筹任务存在');
  const overBudget={summary:'超预算',items:[{id:randomUUID(),title:'事项A',minutes:40,reason:'a',domain:'work'},{id:randomUUID(),title:'事项B',minutes:40,reason:'b',domain:'fitness',source_id:fitItem}],buffer_minutes:10,deferred:[],missing:[]};
  assert.throws(()=>q.updateJob(user,'k0',planJob.job_id,'result',{lease_token:planJob.lease_token,status:'succeeded',output:overBudget},++t),/计划超过当天可用时间|超过已知可用时间/,'服务器拒绝超预算计划');
  // 2) 不强制精确时间槽：items 无 start/end 字段仍可提交（引用已确认 fitness 方案项 + work 项）
  const okPlan={summary:'可行计划',items:[{id:randomUUID(),title:'力量训练',minutes:20,reason:'沿用确认方案',domain:'fitness',source_id:fitItem},{id:randomUUID(),title:'推进项目',minutes:30,reason:'w',domain:'work'}],buffer_minutes:5,deferred:[],missing:[]};
  q.updateJob(user,'k0',planJob.job_id,'result',{lease_token:planJob.lease_token,status:'succeeded',output:okPlan},++t);
  // 3) 普通记录写入不触发整套重算：写一条 sleep 记录后，无新增 daily 任务
  const before=q.listJobs(user,++t).jobs.filter(x=>x.status==='queued').length;
  const recMod=await import('../server/records.mjs');
  recMod.saveRecord(user,'AI',{request_id:randomUUID(),id:randomUUID(),kind:'sleep',version:0,data:{date:day,hours:6.5,note:''},metadata:{source:{method:'user_report',original_text:'昨晚睡了六个半小时'},certainty:'estimated'}});
  const after=q.listJobs(user,++t).jobs.filter(x=>x.status==='queued').length;
  assert.equal(after,before,'普通记录写入不生成新的分析或统筹任务');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
