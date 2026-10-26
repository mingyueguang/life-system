import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {db,closeDb} from '../server/database.mjs';
import {domainState,assessDomain} from '../server/domain-state.mjs';
import {currentPlan,confirmPlan} from '../server/domain-plans.mjs';
test('stage4: domain states drive reuse vs re-analysis; missing is not normal; same-day duplicates not re-dispatched; reasons are queryable',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-stage4-'));process.env.DATABASE_PATH=join(dir,'s4.sqlite');
 const lifeMod=await import('../server/life.mjs');const q=await import('../server/agent-jobs.mjs');
 let now=Date.now(),day='2026-10-25',user='owner';
 try{
  db().prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'s4@t.test','hash','date');
  db().prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run('k0','h0',user,'AI','write','date',now+365*86400000);
  lifeMod.registerExecutor(user,'k0',{name:'AI',capabilities:['analysis'],max_parallel:1},now);
  lifeMod.saveSettings(user,{enabled:false,plan_time:'07:00',review_time:'21:00',feishu:false});
  const intakeM=await import('../server/intake.mjs');
  // 补齐 work/fitness 全部必填资料；diet 保留 diet.goal 缺口（验证"缺失不算正常"）
  const answer=(dom,key,v)=>{const f=intakeM.intakeOverview(user,dom,db()).fields.find(x=>x.key===key);intakeM.updateIntake(user,'website',{request_id:randomUUID(),domain:dom,field_key:key,token:f.token,operation:'answer',answer:v},++now)};
  answer('work','work.goal','完成新版上线');answer('work','work.current','开发进行中');
  answer('work','shared.time','晚上有空');
  answer('fitness','fitness.goal','增肌');answer('fitness','fitness.baseline','每周三次力量训练');answer('fitness','fitness.constraints','无运动限制');
  answer('diet','diet.routine','自己做饭');answer('diet','diet.constraints','无忌口');
  let d=lifeMod.overview(user,day).day;d=lifeMod.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},++now);
  // 第一次生成：work/fitness 有资料但无方案 → adjust（派发分析）；diet 缺目标 → insufficient（数据缺失不算正常）
  lifeMod.generate(user,{day,kind:'plan',version:d.version},++now);
  let st=domainState(user,{day},db()).domains;
  assert.equal(st.length,3,'三域状态均已记录并可查询');
  assert.equal(st.find(x=>x.domain==='work').state,'adjust','有资料无方案 → 需分析');
  assert.equal(st.find(x=>x.domain==='fitness').state,'adjust','同上');
  const diet=st.find(x=>x.domain==='diet');
  assert.equal(diet.state,'insufficient');
  assert.ok(diet.reasons.some(r=>r.includes('关键资料未确认')),'资料不足的原因可查询（数据缺失不算正常）');
  // 提交三域分析（diet 缺资料须带 missing 候选），确认 work 方案
  let t=now;
  for(let i=0;i<4;i++){
   const j=q.claimJob(user,'k0',{},++t).job;assert.ok(j,'第 '+(i+1)+' 个任务可领取');
   const out=j.action==='analysis.fitness'?{summary:'训练',sessions:[{id:randomUUID(),title:'力量训练',minutes:30,reason:'g'}],missing:[]}:j.action==='analysis.diet'?{summary:'饮食',meals:[{id:randomUUID(),title:'早餐',reason:'g'}],missing:['饮食目标未确认']}:j.action==='analysis.work'?{summary:'工作',items:[{id:randomUUID(),title:'推进项目',reason:'w'}],missing:[]}:{summary:'计划',items:[{id:randomUUID(),title:'推进项目',minutes:30,reason:'w',domain:'work'}],buffer_minutes:10,deferred:[],missing:[]};
   q.updateJob(user,'k0',j.job_id,'result',{lease_token:j.lease_token,status:'succeeded',output:out},++t);
  }
  confirmPlan(user,'work',1,'website');
  assert.ok(currentPlan(db(),user,'work'),'work 方案已确认');
  // 第二次生成（同一天、新版本）：work 有有效方案且无信号 → normal/沿用（不派分析）；fitness 仍 adjust；diet 仍 insufficient
  d=lifeMod.overview(user,day).day;d=lifeMod.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},++t);
  lifeMod.generate(user,{day,kind:'plan',version:d.version},++t);
  st=domainState(user,{day},db()).domains;
  const workLogs=st.filter(x=>x.domain==='work');
  assert.ok(workLogs.some(x=>x.state==='normal'&&x.decision==='reuse'&&x.plan_version===1),'有有效方案且无信号 → 正常沿用，不触发深度分析');
  assert.ok(workLogs.some(x=>x.reasons.some(r=>r.includes('复核时间'))),'有效期与复核时间提示可查');
  assert.equal(st.find(x=>x.domain==='fitness').state,'adjust','有资料无方案的领域仍需分析');
  assert.equal(st.find(x=>x.domain==='diet').state,'insufficient','缺资料的领域仍不算正常，不会误判为沿用');
  // 同一天同输入再次生成：不重复派发同类分析任务（成功结果被复用为统筹依赖）
  const analysesBefore=q.listJobs(user,++t).jobs.filter(x=>x.day===day&&x.action.startsWith('analysis.'));
  assert.ok(analysesBefore.length>=3,'第一次生成的分析任务已保留');
  assert.ok(analysesBefore.every(x=>x.status==='succeeded'),'同输入分析结果保留为可复用成功结果');
  d=lifeMod.overview(user,day).day;d=lifeMod.updateDay(user,{day,version:d.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}},++t);
  lifeMod.generate(user,{day,kind:'plan',version:d.version},++t);
  const analysesAfter=q.listJobs(user,++t).jobs.filter(x=>x.day===day&&x.action.startsWith('analysis.'));
  assert.ok(analysesAfter.length<=analysesBefore.length,'同一天不会因重复生成而重复派发同类分析任务（复用成功结果）');
  assert.ok(domainState(user,{day,domain:'fitness'},db()).domains.some(x=>x.reasons.some(r=>r.includes('不重复派发'))),'去重原因记录在审计中');
  // 补齐 diet 目标后：diet 变为有资料无方案 → adjust（重新分析）
  answer('diet','diet.goal','控制体重');
  const adj=assessDomain(db(),user,'diet',day,lifeMod.context(db(),user,day),new Date(++t));
  assert.equal(adj.state,'adjust','资料补齐且尚无有效方案 → 需生成方案');
  assert.ok(adj.reasons.some(r=>r.includes('尚无领域方案')||r.includes('没有已确认')),'调整原因可查询');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
