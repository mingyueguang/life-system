import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('raw inputs: shared source, idempotency, filters, review and archive audit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'life-sources-'));process.env.DATABASE_PATH=join(dir,'db.sqlite');
 const {db,closeDb}=await import('../server/database.mjs');
 const {saveRecord,readRecords,createRawInput,listRawInputs,getRawInput,reviewRecord}=await import('../server/records.mjs');
 try{
  db().prepare('INSERT INTO users VALUES(?,?,?,?)').run('owner','test@example.test','hash','date');
  const reqId=randomUUID(),text='昨晚睡了六小时，早上跑了两公里';
  const first=createRawInput('owner','website',{request_id:reqId,method:'user_report',original_text:text});
  assert.ok(first.source.id);assert.equal(first.duplicate,false);
  // 幂等：同一请求编号重复提交返回同一原始资料
  assert.equal(createRawInput('owner','website',{request_id:reqId,method:'user_report',original_text:text}).duplicate,true);
  // 冲突：请求编号已用于不同内容
  assert.throws(()=>createRawInput('owner','website',{request_id:reqId,method:'device',original_text:'不同内容'}),e=>e.status===409);
  // 空原始资料被拒绝
  assert.throws(()=>createRawInput('owner','website',{method:'unknown'}),e=>e.status===400);
  // 一份输入 → 多类记录共享 source_id
  const sleep=saveRecord('owner','ai-A',{id:randomUUID(),kind:'sleep',version:0,data:{date:'2026-10-25',hours:6,note:''},metadata:{source:{method:'user_report',original_text:'昨晚睡了六小时'},certainty:'inferred'},source_id:first.source.id}).record;
  const exercise=saveRecord('owner','ai-B',{id:randomUUID(),kind:'exercise',version:0,data:{date:'2026-10-25',title:'跑步',minutes:30,note:''},metadata:{source:{method:'user_report',original_text:'早上跑了两公里'}},source_id:first.source.id}).record;
  assert.equal(sleep.source_id,first.source.id);assert.equal(exercise.source_id,first.source.id);
  // 未传 source_id 且带原文时自动创建原始资料
  const auto=saveRecord('owner','ai-C',{id:randomUUID(),kind:'sleep',version:0,data:{date:'2026-10-26',hours:7,note:''},metadata:{source:{method:'device',original_text:'设备统计 7 小时'}}}).record;
  assert.ok(auto.source_id);assert.equal(getRawInput('owner',auto.source_id).records.length,1);
  // 无原文也无 source_id 时不创建原始资料
  const plain=saveRecord('owner','website',{id:randomUUID(),kind:'mood',version:0,data:{text:'普通心情记录'}}).record;
  assert.equal(plain.source_id,null);
  // 查询过滤：按原始资料 / 按关联目标
  assert.equal(readRecords('owner',new URLSearchParams({source:first.source.id})).records.length,2);
  assert.equal(readRecords('owner',new URLSearchParams({source:auto.source_id})).records.length,1);
  assert.equal(readRecords('owner',new URLSearchParams({related:first.source.id})).records.length,0,'related 只匹配 related_ids 中的记录');
  // 归档后普通列表排除，但原始资料详情仍列出关联记录（含已归档）
  saveRecord('owner','website',{id:exercise.id,kind:'exercise',version:1,data:exercise.data,deleted:true});
  assert.equal(readRecords('owner',new URLSearchParams()).records.length,3,'sleep/auto/plain 可见，exercise 已归档');
  const detail=getRawInput('owner',first.source.id);
  assert.equal(detail.records.length,2,'原始资料保留全部关联记录供审计');
  assert.equal(detail.source.record_count,2,'record_count 统计全部关联记录（含已归档），供审计与计数');
  assert.equal(listRawInputs('owner').sources.length,2);
  // 用户确认/否定 AI 推断：服务器维护字段，绑定被核实版本，核实也递增版本并写历史
  const confirmed=reviewRecord('owner','website',{id:sleep.id,version:sleep.version,decision:'confirm'}).record;
  assert.equal(confirmed.metadata.review.status,'confirmed');assert.equal(confirmed.metadata.review.actor,'website');
  assert.equal(confirmed.metadata.review.verified_version,sleep.version,'核实绑定被核实版本');
  assert.equal(confirmed.version,sleep.version+1,'核实操作也递增版本');
  // 旧版本请求不能覆盖新决定（版本冲突保护）
  assert.throws(()=>reviewRecord('owner','website',{id:sleep.id,version:sleep.version,decision:'reject'}),e=>e.status===409);
  const rejected=reviewRecord('owner','website',{id:sleep.id,version:sleep.version+1,decision:'reject'}).record;
  assert.equal(rejected.metadata.review.status,'rejected');
  assert.equal(rejected.version,sleep.version+2);
  // 普通写入不能伪造用户确认：review 是服务器维护字段，客户端提交被剥离
  const forged=saveRecord('owner','ai-X',{id:randomUUID(),kind:'sleep',version:0,data:{date:'2026-10-25',hours:8,note:''},metadata:{review:{status:'confirmed',actor:'website',at:'2026-10-25T00:00:00+08:00'}}}).record;
  assert.equal(forged.metadata.review,null,'普通写入不能提交用户确认');
  // 修改事实后旧核实标记失效，回退待核实
  const edited=saveRecord('owner','website',{id:sleep.id,kind:'sleep',version:rejected.version,data:{date:'2026-10-25',hours:5,note:''}}).record;
  assert.equal(edited.metadata.review,null,'修改事实后核实标记重置');
  assert.equal(edited.version,rejected.version+1);
  // 核实操作进入修改历史
  const hist=readRecords('owner',new URLSearchParams({id:sleep.id,history:'true'})).history;
  assert.ok(hist.some(x=>x.actor==='website'&&x.record.metadata.review?.status==='rejected'),'核实操作写入历史');
  // 未知字段与缺失值不丢失：reclassify 到 mood 后 date/rating 保持空
  const unclassified=saveRecord('owner','ai-A',{id:randomUUID(),kind:'unclassified',version:0,data:{text:'今天心情不错'}}).record;
  const mood=saveRecord('owner','website',{id:unclassified.id,kind:'mood',version:1,reclassify:true,data:{text:'今天心情不错'}}).record;
  assert.equal(mood.data.rating,null);assert.equal(mood.data.date,'');
  closeDb();
  // 持久化：关闭后 source_id 仍在
  assert.equal(getRawInput('owner',first.source.id).records.length,2);
 }finally{closeDb();rmSync(dir,{recursive:true,force:true})}
});
