import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {backup} from 'node:sqlite';
import {db,closeDb} from '../server/database.mjs';
import {confirmPlan} from '../server/domain-plans.mjs';

// 批次 C：备份恢复测试——使用实际备份机制（node:sqlite backup()），
// 恢复后精确比较关键数据（记录/版本/方案/任务/反馈/回执/状态），不以"记录数≥0"作成功标准。
async function setup(){
 const dir=mkdtempSync(join(tmpdir(),'life-backup-'));
 process.env.DATABASE_PATH=join(dir,'live.sqlite');
 const life=await import('../server/life.mjs');
 const q=await import('../server/agent-jobs.mjs');
 const intake=await import('../server/intake.mjs');
 let now=Date.now(),user='owner',key='kb';
 db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'b@t.test','hash','date');
 db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run(key,'hb',user,'AI','write','date',now+365*86400000);
 life.registerExecutor(user,key,{name:'AI',capabilities:['analysis','feishu'],max_parallel:6},now);
 life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:true,domain_review_days:{work:7,fitness:7,diet:7},auto_adjust:{enabled:true,overrun_factor:2,energy_drop_threshold:2,skip_carryover:true}},now);
 const answer=(dom,f,v)=>{const fd=intake.intakeOverview(user,dom,db()).fields.find(x=>x.key===f);intake.updateIntake(user,'website',{request_id:randomUUID(),domain:dom,field_key:f,token:fd.token,operation:'answer',answer:v},++now)};
 answer('work','work.goal','完成上线');answer('work','work.current','开发中');answer('work','shared.time','晚上有空');
 answer('fitness','fitness.goal','增肌');answer('fitness','fitness.baseline','每周三次');answer('fitness','fitness.constraints','无限制');
 answer('diet','diet.goal','控体重');answer('diet','diet.routine','自己做');answer('diet','diet.constraints','无忌口');
 return {dir,life,q,intake,user,key,t:()=>++now};
}
async function day1Full(s){
 const {life,q,user,key,t}=s;
 const day='2026-10-25';
 let d=life.overview(user,day).day;d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},t());
 life.generate(user,{day,kind:'plan',version:d.version},t());
 const ids={work:[],fitness:[],diet:[]};
 let plan=null;
 for(let i=0;i<14&&!plan;i++){
  const j=q.claimJob(user,key,{},t()).job;if(!j)break;
  if(j.action==='daily.plan'){plan=j;break}
  let out;
  if(j.action==='analysis.work'){const id=randomUUID();ids.work.push(id);out={summary:'工作',items:[{id,title:'推进项目',reason:'w'}],missing:[]}}
  else if(j.action==='analysis.fitness'){const id=randomUUID();ids.fitness.push(id);out={summary:'训练',sessions:[{id,title:'力量训练',minutes:30,reason:'g'}],missing:[]}}
  else if(j.action==='analysis.diet'){const id=randomUUID();ids.diet.push(id);out={summary:'饮食',meals:[{id,title:'早餐',reason:'g'}],missing:[]}}
  else continue;
  q.updateJob(user,key,j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},t());
 }
 assert.ok(plan,'统筹任务可领取');
 const p={summary:'首日计划',items:[{id:randomUUID(),title:'推进项目',minutes:70,reason:'w',domain:'work',source_id:ids.work[0]},{id:randomUUID(),title:'力量训练',minutes:15,reason:'g',domain:'fitness',source_id:ids.fitness[0]},{id:randomUUID(),title:'早餐',minutes:5,reason:'g',domain:'diet',source_id:ids.diet[0]}],buffer_minutes:0,deferred:[],missing:[]};
 q.updateJob(user,key,plan.job_id,'result',{lease_token:plan.lease_token,status:'succeeded',output:p},t());
 d=life.overview(user,day).day;life.updateDay(user,{day,version:d.version,operation:'confirm',data:{}},t());
 confirmPlan(user,'work',1,'website');confirmPlan(user,'fitness',1,'website');confirmPlan(user,'diet',1,'website');
 // 一条用户反馈（未完成）
 d=life.overview(user,day).day;life.updateDay(user,{day,version:d.version,operation:'feedback',data:{item_id:p.items.find(x=>x.domain==='fitness').id,status:'skipped',actual_minutes:null,note:'临时有事'}},t());
 // 一条调整请求（已处理），用于验证"调整原因不丢失"
 db().prepare('INSERT INTO plan_adjustments(id,user_id,domain,reason,requester,related_version,status,created_at,handled_at,handled_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),user,'fitness','膝盖不适，训练需减量','website',1,'handled',new Date(t()).toISOString(),new Date(t()+1000).toISOString(),'kb');
 // 一条发布回执（succeeded）与一条结果不明（unknown），用于验证恢复后回执可查
 db().prepare('INSERT INTO publish_receipts(user_id,day,action,item_id,external_id,status,created) VALUES(?,?,?,?,?,?,?)').run(user,day,'feishu.publish.fitness',p.items.find(x=>x.domain==='fitness').id,'ext-fit','succeeded',t());
 db().prepare('INSERT INTO publish_receipts(user_id,day,action,item_id,external_id,status,created) VALUES(?,?,?,?,?,?,?)').run(user,day,'feishu.publish',randomUUID(),'','unknown',t());
 // 一条业务记录（目标），用于验证记录精确一致
 db().prepare('INSERT INTO records(id,user_id,kind,payload,version,updated_at,deleted) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),user,'goal',JSON.stringify({goal:'三个月内完成人生系统整改'}),1,new Date(t()).toISOString(),0);
 return {day,ids,plan,p};
}
function snapshot(){
 const tables=['users','api_keys','executors','life_settings','records','domain_plans','plan_adjustments','daily_days','agent_jobs','publish_receipts','domain_state_log','raw_inputs'];
 const out={};
 for(const t of tables){
  const pk={users:'id',api_keys:'id',executors:'key_id',life_settings:'user_id',records:'id',domain_plans:'user_id,domain,version',plan_adjustments:'id',daily_days:'user_id,day',agent_jobs:'id',publish_receipts:'user_id,day,action,item_id',domain_state_log:'id',raw_inputs:'id'}[t];
  out[t]=db().prepare(`SELECT * FROM ${t} ORDER BY ${pk}`).all();
 }
 return JSON.stringify(out);
}

test('备份恢复：实际 backup() 机制，恢复后关键数据逐项精确一致',async()=>{
 const s=await setup();const {dir,life,q,user,key,t}=s;
 const backupPath=join(dir,'restore.sqlite');
 try{
  await day1Full(s);
  const before=snapshot();
  await backup(db(),backupPath); // 实际备份机制（scripts/backup.mjs 同款）
  // 模拟停机恢复：关闭在线库，用备份文件作为数据文件重新打开
  closeDb();
  process.env.DATABASE_PATH=backupPath;
  db();
  const after=snapshot();
  assert.equal(after,before,'恢复后 users/api_keys/executors/life_settings/records/domain_plans/plan_adjustments/daily_days/agent_jobs/publish_receipts/domain_state_log/sources 全部与备份前精确一致');
  // 恢复后可正常查询（不只是数据在，服务可用）
  const life2=await import('../server/life.mjs');
  const ov=life2.overview(user,'2026-10-25');
  assert.ok(ov.day.plan,'恢复后当天计划仍在');
  assert.deepEqual(Object.keys(ov.day.feedback||{}).length>0,true,'恢复后反馈仍在');
  assert.equal(db().prepare('SELECT COUNT(*) n FROM publish_receipts').get().n,2,'恢复后发布回执仍在');
  assert.equal(life2.publishReceipts(user,'2026-10-25',db()).receipts.filter(x=>x.status==='succeeded').length,1,'恢复后可查询已成功事项');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
