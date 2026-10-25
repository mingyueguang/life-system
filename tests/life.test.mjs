import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
test('daily workflow: identities, actual concurrent claims, handoff, feedback, stale data and side effects',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-flow-'));process.env.DATABASE_PATH=join(dir,'life.sqlite');
 const {db,closeDb}=await import('../server/database.mjs');const life=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 const now=Date.now(),day='2026-10-25',user='owner';
 try{
 db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'test@example.test','hash','date');
 for(let i=0;i<12;i++){db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run('k'+i,'hash'+i,user,'AI '+i,'write','date',now+365*86400000);life.registerExecutor(user,'k'+i,{name:'AI '+i,capabilities:i===11?['feishu']:['analysis'],max_parallel:i===11?3:1},now)}
 let d=life.overview(user,day).day;d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:120,energy:3,fixed:'',note:''}},now);
 const flow=life.generate(user,{day,kind:'plan',version:d.version},now);assert.equal(life.generate(user,{day,kind:'plan',version:d.version},now).job_id,flow.job_id);
 assert.equal(q.claimJob(user,'k11',{},now).job,null);
 // Independent OS processes compete against the same SQLite file, not just sequential mocks.
 const results=await Promise.all(Array.from({length:10},(_,i)=>new Promise((resolve,reject)=>{
 const code=`import {claimJob} from './server/agent-jobs.mjs';console.log(JSON.stringify(claimJob('owner','k${i}',{},${now})));`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:process.env});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',c=>c?reject(Error(err)):resolve(JSON.parse(out)));
 })));
 const claims=results.map((x,i)=>({job:x.job,key:'k'+i})).filter(x=>x.job);assert.equal(claims.length,3);assert.equal(new Set(claims.map(x=>x.job.job_id)).size,3);
 assert.equal(q.claimJob(user,claims[0].key,{},now).reason,'capacity');
 const fitItem=randomUUID(),mealItem=randomUUID();
 const outFor=a=>a==='analysis.fitness'?{summary:'训练安排',sessions:[{id:fitItem,title:'力量训练',minutes:30,reason:'目标'}],missing:['训练目标未确认，此为候选']}:a==='analysis.diet'?{summary:'饮食安排',meals:[{id:mealItem,title:'早餐',reason:'目标'}],missing:['饮食目标未确认，此为候选']}:{summary:'根据目标与精力安排',recommendations:['留出机动时间'],missing:[]};
 for(const c of claims)q.updateJob(user,c.key,c.job.job_id,'result',{lease_token:c.job.lease_token,status:'succeeded',output:outFor(c.job.action)},now+1);
 const final=q.claimJob(user,'k0',{},now+2).job;assert.equal(final.action,'daily.plan');assert.equal(final.dependency_results.length,3);
 const item=randomUUID();const plan={summary:'完成重要行动',items:[
  {id:item,title:'推进目标',minutes:60,reason:'优先处理重要事项',task_id:null,domain:'work'},
  {id:fitItem,title:'力量训练',minutes:30,reason:'目标',task_id:null,domain:'fitness',source_id:fitItem},
  {id:mealItem,title:'早餐',minutes:15,reason:'目标',task_id:null,domain:'diet',source_id:mealItem}
 ],buffer_minutes:10,deferred:[],missing:[]};
 assert.throws(()=>q.updateJob(user,'k0',final.job_id,'result',{lease_token:final.lease_token,status:'succeeded',output:{...plan,buffer_minutes:100}},now+3),e=>e.status===400);
 const result={lease_token:final.lease_token,status:'succeeded',output:plan};q.updateJob(user,'k0',final.job_id,'result',result,now+4);assert.equal(q.updateJob(user,'k0',final.job_id,'result',result,now+5).duplicate,true);
 d=life.overview(user,day).day;assert.equal(d.plan.summary,plan.summary);
 assert.equal(d.fitness.summary,'训练安排');assert.equal(d.diet.summary,'饮食安排');
 assert.throws(()=>life.updateDay(user,{day,version:d.version-1,operation:'confirm'},now+6),e=>e.status===409);
 life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:true});
 d=life.updateDay(user,{day,version:d.version,operation:'confirm'},now+6);
 const pubs=q.listJobs(user,now+7).jobs.filter(x=>x.day===day&&x.status==='queued'&&x.action.startsWith('feishu.publish'));
 assert.deepEqual(pubs.map(x=>x.action).sort(),['feishu.publish','feishu.publish.diet','feishu.publish.fitness']);
 const pubFitJob=q.listJobs(user,now+7).jobs.find(x=>x.action==='feishu.publish.fitness');
 assert.deepEqual(pubFitJob.payload.plan,d.fitness,'发布内容与确认快照一致（派生自统筹选中事项）');
 let pub=null;
 for(const id of pubs.map(x=>x.job_id)){const j=q.claimJob(user,'k11',{job_id:id},now+7).job;assert.ok(j);
  if(j.action==='feishu.publish.fitness')q.updateJob(user,'k11',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:{external_effect:true,receipts:d.fitness.sessions.map(x=>({item_id:x.id,external_id:'mock-fitness'}))}},now+8);
  else if(j.action==='feishu.publish.diet')q.updateJob(user,'k11',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:{external_effect:true,receipts:d.diet.meals.map(x=>({item_id:x.id,external_id:'mock-diet'}))}},now+8);
  else pub=j;
 }
 assert.equal(pub.action,'feishu.publish');assert.equal(q.claimJob(user,'k10',{},now+8).job,null);
 d=life.updateDay(user,{day,version:d.version,operation:'feedback',data:{item_id:item,status:'partial',actual_minutes:45,note:'临时会议'}},now+12);
 life.generate(user,{day,version:d.version,kind:'review'},now+13);const review=q.claimJob(user,'k0',{},now+14).job;assert.equal(review.payload.context.day.feedback[item].status,'partial');
 q.updateJob(user,'k0',review.job_id,'result',{lease_token:review.lease_token,status:'succeeded',output:{summary:'留出更多机动时间',observations:['只完成部分'],adjustments:['缩小明天任务量'],missing:[]}},now+15);
 assert.equal(life.overview(user,day).day.review.adjustments[0],'缩小明天任务量');
 q.maintainJobs(now+120008);assert.equal(q.listJobs(user,now+120008).jobs.find(x=>x.job_id===pub.job_id).status,'needs_review');assert.equal(q.claimJob(user,'k11',{},now+120008).job,null);
 assert.throws(()=>q.resolveJob(user,pub.job_id,{decision:'requeue',reason:'try'},now+120008),e=>e.status===409);
 q.resolveJob(user,pub.job_id,{decision:'requeue',reason:'verified absent',confirmed_no_effect:true},now+120008);
 const retry=q.claimJob(user,'k11',{},now+120009).job;
 assert.throws(()=>q.updateJob(user,'k11',pub.job_id,'result',{lease_token:pub.lease_token,status:'succeeded',output:{external_effect:true,receipts:[{item_id:item,external_id:'test'}]}},now+120010),e=>e.status===409);
 q.updateJob(user,'k11',retry.job_id,'result',{lease_token:retry.lease_token,status:'succeeded',output:{external_effect:true,receipts:d.plan.items.map(x=>({item_id:x.id,external_id:'mock-only'}))}},now+120011);
 d=life.overview(user,day).day;assert.throws(()=>life.updateDay(user,{day,version:d.version,operation:'reopen'},now+120012),e=>e.status===409);
 // The same single executor can complete all roles the following day, using yesterday's review.
 const next='2026-10-26';let nd=life.overview(user,next).day;life.generate(user,{day:next,version:nd.version,kind:'plan'},now+130000);
 for(let i=0;i<3;i++){const j=q.claimJob(user,'k0',{},now+130001+i).job;assert.equal(j.payload.context.recent[0].review.adjustments[0],'缩小明天任务量');q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:outFor(j.action)},now+130001+i)}
 const last=q.claimJob(user,'k0',{},now+130004).job;assert.equal(last.action,'daily.plan');
 nd=life.updateDay(user,{day:next,version:nd.version,operation:'input',data:{available_minutes:60,energy:2,fixed:'',note:''}},now+130005);
 assert.throws(()=>q.updateJob(user,'k0',last.job_id,'result',{lease_token:last.lease_token,status:'succeeded',output:{...plan,missing:['可用时间未知']}},now+130006),e=>e.status===409);
 // Safe analysis expires and can be picked up by another identity; old lease cannot submit.
 life.generate(user,{day:next,version:nd.version,kind:'plan'},now+140000);
 const a=q.claimJob(user,'k1',{},now+140001).job;const b=q.claimJob(user,'k2',{job_id:a.job_id},now+740002).job;assert.equal(b.job_id,a.job_id);assert.notEqual(b.lease_token,a.lease_token);
 assert.throws(()=>q.updateJob(user,'k1',a.job_id,'result',{lease_token:a.lease_token,status:'succeeded',output:outFor(a.action)},now+740003),e=>e.status===404);
 // Scheduler is durable and idempotent across repeated ticks.
 life.saveSettings(user,{enabled:true,plan_time:'00:00',review_time:'23:59',feishu:false});const scheduled=Date.parse('2026-10-27T00:00:00Z');assert.equal(life.tick(scheduled).created,1);assert.equal(life.tick(scheduled).created,0);closeDb();assert.equal(life.tick(scheduled).created,0);
 // 晚间调度：复盘针对当天，规划明确针对次日（P2-5）
 const todayDay='2026-10-27',planDay='2026-10-28';
 // 今天的计划由前一晚生成：先为今天生成并确认一份计划，晚间 tick 才能复盘今天、规划明天
 life.generate(user,{day:todayDay,kind:'plan',version:life.overview(user,todayDay).day.version},scheduled);
 for(let i=0;i<4;i++){
  const tc=q.listJobs(user,scheduled).jobs.filter(x=>x.day===todayDay&&x.status==='queued');
  const chosen=tc.find(x=>x.action.startsWith('analysis.'))||tc.find(x=>x.action==='daily.plan');
  const tj=q.claimJob(user,'k0',{job_id:chosen.job_id},scheduled).job;assert.ok(tj);
  q.updateJob(user,'k0',tj.job_id,'result',{lease_token:tj.lease_token,status:'succeeded',output:tj.action==='daily.plan'?{...plan,missing:['可用时间未知']}:outFor(tj.action)},scheduled);
 }
 let current=life.overview(user,todayDay).day;current=life.updateDay(user,{day:todayDay,version:current.version,operation:'confirm'},scheduled);
 // tick：规划生成的是明天（10-28）的计划，而不是今天
 for(let i=0;i<4;i++){
  const candidates=q.listJobs(user,scheduled).jobs.filter(x=>x.day===planDay&&x.status==='queued');
  const chosen=candidates.find(x=>x.action.startsWith('analysis.'))||candidates.find(x=>x.action==='daily.plan');
  const j=q.claimJob(user,'k0',{job_id:chosen.job_id},scheduled).job;assert.ok(j);
  q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:j.action==='daily.plan'?{...plan,missing:['可用时间未知']}:outFor(j.action)},scheduled);
 }
 current=life.overview(user,planDay).day;current=life.updateDay(user,{day:planDay,version:current.version,operation:'confirm'},scheduled);
 assert.equal(current.fitness.sessions[0].id,fitItem,'确认快照从统筹选中事项派生');
 life.saveSettings(user,{enabled:true,plan_time:'00:00',review_time:'00:00',feishu:false});assert.equal(life.tick(scheduled).created,1);
 const rj=q.listJobs(user,scheduled).jobs.find(x=>x.day===todayDay&&x.action==='daily.review');const rc=q.claimJob(user,'k0',{job_id:rj.job_id},scheduled).job;assert.ok(rc);
 q.updateJob(user,'k0',rc.job_id,'result',{lease_token:rc.lease_token,status:'succeeded',output:{summary:'Review',observations:[],adjustments:[],missing:['暂无反馈']}},scheduled);
 assert.equal(life.tick(scheduled).created,0,'finished review must not reschedule itself');
 current=life.overview(user,todayDay).day;life.updateDay(user,{day:todayDay,version:current.version,operation:'feedback',data:{item_id:item,status:'done',actual_minutes:60,note:''}},scheduled);
 assert.equal(life.tick(scheduled).created,1,'new feedback schedules an updated review once');assert.equal(life.tick(scheduled).created,0);
 // Settings merged with auto_adjust defaults when absent; explicit values override.
 assert.deepEqual(life.settings(user).auto_adjust,{enabled:true,overrun_factor:2,energy_drop_threshold:2,skip_carryover:true});
 life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:false,auto_adjust:{enabled:false,overrun_factor:3,energy_drop_threshold:1,skip_carryover:false}});
 assert.equal(life.settings(user).auto_adjust.overrun_factor,3);
 assert.ok(Array.isArray(life.overview(user,todayDay).carryover));

 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});

