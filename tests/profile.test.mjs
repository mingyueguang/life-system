import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('profile continuation: AI-B resumes AI-A work without chat context',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-profile-'));process.env.DATABASE_PATH=join(dir,'db.sqlite');
 const {db,closeDb}=await import('../server/database.mjs');
 const {saveRecord}=await import('../server/records.mjs');
 const {profile}=await import('../server/profile.mjs');
 const i=await import('../server/intake.mjs');
 const {registerExecutor}=await import('../server/life.mjs');
 const now=Date.now();
 try{
  const d=db();d.prepare('INSERT INTO users VALUES(?,?,?,?)').run('owner','test@example.test','hash','date');
  for(const key of ['a','b']){d.prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?)').run(key,'hash'+key,'owner',key,'write','date',now+86400000);registerExecutor('owner',key,{name:key,capabilities:['analysis'],max_parallel:1},now)}
  // AI-A 通过 intake 写入资料
  const view=i.intakeOverview('owner','work');
  const field=view.fields.find(x=>x.key==='work.goal');
  i.updateIntake('owner','a',{request_id:randomUUID(),domain:'work',field_key:field.key,token:field.token,operation:'answer',answer:'建立稳定的创作收入'},now);
  // AI-B 没有任何聊天上下文，只凭密钥读取统一档案接续
  const p=profile('owner');
  assert.equal(p.domains.work.fields.find(f=>f.key==='work.goal').status,'known','AI-A 收集的资料 AI-B 可见');
  assert.equal(p.fields.find(f=>f.key==='work.goal').status,'known');
  assert.ok(!p.suggested_questions.some(q=>q.field_key==='work.goal'),'已确认资料不再进入建议追问');
  assert.ok(p.suggested_questions.some(q=>q.field_key==='work.current'),'仍缺的必要资料进入建议追问');
  assert.ok(p.recent_changes.some(x=>x.record_id===p.fields.find(f=>f.key==='work.goal').record_id));
  // 暂缓后 AI-B 也能看到 deferred，且不追问
  const current=p.domains.work.fields.find(f=>f.key==='work.current');
  i.updateIntake('owner','b',{request_id:randomUUID(),domain:'work',field_key:current.key,token:current.token,operation:'defer'},now);
  const p2=profile('owner');
  assert.equal(p2.fields.find(f=>f.key==='work.current').status,'deferred');
  assert.ok(!p2.suggested_questions.some(q=>q.field_key==='work.current'));
  // 一次回答多个问题（answer_many）
  const view2=i.intakeOverview('owner','diet');
  const targets=view2.fields.filter(f=>['diet.goal','diet.routine','shared.time'].includes(f.key)).map(f=>({field_key:f.key,token:f.token,answer:'批量答案-'+f.key}));
  const multiReqId=randomUUID();
  const multi=i.updateIntake('owner','website',{request_id:multiReqId,domain:'diet',operation:'answer_many',answers:targets},now);
  assert.deepEqual(multi.fields.map(f=>[f.key,f.status]),targets.map(t=>[t.field_key,'known']));
  // 幂等：同一请求编号重复提交不重复入库
  const again=i.updateIntake('owner','website',{request_id:multiReqId,domain:'diet',operation:'answer_many',answers:targets},now);
  assert.equal(again.duplicate,true);
  // 用户纠错后：所有 Agent 读到最新有效版本，派生确认失效为 needs_review
  const goalField=profile('owner').fields.find(f=>f.key==='work.goal');
  saveRecord('owner','website',{id:goalField.record_id,kind:'profile',version:goalField.record_version,data:{topic:goalField.label,statement:'纠正后的目标',status:'known',note:'资料收集字段：work.goal'}});
  const p3=profile('owner');
  assert.equal(p3.fields.find(f=>f.key==='work.goal').status,'needs_review','用户修改后旧确认失效，待重新核实');
  // AI 推断不会变成事实：未链接到 intake 字段的推断记录不会出现在“已确认资料”里，
  // 而是保留在 recent_changes 与待核实列表（由 certainty/review 承接，dashboard 呈现）。
  const inferredId=randomUUID();
  saveRecord('owner','ai-A',{id:inferredId,kind:'profile',version:0,data:{topic:'work.cashflow',statement:'AI 推断内容',status:'needs_review',note:'资料收集字段：work.cashflow'},metadata:{certainty:'inferred'}});
  const p4=profile('owner');
  assert.notEqual(p4.fields.find(f=>f.key==='work.cashflow').status,'known','推断未确认前不算已确认事实');
  assert.ok(p4.recent_changes.some(x=>x.record_id===inferredId),'推断记录进入最近变更，供网站待核实入口呈现');
  closeDb();
  assert.equal(profile('owner').domains.work.counts.known>=1,true,'持久化后接续仍可用');
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
