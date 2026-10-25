import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('intake handoff reuses shared facts, defers questions, preserves evidence and rejects stale proposals',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-intake-'));process.env.DATABASE_PATH=join(dir,'db.sqlite');
 const {db,closeDb}=await import('../server/database.mjs');const {saveRecord}=await import('../server/records.mjs');const i=await import('../server/intake.mjs');const q=await import('../server/agent-jobs.mjs');const {registerExecutor}=await import('../server/life.mjs');const now=Date.now();
 try{
 const d=db();d.prepare('INSERT INTO users VALUES(?,?,?,?)').run('owner','test@example.test','hash','date');for(const key of ['a','b']){d.prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run(key,'hash'+key,'owner',key,'write','date',now+86400000);registerExecutor('owner',key,{name:key,capabilities:['analysis'],max_parallel:1},now)}
 const goal=saveRecord('owner','website',{id:randomUUID(),kind:'goal',version:0,data:{title:'建立科技公司',period:'life'}}).record;
 let view=i.intakeOverview('owner','work');assert.equal(view.state,'not_started');
 const field=view.fields.find(x=>x.key==='shared.time');const answer={request_id:randomUUID(),domain:'work',field_key:field.key,token:field.token,operation:'answer',answer:'工作日晚上大约两小时'};
 i.updateIntake('owner','a',answer,now);assert.equal(i.updateIntake('owner','a',answer,now).duplicate,true);
 assert.throws(()=>i.updateIntake('owner','b',{...answer,request_id:randomUUID(),answer:'不同回答'},now),e=>e.status===409);
 for(const domain of ['fitness','diet'])assert.equal(i.intakeOverview('owner',domain).fields.find(x=>x.key==='shared.time').status,'known');
 view=i.intakeOverview('owner','work');const start=i.startIntake('owner',{domain:'work',context_hash:view.context_hash},now);assert.equal(i.startIntake('owner',{domain:'work',context_hash:view.context_hash},now).job_id,start.job_id);
 const job=q.claimJob('owner','a',{},now).job;assert.equal(job.action,'intake.work');assert.ok(job.contract.output_schema.properties.questions);
 const bad={summary:'questions',evidence:[],questions:[{field_key:'shared.time',question:'重复问时间',reason:'test'}]};
 assert.throws(()=>q.updateJob('owner','a',job.job_id,'result',{lease_token:job.lease_token,status:'succeeded',output:bad},now),e=>e.status===400);
 const output={summary:'已有目标可核对，工作现状待了解',evidence:[{field_key:'work.goal',record_id:goal.id,record_version:goal.version,value:'建立科技公司',reason:'已有长期目标记录'}],questions:[{field_key:'work.current',question:'当前工作主要卡在哪里？',reason:'确定现状'}]};
 assert.throws(()=>q.updateJob('owner','a',job.job_id,'result',{lease_token:job.lease_token,status:'succeeded',output:{...output,evidence:[{...output.evidence[0],record_id:randomUUID()}]}},now),e=>e.status===409);
 q.updateJob('owner','a',job.job_id,'result',{lease_token:job.lease_token,status:'succeeded',output},now);
 view=i.intakeOverview('owner','work');assert.equal(view.report.current,true);assert.equal(view.fields.find(x=>x.key==='work.goal').status,'missing','AI cannot turn an extraction into an accepted fact');
 const goalField=view.fields.find(x=>x.key==='work.goal');i.updateIntake('owner','website',{request_id:randomUUID(),domain:'work',field_key:goalField.key,token:goalField.token,operation:'accept_evidence',report_job_id:job.job_id,evidence_index:0},now);
 view=i.intakeOverview('owner','work');assert.equal(view.fields.find(x=>x.key==='work.goal').status,'known');assert.equal(view.report.current,false);
 const current=view.fields.find(x=>x.key==='work.current');i.updateIntake('owner','b',{request_id:randomUUID(),domain:'work',field_key:current.key,token:current.token,operation:'defer'},now);
 view=i.intakeOverview('owner','work');i.startIntake('owner',{domain:'work',context_hash:view.context_hash},now);const second=q.claimJob('owner','b',{},now).job;
 assert.equal(second.payload.context.fields.find(x=>x.key==='work.current').status,'deferred');
 assert.throws(()=>q.updateJob('owner','b',second.job_id,'result',{lease_token:second.lease_token,status:'succeeded',output:{summary:'test',evidence:[],questions:[{field_key:'work.current',question:'再次追问',reason:'test'}]}},now),e=>e.status===400);
 // Editing a source record makes an in-flight interpretation stale and releases the task.
 saveRecord('owner','website',{id:goal.id,kind:'goal',version:1,data:{title:'修改后的方向',period:'life'}});
 assert.throws(()=>q.updateJob('owner','b',second.job_id,'result',{lease_token:second.lease_token,status:'succeeded',output:{summary:'test',evidence:[],questions:[]}},now),e=>e.status===409);
 assert.equal(q.listJobs('owner',now).jobs.find(x=>x.job_id===second.job_id).status,'cancelled');
 assert.equal(i.intakeOverview('owner','work').fields.find(x=>x.key==='work.goal').status,'needs_review','source corrections invalidate the derived confirmation');
 // Correcting the shared profile invalidates its confirmation without deleting the answer.
 const shared=i.intakeOverview('owner','fitness').fields.find(x=>x.key==='shared.time');
 saveRecord('owner','website',{id:shared.record.id,kind:'profile',version:shared.record.version,data:{...shared.record.data,statement:'新的时间安排'}});
 assert.equal(i.intakeOverview('owner','diet').fields.find(x=>x.key==='shared.time').status,'needs_review');
 closeDb();assert.equal(i.intakeOverview('owner','work').fields.find(x=>x.key==='work.current').status,'deferred');
 assert.equal(db().prepare('SELECT COUNT(*) n FROM daily_days').get().n,0,'intake must not create personal plans');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