test('plan: publish and display derive from the confirmed snapshot only; unselected domains are not published (P1-2)',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-snap-'));process.env.DATABASE_PATH=join(dir,'snap.sqlite');
 const {db,closeDb}=await import('../server/database.mjs');const life=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 const now=Date.now(),day='2026-10-25',user='owner';
 try{
  db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'snap@example.test','hash','date');
  db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run('k0','hash0',user,'AI','write','date',now+365*86400000);
  life.registerExecutor(user,'k0',{name:'AI',capabilities:['analysis','feishu'],max_parallel:1},now);
  life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:true});
  let d=life.overview(user,day).day;d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:60,energy:3,fixed:'',note:''}},now);
  const flow=life.generate(user,{day,kind:'plan',version:d.version},now);
  const fitItem=randomUUID();
  const outFor=a=>a==='analysis.fitness'?{summary:'训练安排',sessions:[{id:fitItem,title:'力量训练',minutes:60,reason:'目标'}],missing:['训练目标未确认，此为候选']}:a==='analysis.diet'?{summary:'饮食安排',meals:[{id:randomUUID(),title:'早餐',reason:'目标'}],missing:['饮食目标未确认，此为候选']}:{summary:'工作分析',recommendations:[],missing:[]};
  for(let i=0;i<3;i++){const j=q.claimJob(user,'k0',{},now+i+1).job;assert.ok(j);q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:outFor(j.action)},now+i+1)}
  const final=q.claimJob(user,'k0',{},now+5).job;assert.equal(final.action,'daily.plan');
  // 统筹只选中工作，deferred 明确取消训练；专业方案仍作为候选保存（前置中间品）
  const plan={summary:'专注工作',items:[{id:randomUUID(),title:'推进目标',minutes:60,reason:'优先工作',task_id:null,domain:'work'}],buffer_minutes:0,deferred:['今天取消训练，恢复后再安排'],missing:[]};
  q.updateJob(user,'k0',final.job_id,'result',{lease_token:final.lease_token,status:'succeeded',output:plan},now+6);
  const cur=life.overview(user,day).day;
  const confirmed=life.updateDay(user,{day,version:cur.version,operation:'confirm'},now+7);
  assert.equal(confirmed.fitness,null,'统筹未选中训练 → 确认后不展示训练方案');
  assert.equal(confirmed.diet,null,'统筹未选中饮食 → 确认后不展示饮食方案');
  const pubs=q.listJobs(user,now+8).jobs.filter(x=>x.day===day&&x.action.startsWith('feishu.publish'));
  assert.deepEqual(pubs.map(x=>x.action),['feishu.publish'],'统筹未选中训练/饮食 → 只发布整日计划，不发布专业方案');
  // 修改当天条件 → 旧 fitness/diet 候选失效
  d=life.updateDay(user,{day,version:confirmed.version,operation:'reopen'},now+9);
  assert.equal(d.fitness,null);assert.equal(d.diet,null);
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});

