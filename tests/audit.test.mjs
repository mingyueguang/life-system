import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
test('audit: completed and stale items are blocked from plans; slots are validated',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'audit-flow-'));process.env.DATABASE_PATH=join(dir,'audit.sqlite');
 const {db,closeDb}=await import('../server/database.mjs');const life=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 const now=Date.now(),day='2026-10-25',user='owner';
 try{
  db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'audit@example.test','hash','date');
  db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run('k0','hash0',user,'AI','write','date',now+365*86400000);
  life.registerExecutor(user,'k0',{name:'AI',capabilities:['analysis'],max_parallel:1},now);
  life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:false});
  const insert=r=>{db().prepare('INSERT INTO records(id,user_id,kind,payload,version,updated_at,deleted) VALUES(?,?,?,?,?,?,?)').run(r.id,user,r.kind,JSON.stringify(r.data),1,new Date(now).toISOString(),0);return r.id};
  insert({id:randomUUID(),kind:'goal',data:{title:'服务器域名注册',period:'near',due:'',progress:100,note:''}});
  const doneTaskId=insert({id:randomUUID(),kind:'task',data:{title:'域名备案',priority:'high',estimated_minutes:30,due:'',done:true,goal:'',platform:'',note:''}});
  const activeTaskId=insert({id:randomUUID(),kind:'task',data:{title:'进行中待办',priority:'normal',estimated_minutes:30,due:'',done:false,goal:'',platform:'',note:''}});
  insert({id:randomUUID(),kind:'goal',data:{title:'旧年度目标',period:'three',due:'2026-01-01',progress:40,note:''}});
  insert({id:randomUUID(),kind:'task',data:{title:'旧待办',priority:'normal',estimated_minutes:30,due:'2026-01-01',done:false,goal:'',platform:'',note:''}});
  let d=life.overview(user,day).day;
  d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:120,energy:3,fixed:'',note:''}},now);
  const flow=life.generate(user,{day,kind:'plan',version:d.version},now);
  const outFor=a=>a==='analysis.fitness'?{summary:'F',sessions:[{id:randomUUID(),title:'Run',minutes:30,reason:'g'}],missing:[]}:a==='analysis.diet'?{summary:'D',meals:[{id:randomUUID(),title:'Breakfast',reason:'g'}],missing:[]}:{summary:'A',recommendations:[],missing:[]};
  for(let i=0;i<3;i++){
   const j=q.claimJob(user,'k0',{},now+i+1).job;assert.ok(j);
   q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:outFor(j.action)},now+i+1);
  }
  const planJob=q.claimJob(user,'k0',{},now+5).job;
  assert.equal(planJob.action,'daily.plan');
  const audit=planJob.payload.context.day.audit.map(x=>x.code).sort();
  assert.deepEqual(audit,['completed_goal_reused','completed_task_reused','stale_goal_pending','stale_task_pending']);
  assert.ok(planJob.payload.context.guards.completedTitles.includes('服务器域名注册'));
  assert.ok(planJob.payload.context.guards.completedTitles.includes('旧年度目标'));
  // Hard block remains structural only: an item linked to a completed task_id.
  const linked={summary:'p',items:[{id:randomUUID(),title:'域名备案',minutes:30,reason:'x',task_id:doneTaskId}],buffer_minutes:15,deferred:[],missing:[]};
  assert.throws(()=>q.updateJob(user,'k0',planJob.job_id,'result',{lease_token:planJob.lease_token,status:'succeeded',output:linked},now+6),e=>e.status===400);
  // Title matches never block: recurring / same-title items are scheduled normally.
  const titleOk={summary:'p',items:[{id:randomUUID(),title:'服务器域名注册',minutes:30,reason:'周期事项，标题相同不代表已完成',task_id:null}],buffer_minutes:15,deferred:[],missing:[]};
  q.updateJob(user,'k0',planJob.job_id,'result',{lease_token:planJob.lease_token,status:'succeeded',output:titleOk},now+7);
  // Stale-but-unfinished items are a soft check: may be scheduled with a reason.
  const newFlow=v=>life.generate(user,{day,kind:'plan',version:life.overview(user,day).day.version},v);
  const runAnalysis=v=>{for(let i=0;i<3;i++){const j=q.claimJob(user,'k0',{},v+i).job;q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:outFor(j.action)},v+i)}};
  newFlow(now+8);runAnalysis(now+9);
  const softJob=q.claimJob(user,'k0',{},now+13).job;
  const softPlan={summary:'p',items:[{id:randomUUID(),title:'旧年度目标',minutes:30,reason:'仍在推进，已说明延续理由',task_id:null},{id:randomUUID(),title:'旧待办',minutes:30,reason:'继续完成',task_id:null},{id:randomUUID(),title:'进行中待办',minutes:30,reason:'继续',task_id:activeTaskId}],buffer_minutes:0,deferred:[],missing:[]};
  q.updateJob(user,'k0',softJob.job_id,'result',{lease_token:softJob.lease_token,status:'succeeded',output:softPlan},now+14);
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
test('audit: anomaly signals request confirmation, never silent auto-adjust',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'audit-anom-'));process.env.DATABASE_PATH=join(dir,'anom.sqlite');
 const {db,closeDb}=await import('../server/database.mjs');const life=await import('../server/life.mjs');
 const user='owner',day='2026-10-25',now=Date.now();
 try{
  db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'anom@example.test','hash','date');
  const input=v=>JSON.stringify({available_minutes:v,energy:4,fixed:'',note:''});
  const plan={summary:'p',items:[{id:'11111111-1111-4111-8111-111111111111',title:'学习',minutes:30,reason:'r',task_id:null}],buffer_minutes:0,deferred:[],missing:[]};
  const dayRow=(d,fb)=>`INSERT INTO daily_days(user_id,day,input,plan,feedback,confirmed,version,updated) VALUES('${user}','${d}','${input(300)}','${JSON.stringify(plan)}','${JSON.stringify(fb)}',1,2,'${new Date(now).toISOString()}')`;
  const done={[plan.items[0].id]:{status:'done',actual_minutes:120,note:''}};
  const skipped={[plan.items[0].id]:{status:'skipped',actual_minutes:null,note:''}};
  db().prepare(dayRow('2026-10-18',skipped)).run();
  db().prepare(dayRow('2026-10-19',skipped)).run();
  db().prepare(dayRow('2026-10-20',done)).run();
  db().prepare(dayRow('2026-10-21',done)).run();
  db().prepare(dayRow('2026-10-22',done)).run();
  db().prepare(dayRow('2026-10-23',done)).run();
  db().prepare(dayRow('2026-10-24',done)).run();
  let d=life.overview(user,day).day;
  d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:120,energy:2,fixed:'',note:''}},now);
  const ctx=life.context(db(),user,day);
  const codes=ctx.day.anomalies.map(x=>x.code).sort();
  assert.ok(codes.includes('input_drop'));      // 120 < 300*0.5
  assert.ok(codes.includes('energy_drop'));      // 2 <= 4-2
  assert.ok(codes.includes('repeated_skip'));    // 2 skips
  assert.ok(codes.includes('time_overrun'));     // 120 > 30*2
  // Recent done titles are a soft signal, not a hard guard.
  assert.ok(ctx.guards.recentDoneTitles.includes('学习'));
  assert.ok(!ctx.guards.completedTitles.includes('学习'));
  assert.ok(ctx.carryover.some(x=>x.title==='学习'&&x.skipped===2));
  // Guards hard-block only records marked completed, not recent feedback.
  const guardCodes=ctx.day.audit.map(x=>x.code);
  assert.equal(guardCodes.length,0);
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
test('audit: auto_adjust settings control thresholds and carryover; mood/phone/environment enter context',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'audit-adjust-'));process.env.DATABASE_PATH=join(dir,'adjust.sqlite');
 const {db,closeDb}=await import('../server/database.mjs');const life=await import('../server/life.mjs');const auditMod=await import('../server/audit.mjs');
 const user='owner',day='2026-10-25',now=Date.now();
 try{
  db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'adjust@example.test','hash','date');
  const input=v=>JSON.stringify({available_minutes:v,energy:4,fixed:'',note:''});
  const plan={summary:'p',items:[{id:'11111111-1111-4111-8111-111111111111',title:'学习',minutes:30,reason:'r',task_id:null}],buffer_minutes:0,deferred:[],missing:[]};
  const fb={[plan.items[0].id]:{status:'skipped',actual_minutes:null,note:''}};
  const dayRow=(d)=>`INSERT INTO daily_days(user_id,day,input,plan,feedback,confirmed,version,updated) VALUES('${user}','${d}','${input(300)}','${JSON.stringify(plan)}','${JSON.stringify(fb)}',1,2,'${new Date(now).toISOString()}')`;
  for(const d of ['2026-10-18','2026-10-19'])db().prepare(dayRow(d)).run();
  let todayRow=life.overview(user,day).day;
  todayRow=life.updateDay(user,{day,version:todayRow.version,operation:'input',data:{available_minutes:120,energy:2,fixed:'',note:''}},now);
  // New data types are visible to analysis via records().
  const insert=r=>{db().prepare('INSERT INTO records(id,user_id,kind,payload,version,updated_at,deleted) VALUES(?,?,?,?,?,?,?)').run(r.id,user,r.kind,JSON.stringify(r.data),1,new Date(now).toISOString(),0);return r.id};
  insert({id:randomUUID(),kind:'environment',data:{date:'2026-10-24',location:'苏州',temperature_c:18,humidity_percent:60,aqi:42,conditions:'',note:''}});
  insert({id:randomUUID(),kind:'phone_usage',data:{date:'2026-10-24',category:'total',minutes:180,note:''}});
  insert({id:randomUUID(),kind:'mood',data:{date:'2026-10-24',title:'',text:'今天状态不错',mood_label:'',rating:4,note:''}});
  const all=life.records(db(),user);
  assert.deepEqual(all.map(r=>r.kind).filter(k=>['environment','phone_usage','mood'].includes(k)).sort(),['environment','mood','phone_usage']);
  // Looser thresholds and disabled carryover suppress the signals.
  const recent=db().prepare('SELECT * FROM daily_days WHERE user_id=? AND day<? ORDER BY day DESC LIMIT 7').all(user,day).map(life.unpackDay);
  const loose=auditMod.auditContext(db(),user,day,{all,recent,adjust:{overrun_factor:5,energy_drop_threshold:5,skip_carryover:false}});
  assert.deepEqual(loose.carryover,[]);
  assert.deepEqual(loose.anomalies.map(x=>x.code).sort(),['input_drop','repeated_skip']);
  // Defaults keep the original behavior.
  const ctx=life.context(db(),user,day);
  assert.ok(ctx.carryover.some(x=>x.title==='学习'&&x.skipped===2));
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
