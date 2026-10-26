// 批次 A 专项验收（1.6.0）：任务依赖与去重、资料门槛与方案来源、方案生命周期与调整请求。
// 对应整改计划第一~三步验收项：伪造来源被拒、并发确认/更新版本冲突、过期确认续期、
// 依据（basis_hash）变化拒绝旧候选、按域复核周期可配置、调整请求跨轮读取并标记处理。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {db,closeDb} from '../server/database.mjs';
import {currentPlan,confirmPlan,adjustPlan,adjustmentRequests,savePlan,planBasis} from '../server/domain-plans.mjs';

async function setup(){
 const dir=mkdtempSync(join(tmpdir(),'batch-a-'));closeDb();process.env.DATABASE_PATH=join(dir,'a.sqlite');
 const {db:d2}=await import('../server/database.mjs');
 const life=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');const intakeM=await import('../server/intake.mjs');
 const now=Date.now(),day='2026-10-25',user='owner';
 d2().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'a@example.test','hash','date');
 d2().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run('k0','h0',user,'AI','write','date',now+365*86400000);
 life.registerExecutor(user,'k0',{name:'AI',capabilities:['analysis'],max_parallel:1},now);
 life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:false});
 const fill=()=>{let t=now;for(const [dom,key,ans] of [['fitness','fitness.goal','增肌'],['fitness','fitness.baseline','每周三次力量训练'],['fitness','fitness.constraints','无运动限制'],['fitness','shared.time','晚上有空'],['diet','diet.goal','控制体重'],['diet','diet.routine','自己做饭'],['diet','diet.constraints','无忌口'],['diet','shared.time','晚上有空'],['work','work.goal','推进项目'],['work','work.current','开发中'],['work','shared.time','晚上有空']]){const f=intakeM.intakeOverview(user,dom,d2()).fields.find(x=>x.key===key);intakeM.updateIntake(user,'website',{request_id:randomUUID(),domain:dom,field_key:key,token:f.token,operation:'answer',answer:ans},++t)}return t};
 let d=life.overview(user,day).day;d=life.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},now);
 const t1=fill();
 life.generate(user,{day,kind:'plan',version:d.version},t1);
 let t=t1;
 const outFor=a=>a==='analysis.fitness'?{summary:'训练',sessions:[{id:randomUUID(),title:'力量训练',minutes:30,reason:'g'}],missing:[]}:a==='analysis.diet'?{summary:'饮食',meals:[{id:randomUUID(),title:'早餐',reason:'g'}],missing:[]}:a==='analysis.work'?{summary:'工作',items:[{id:randomUUID(),title:'推进项目',reason:'w'}],missing:[]}:{summary:'计划',items:[{id:randomUUID(),title:'推进项目',minutes:30,reason:'w',domain:'work'}],buffer_minutes:10,deferred:[],missing:[]};
 const jobs=[];
 for(let i=0;i<4;i++){const j=q.claimJob(user,'k0',{},++t).job;assert.ok(j,'流程任务可领取');q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:outFor(j.action)},++t);jobs.push(j)}
 const planJob=jobs.find(x=>x.action==='daily.plan');
 return {dir,life,q,intakeM,d2,now,day,user,planJob,t};
}