test('stage2: key facts missing → deterministic plans rejected unless missing declared; other domains proceed (阶段2)',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-stage2-'));process.env.DATABASE_PATH=join(dir,'s2.sqlite');
 const {db,closeDb}=await import('../server/database.mjs');const life=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 const now=Date.now(),day='2026-10-25',user='owner';
 try{
  db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'s2@example.test','hash','date');
  db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run('k0','h0',user,'AI','write','date',now+365*86400000);
  life.registerExecutor(user,'k0',{name:'AI',capabilities:['analysis','feishu'],max_parallel:1},now);
  life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:true});
  let d=life.overview(user,day).day;d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},now);
  life.generate(user,{day,kind:'plan',version:d.version},now);
  // 无任何资料：fitness/diet 的 required_missing 非空（训练目标/饮食目标等）。max_parallel=1，同一执行者串行处理，领取顺序不预设
  const bad=a=>a==='analysis.fitness'?{summary:'训练安排',sessions:[{id:randomUUID(),title:'力量训练',minutes:30,reason:'目标'}],missing:[]}:{summary:'饮食安排',meals:[{id:randomUUID(),title:'早餐',reason:'目标'}],missing:[]};
  const fitOut=a=>a==='analysis.fitness'?{summary:'训练候选',sessions:[{id:randomUUID(),title:'力量训练',minutes:30,reason:'候选'}],missing:['训练目标未确认，暂无法制定完整方案']}:{summary:'饮食候选',meals:[{id:randomUUID(),title:'早餐',reason:'候选'}],missing:['饮食目标未确认，暂无法制定完整方案']};
  let t=now;
  for(let i=0;i<3;i++){
   const j=q.claimJob(user,'k0',{},++t).job;assert.ok(j,'第 '+(i+1)+' 个分析任务可领取');
   if(j.action==='analysis.work'){q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:{summary:'工作分析',recommendations:['留出机动'],missing:[]}},++t);continue}
   assert.throws(()=>q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:bad(j.action)},++t),e=>e.status===400,'缺关键资料时确定性方案必须被拒绝');
   q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:fitOut(j.action)},++t);
  }
  // 统筹只选 work，仍可正常生成次日计划（饮食/训练以候选+missing 进入上下文）
  const planJob=q.claimJob(user,'k0',{},++t).job;assert.equal(planJob.action,'daily.plan');
  const plan={summary:'专注工作',items:[{id:randomUUID(),title:'推进目标',minutes:90,reason:'优先工作',task_id:null,domain:'work'}],buffer_minutes:0,deferred:['训练饮食资料不足，暂不安排'],missing:[]};
  q.updateJob(user,'k0',planJob.job_id,'result',{lease_token:planJob.lease_token,status:'succeeded',output:plan},++t);
  const cur=life.overview(user,day).day;const confirmed=life.updateDay(user,{day,version:cur.version,operation:'confirm'},++t);
  assert.equal(confirmed.fitness,null,'缺资料领域不产生展示方案');
  assert.equal(confirmed.diet,null,'缺资料领域不产生展示方案');
  // 补全训练目标（用户回答）后：fitness 的 required_missing 减少，仍允许候选或正式方案
  const intakeM=await import('../server/intake.mjs');
  const goalField=intakeM.intakeOverview(user,'fitness',db()).fields.find(f=>f.key==='fitness.goal');
  intakeM.updateIntake(user,'website',{request_id:randomUUID(),domain:'fitness',field_key:'fitness.goal',token:goalField.token,operation:'answer',answer:'增肌'},++t);
  assert.ok(!life.context(db(),user,day).intake.fitness.required_missing.includes('训练目标'),'回答后训练目标从关键缺失移除');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
