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
 for(let i=0;i<12;i++){db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run('k'+i,'hash'+i,user,'AI '+i,'write','date',now+365*86400000);life.registerExecutor(user,'k'+i,{name:'AI '+i,capabilities:i===11?['feishu']:['analysis'],max_parallel:1},now)}
 let d=life.overview(user,day).day;d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:120,energy:3,fixed:'',note:''}},now);
 const flow=life.generate(user,{day,kind:'plan',version:d.version},now);assert.equal(life.generate(user,{day,kind:'plan',version:d.version},now).job_id,flow.job_id);
 assert.equal(q.claimJob(user,'k11',{},now).job,null);
 // Independent OS processes compete against the same SQLite file, not just sequential mocks.
 const results=await Promise.all(Array.from({length:10},(_,i)=>new Promise((resolve,reject)=>{
 const code=`import {claimJob} from './server/agent-jobs.mjs';console.log(JSON.stringify(claimJob('owner','k${i}',{},${now})));`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:process.env});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',c=>c?reject(Error(err)):resolve(JSON.parse(out)));
 })));
 const claims=results.map((x,i)=>({job:x.job,key:'k'+i})).filter(x=>x.job);assert.equal(claims.length,2);assert.equal(new Set(claims.map(x=>x.job.job_id)).size,2);
 assert.equal(q.claimJob(user,claims[0].key,{},now).reason,'capacity');
 const analysis={summary:'根据目标与精力安排',recommendations:['留出机动时间'],missing:[]};
 for(const c of claims)q.updateJob(user,c.key,c.job.job_id,'result',{lease_token:c.job.lease_token,status:'succeeded',output:analysis},now+1);
 const final=q.claimJob(user,'k0',{},now+2).job;assert.equal(final.action,'daily.plan');assert.equal(final.dependency_results.length,2);
 const item=randomUUID();const plan={summary:'完成重要行动',items:[{id:item,title:'推进目标',minutes:60,reason:'优先处理重要事项',task_id:null}],buffer_minutes:20,deferred:[],missing:[]};
 assert.throws(()=>q.updateJob(user,'k0',final.job_id,'result',{lease_token:final.lease_token,status:'succeeded',output:{...plan,buffer_minutes:100}},now+3),e=>e.status===400);
 const result={lease_token:final.lease_token,status:'succeeded',output:plan};q.updateJob(user,'k0',final.job_id,'result',result,now+4);assert.equal(q.updateJob(user,'k0',final.job_id,'result',result,now+5).duplicate,true);
 d=life.overview(user,day).day;assert.equal(d.plan.summary,plan.summary);
 assert.throws(()=>life.updateDay(user,{day,version:d.version-1,operation:'confirm'},now+6),e=>e.status===409);
 life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:true});
 d=life.updateDay(user,{day,version:d.version,operation:'confirm'},now+6);
 const pub=q.claimJob(user,'k11',{},now+7).job;assert.equal(pub.action,'feishu.publish');assert.equal(q.claimJob(user,'k10',{},now+7).job,null);
 d=life.updateDay(user,{day,version:d.version,operation:'feedback',data:{item_id:item,status:'partial',actual_minutes:45,note:'临时会议'}},now+8);
 life.generate(user,{day,version:d.version,kind:'review'},now+9);const review=q.claimJob(user,'k0',{},now+10).job;assert.equal(review.payload.context.day.feedback[item].status,'partial');
 q.updateJob(user,'k0',review.job_id,'result',{lease_token:review.lease_token,status:'succeeded',output:{summary:'留出更多机动时间',observations:['只完成部分'],adjustments:['缩小明天任务量'],missing:[]}},now+11);
 assert.equal(life.overview(user,day).day.review.adjustments[0],'缩小明天任务量');
 q.maintainJobs(now+120008);assert.equal(q.listJobs(user,now+120008).jobs.find(x=>x.job_id===pub.job_id).status,'needs_review');assert.equal(q.claimJob(user,'k11',{},now+120008).job,null);
 assert.throws(()=>q.resolveJob(user,pub.job_id,{decision:'requeue',reason:'try'},now+120008),e=>e.status===409);
 q.resolveJob(user,pub.job_id,{decision:'requeue',reason:'verified absent',confirmed_no_effect:true},now+120008);
 const retry=q.claimJob(user,'k11',{},now+120009).job;
 assert.throws(()=>q.updateJob(user,'k11',pub.job_id,'result',{lease_token:pub.lease_token,status:'succeeded',output:{external_effect:true,receipts:[{item_id:item,external_id:'test'}]}},now+120010),e=>e.status===409);
 q.updateJob(user,'k11',retry.job_id,'result',{lease_token:retry.lease_token,status:'succeeded',output:{external_effect:true,receipts:[{item_id:item,external_id:'mock-only'}]}},now+120011);
 d=life.overview(user,day).day;assert.throws(()=>life.updateDay(user,{day,version:d.version,operation:'reopen'},now+120012),e=>e.status===409);
 // The same single executor can complete all roles the following day, using yesterday's review.
 const next='2026-10-26';let nd=life.overview(user,next).day;life.generate(user,{day:next,version:nd.version,kind:'plan'},now+130000);
 for(let i=0;i<2;i++){const j=q.claimJob(user,'k0',{},now+130001+i).job;assert.equal(j.payload.context.recent[0].review.adjustments[0],'缩小明天任务量');q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:analysis},now+130001+i)}
 const last=q.claimJob(user,'k0',{},now+130004).job;assert.equal(last.action,'daily.plan');
 nd=life.updateDay(user,{day:next,version:nd.version,operation:'input',data:{available_minutes:60,energy:2,fixed:'',note:''}},now+130005);
 assert.throws(()=>q.updateJob(user,'k0',last.job_id,'result',{lease_token:last.lease_token,status:'succeeded',output:{...plan,missing:['可用时间未知']}},now+130006),e=>e.status===409);
 // Safe analysis expires and can be picked up by another identity; old lease cannot submit.
 life.generate(user,{day:next,version:nd.version,kind:'plan'},now+140000);
 const a=q.claimJob(user,'k1',{},now+140001).job;const b=q.claimJob(user,'k2',{job_id:a.job_id},now+260002).job;assert.equal(b.job_id,a.job_id);assert.notEqual(b.lease_token,a.lease_token);
 assert.throws(()=>q.updateJob(user,'k1',a.job_id,'result',{lease_token:a.lease_token,status:'succeeded',output:analysis},now+260003),e=>e.status===404);
 // Scheduler is durable and idempotent across repeated ticks.
 life.saveSettings(user,{enabled:true,plan_time:'00:00',review_time:'23:59',feishu:false});const scheduled=Date.parse('2026-10-27T00:00:00Z');assert.equal(life.tick(scheduled).created,1);assert.equal(life.tick(scheduled).created,0);closeDb();assert.equal(life.tick(scheduled).created,0);
 const sd='2026-10-27';
 for(let i=0;i<3;i++){
  const candidates=q.listJobs(user,scheduled).jobs.filter(x=>x.day===sd&&x.status==='queued');
  const chosen=candidates.find(x=>x.action.startsWith('analysis.'))||candidates.find(x=>x.action==='daily.plan');
  const j=q.claimJob(user,'k0',{job_id:chosen.job_id},scheduled).job;assert.ok(j);
  q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:j.action==='daily.plan'?{...plan,missing:['可用时间未知']}:analysis},scheduled);
 }
 let current=life.overview(user,sd).day;current=life.updateDay(user,{day:sd,version:current.version,operation:'confirm'},scheduled);
 life.saveSettings(user,{enabled:true,plan_time:'00:00',review_time:'00:00',feishu:false});assert.equal(life.tick(scheduled).created,1);
 const rj=q.listJobs(user,scheduled).jobs.find(x=>x.day===sd&&x.action==='daily.review');const rc=q.claimJob(user,'k0',{job_id:rj.job_id},scheduled).job;
 q.updateJob(user,'k0',rc.job_id,'result',{lease_token:rc.lease_token,status:'succeeded',output:{summary:'Review',observations:[],adjustments:[],missing:['暂无反馈']}},scheduled);
 assert.equal(life.tick(scheduled).created,0,'finished review must not reschedule itself');
 current=life.overview(user,sd).day;life.updateDay(user,{day:sd,version:current.version,operation:'feedback',data:{item_id:item,status:'done',actual_minutes:60,note:''}},scheduled);
 assert.equal(life.tick(scheduled).created,1,'new feedback schedules an updated review once');assert.equal(life.tick(scheduled).created,0);

 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