test('batch-A: forged sources rejected; concurrent confirm and basis change blocked; expired renew; per-domain review days; adjustments read and handled',async()=>{
 const {dir,life,q,intakeM,d2,now,day,user,planJob,t:rawT}=await setup();
 let t0=rawT;const t=()=>++t0;
 try{
  // ① 伪造来源被拒：source_id 指向不存在的方案事项 → 400，不进入正式执行清单。
  // 同输入重复生成：分析任务复用，只派发新的统筹任务（依赖关系完整）。
  let dd=life.overview(user,day).day;dd=life.updateDay(user,{day,version:dd.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},t());
  life.generate(user,{day,kind:'plan',version:dd.version},t());
  let planJob2=null;for(let i=0;i<3;i++){const j=q.claimJob(user,'k0',{},t()).job;if(!j)break;if(j.action==='daily.plan'){planJob2=j;break}}
  assert.ok(planJob2,'同输入重复生成只派发统筹任务');
  const forged={summary:'计划',items:[{id:randomUUID(),title:'力量训练',minutes:30,reason:'伪造',task_id:null,domain:'fitness',source_id:randomUUID()}],buffer_minutes:0,deferred:[],missing:[]};
  assert.throws(()=>q.updateJob(user,'k0',planJob2.job_id,'result',{lease_token:planJob2.lease_token,status:'succeeded',output:forged},t()),e=>e.status===400,'伪造来源被拒绝');
  const legal={summary:'计划',items:[{id:randomUUID(),title:'推进项目',minutes:30,reason:'w',task_id:null,domain:'work'}],buffer_minutes:10,deferred:[],missing:[]};
  q.updateJob(user,'k0',planJob2.job_id,'result',{lease_token:planJob2.lease_token,status:'succeeded',output:legal},t());
  // ② 关键资料缺失的领域事项不能进入正式执行清单（伪造来源尝试绕过 sourceOk 与门槛均失败）。
  // ③ 确认后并发冲突：同一版本再次确认 → 409；更新版本已确认时确认旧版本 → 409。
  // 先产生一个候选方案（analysis 成功即落库），再确认 v1。
  const p=life.plans&&null; // life 模块不导出 plans；直接读域方案
  const row=d2().prepare('SELECT * FROM domain_plans WHERE user_id=? AND domain=? AND status=? ORDER BY version DESC').get(user,'work','candidate');
  assert.ok(row,'分析成功已生成候选方案');
  confirmPlan(user,'work',row.version,'AI',new Date(t()).toISOString());
  const cur=currentPlan(d2(),user,'work');assert.ok(cur,'确认后成为当前有效方案');
  assert.throws(()=>confirmPlan(user,'work',row.version,'AI',new Date(t()).toISOString()),e=>e.status===409,'旧版本再次确认被并发拦截');
  // 更新版本已确认 → 确认旧版本被拒。
  const sup=savePlan(d2(),user,'work',{plan:{summary:'新方案',items:[{id:randomUUID(),title:'x',reason:'w'}],missing:[]},source_job_id:planJob.job_id,basis_hash:planBasis(d2(),user)},new Date(t()).toISOString());
  confirmPlan(user,'work',sup.version,'AI',new Date(t()).toISOString());
  assert.throws(()=>confirmPlan(user,'work',row.version,'AI',new Date(t()).toISOString()),e=>e.status===409,'不能覆盖较新版本');
  assert.equal(d2().prepare("SELECT COUNT(*) n FROM domain_plans WHERE user_id=? AND domain=? AND status='confirmed'").get(user,'work').n,1,'一个领域只有一个当前有效方案');
  // ④ 依据变化拒绝：方案依据指纹与当前记录不一致时不能确认旧候选。
  const stale=savePlan(d2(),user,'diet',{plan:{summary:'旧饮食',meals:[{id:randomUUID(),title:'旧',reason:'g'}],missing:[]},source_job_id:planJob.job_id,basis_hash:planBasis(d2(),user)},new Date(t()).toISOString());
  const rec=await import('../server/records.mjs');
  rec.saveRecord(user,'AI',{id:randomUUID(),kind:'mood',version:0,data:{text:'今天状态不错'}});
  assert.throws(()=>confirmPlan(user,'diet',stale.version,'AI',new Date(t()).toISOString()),e=>e.status===409,'依据已变化的旧候选不能确认');
  // ⑤ 过期确认续期：确认已过复核时间的方案 = 继续沿用，记录新的有效期。
  const oldAt=new Date(t()).toISOString();
  savePlan(d2(),user,'fitness',{plan:{summary:'旧训练',sessions:[{id:randomUUID(),title:'旧',minutes:30,reason:'g'}],missing:[]},source_job_id:planJob.job_id,basis_hash:planBasis(d2(),user),review_at:oldAt},oldAt);
  const fitRow=d2().prepare('SELECT * FROM domain_plans WHERE user_id=? AND domain=? ORDER BY version DESC').get(user,'fitness');
  const expiredNow=new Date(new Date(oldAt).getTime()+9*86400000);
  const renewed=confirmPlan(user,'fitness',fitRow.version,'AI',expiredNow.toISOString());
  assert.ok(renewed.review_at>expiredNow.toISOString(),'过期确认 = 续期并记录新的有效期');
  assert.ok(renewed.status==='confirmed','续期后方案可用，不会“确认成功但立即不可用”');
  // ⑥⑦ 调整请求触发重新分析：settings.domain_review_days.work=3 → 新方案复核时间 = now+3 天；
  // pending 调整请求被下一轮分析读取（payload.adjustments），成功后标记 handled 并关联新方案版本。
  life.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:false,domain_review_days:{work:3,fitness:7,diet:7}});
  adjustPlan(user,'work','工作重点变化，重新权衡','AI',new Date(t()).toISOString());
  const before=adjustmentRequests(user,{domain:'work'},d2()).filter(x=>x.status==='pending');
  assert.ok(before.length>=1,'调整请求已持久化');
  dd=life.overview(user,day).day;life.generate(user,{day,kind:'plan',version:dd.version},t());
  let workJob=null;
  for(let i=0;i<4&&!workJob;i++){const j=q.claimJob(user,'k0',{},t()).job;if(!j)break;
   if(j.action==='analysis.work'){workJob=j;break}
   // 领取顺序按 UUID 不预设：非目标任务领到即提交，释放执行额度。
   const out=j.action==='analysis.diet'?{summary:'饮食',meals:[{id:randomUUID(),title:'早餐',reason:'g'}],missing:[]}:j.action==='analysis.fitness'?{summary:'训练',sessions:[{id:randomUUID(),title:'力量训练',minutes:30,reason:'g'}],missing:[]}:{summary:'计划',items:[{id:randomUUID(),title:'推进项目',minutes:30,reason:'w',task_id:null,domain:'work'}],buffer_minutes:0,deferred:[],missing:[]};
   q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},t());
  }
  assert.ok(workJob,'调整请求触发 work 重新分析（不再复用旧结果）');
  const pending=workJob.payload.adjustments||[];
  assert.ok(pending.some(a=>a.status==='pending'&&a.domain==='work'),'分析任务携带未处理调整请求');
  q.updateJob(user,'k0',workJob.job_id,'result',{lease_token:workJob.lease_token,status:'succeeded',output:{summary:'工作',items:[{id:randomUUID(),title:'新重点',reason:'w'}],missing:[]}},t());
  const wRow=d2().prepare('SELECT * FROM domain_plans WHERE user_id=? AND domain=? ORDER BY version DESC').get(user,'work');
  const diffDays=Math.round((new Date(wRow.review_at)-Date.now())/86400000);
  assert.ok(diffDays===3,'按域复核周期生效（work=3 天，非全局硬编码 7 天）');
  const after=adjustmentRequests(user,{domain:'work'},d2()).filter(x=>x.status==='handled');
  assert.ok(after.some(a=>a.reason==='工作重点变化，重新权衡'),'调整请求已被本轮分析处理');
  assert.ok(after.some(a=>/新方案 v\d+/.test(a.handled_by||'')),'处理记录关联新方案版本');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
