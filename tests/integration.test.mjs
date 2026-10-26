import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';

test('independent account, API permissions, persistence and conflict protection', {timeout:60000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'life-test-'));
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const origin='https://life.test',bootstrap=randomBytes(32).toString('hex');
  let child,logs='';
  async function start(){
    child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',APP_ORIGIN:origin,BOOTSTRAP_TOKEN:bootstrap,DATABASE_PATH:join(dir,'life.sqlite')},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
    for(let i=0;i<150;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/auth/status`);if(r.ok)return;}catch{}if(child.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,100));}throw Error('Server startup timeout: '+logs);
  }
  async function stop(){if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}}
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
  async function req(path,{method='GET',data,cookie,token,requestOrigin=origin}={}){
    const headers={};if(data!==undefined)headers['Content-Type']='application/json';if(method!=='GET'&&requestOrigin)headers.Origin=requestOrigin;if(cookie)headers.Cookie=cookie;if(token)headers.Authorization=`Bearer ${token}`;
    const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')};
  }
  await start();
  const protocol=await req('/api/agent/v1/');assert.equal(protocol.status,200);assert.ok(protocol.data.actions['daily.plan'].output_schema.required.includes('items'));
  assert.equal(protocol.data.protocol_version,'1.7.0');
  assert.ok(protocol.data.actions['feishu.publish.fitness']&&protocol.data.actions['feishu.publish.diet']);
  assert.equal(protocol.data.actions['feishu.publish.fitness'].output_schema.required.includes('receipts'),true);
  // 契约自描述：错误码字典、租约时长与外部效果声明随协议返回，AI 不需要猜。
  assert.ok(protocol.data.error_catalog.some(x=>x.code==='CONFLICT'&&x.action));
  assert.equal(protocol.data.actions['daily.plan'].lease_seconds,600);
  assert.equal(protocol.data.actions['daily.plan'].external_effect,false);
  assert.equal(protocol.data.actions['feishu.publish'].lease_seconds,120);
  assert.equal(protocol.data.actions['feishu.publish'].external_effect,true);
  const health=await req('/api/agent/v1/health');assert.equal(health.data.release,'1.7.0');
  assert.equal((await req('/api/v1/records')).status,401);
  assert.equal((await req('/api/auth/status')).data.registered,false);
  const email='owner@example.test',password='Long-test-password-123!';
  const registration={email,password,bootstrapToken:bootstrap};
  assert.equal((await req('/api/auth/register',{method:'POST',data:registration,requestOrigin:'https://attacker.test'})).status,403);
  assert.equal((await req('/api/auth/register',{method:'POST',data:{...registration,bootstrapToken:'wrong'}})).status,403);
  const registered=await req('/api/auth/register',{method:'POST',data:registration});assert.equal(registered.status,201);assert.match(registered.cookie,/HttpOnly/);assert.match(registered.cookie,/Secure/);
  const cookie=registered.cookie.split(';')[0];
  assert.equal((await req('/api/auth/register',{method:'POST',data:registration})).status,403);
  assert.equal((await req('/api/auth/login',{method:'POST',data:{email,password:'incorrect'}})).status,401);
  const logged=await req('/api/auth/login',{method:'POST',data:{email,password}});assert.equal(logged.status,200);
  const secondCookie=logged.cookie.split(';')[0];
  const read=await req('/api/keys',{method:'POST',cookie,data:{name:'reader',scope:'read',days:90}});assert.equal(read.status,201);
  const write=await req('/api/keys',{method:'POST',cookie,data:{name:'writer',scope:'write',days:90}});assert.equal(write.status,201);
  assert.equal((await req('/api/keys',{token:write.data.token})).status,401);

  const worker=await req('/api/keys',{method:'POST',cookie,data:{name:'doubao',scope:'worker',days:90}});assert.equal(worker.status,201);
  const worker2=await req('/api/keys',{method:'POST',cookie,data:{name:'other executor',scope:'worker',days:90}});assert.equal(worker2.status,201);
  assert.equal((await req('/api/v1/records',{token:worker.data.token})).status,200);
  assert.equal((await req('/api/v1/schema',{token:worker.data.token})).status,200);
  assert.equal((await req('/api/agent/v1/jobs',{token:worker.data.token})).status,200);
  assert.equal((await req('/api/agent/v1/jobs/claim',{method:'POST',token:write.data.token,data:{}})).status,200);
  assert.equal((await req('/api/agent/v1/jobs/claim',{method:'POST',cookie,data:{}})).status,401);
  const jobInput={idempotency_key:randomUUID(),target_key_id:worker.data.id,mode:'simulation',action:'simulation.noop',payload:{test:true}};
  assert.equal((await req('/api/agent/v1/jobs',{method:'POST',cookie,data:jobInput,requestOrigin:'https://attacker.test'})).status,403);
  const job=await req('/api/agent/v1/jobs',{method:'POST',cookie,data:jobInput});assert.equal(job.status,201);
  assert.equal((await req('/api/agent/v1/jobs',{method:'POST',cookie,data:jobInput})).data.job_id,job.data.job_id);
  assert.equal((await req('/api/agent/v1/jobs',{method:'POST',cookie,data:{...jobInput,action:'feishu.task.create'}})).status,400);
  assert.equal((await req('/api/agent/v1/jobs/claim',{method:'POST',token:worker2.data.token,data:{job_id:job.data.job_id}})).data.job,null);
  const claims=await Promise.all(Array.from({length:8},()=>req('/api/agent/v1/jobs/claim',{method:'POST',token:worker.data.token,data:{job_id:job.data.job_id}})));
  const claimed=claims.map(c=>c.data.job).filter(Boolean);assert.equal(claimed.length,1);
  const recovery=await req('/api/agent/v1/jobs/active',{token:worker.data.token});assert.equal(recovery.data.jobs[0].lease_token,claimed[0].lease_token);assert.equal(recovery.data.jobs[0].lease_expires_at,claimed[0].lease_expires_at);
  assert.equal((await req('/api/agent/v1/jobs/active',{token:worker2.data.token})).data.jobs.length,0);
  assert.equal((await req('/api/agent/v1/jobs/active',{token:read.data.token})).status,403);
  assert.ok(claimed[0].contract.success_example);

  const result={lease_token:claimed[0].lease_token,status:'succeeded',output:{simulated:true,external_effect:false,executor:'test'}};
  const resultUrl='/api/agent/v1/jobs/'+job.data.job_id+'/result';
  assert.equal((await req(resultUrl,{method:'POST',token:worker2.data.token,data:result})).status,404);
  assert.equal((await req(resultUrl,{method:'POST',token:worker.data.token,data:{...result,lease_token:'wrong'}})).status,409);
  assert.equal((await req(resultUrl,{method:'POST',token:worker.data.token,data:result})).status,200);
  assert.equal((await req(resultUrl,{method:'POST',token:worker.data.token,data:result})).data.duplicate,true);
  assert.equal((await req(resultUrl,{method:'POST',token:worker.data.token,data:{...result,status:'failed'}})).status,409);
  assert.equal((await req('/api/agent/v1/jobs',{cookie})).data.jobs[0].status,'succeeded');
  const revokeJob=await req('/api/agent/v1/jobs',{method:'POST',cookie,data:{...jobInput,idempotency_key:randomUUID(),target_key_id:worker2.data.id}});
  const revokeClaim=await req('/api/agent/v1/jobs/claim',{method:'POST',token:worker2.data.token,data:{job_id:revokeJob.data.job_id}});
  assert.equal((await req('/api/keys',{method:'DELETE',cookie,data:{id:worker2.data.id}})).status,200);
  assert.equal((await req('/api/agent/v1/jobs/'+revokeJob.data.job_id+'/result',{method:'POST',token:worker2.data.token,data:{...result,lease_token:revokeClaim.data.job.lease_token}})).status,401);

  // Live workflow over HTTP: old worker credentials retain business access;
  // write credentials can register and execute, read credentials cannot mutate.
  const day='2026-10-28';
  assert.equal((await req('/api/agent/v1/executors/register',{method:'POST',token:read.data.token,data:{name:'reader',capabilities:['analysis']}})).status,403);
  assert.equal((await req('/api/agent/v1/executors/register',{method:'POST',token:worker.data.token,data:{name:'Doubao',capabilities:['analysis'],max_parallel:1}})).status,200);
  // 单次授权：登记执行者持读写密钥即可修改设置（含飞书开关），不再要求网站会话。
  const settingsSaved=await req('/api/agent/v1/settings',{method:'POST',token:write.data.token,data:{enabled:true,plan_time:'23:59',review_time:'23:58',feishu:false,auto_adjust:{enabled:true,overrun_factor:2,energy_drop_threshold:2,skip_carryover:true}}});assert.equal(settingsSaved.status,200);assert.equal(settingsSaved.data.enabled,true);
  let overview=await req('/api/agent/v1/overview?day='+day,{cookie});assert.equal(overview.status,200);assert.equal(overview.data.settings.enabled,true);
  const daily={day,version:overview.data.day.version,operation:'input',data:{available_minutes:90,energy:3,fixed:'',note:''}};
  assert.equal((await req('/api/agent/v1/daily/update',{method:'POST',cookie,data:daily,requestOrigin:'https://attacker.test'})).status,403);
  const dailySaved=await req('/api/agent/v1/daily/update',{method:'POST',token:worker.data.token,data:daily});assert.equal(dailySaved.status,200);
  assert.equal((await req('/api/agent/v1/daily/update',{method:'POST',token:worker.data.token,data:daily})).status,409);
  assert.equal((await req('/api/agent/v1/daily/generate',{method:'POST',token:worker.data.token,data:{day,version:dailySaved.data.version,kind:'plan'}})).status,200);
  for(let i=0;i<4;i++){
   const c=await req('/api/agent/v1/jobs/claim',{method:'POST',token:worker.data.token,data:{}});assert.equal(c.status,200);assert.ok(c.data.job);
   const j=c.data.job;
   if(i===0){
    const bad=await req('/api/agent/v1/jobs/'+j.job_id+'/result',{method:'POST',token:worker.data.token,data:{lease_token:j.lease_token,status:'succeeded',output:{summary:'test',items:[]}}});
    assert.equal(bad.status,400);assert.equal(bad.data.code,'VALIDATION_ERROR');assert.ok(bad.data.details.some(x=>x.path==='output.missing'));assert.ok(bad.data.example.output.missing);
   }
   const output=j.action==='daily.plan'?{summary:'HTTP plan',items:[{id:randomUUID(),title:'Important action',minutes:30,reason:'Goal',task_id:null}],buffer_minutes:15,deferred:[],missing:[]}:j.action==='analysis.fitness'?{summary:'Fitness plan',sessions:[{id:randomUUID(),title:'Run',minutes:30,reason:'Goal'}],missing:['训练目标未确认']}:j.action==='analysis.diet'?{summary:'Diet plan',meals:[{id:randomUUID(),title:'Breakfast',reason:'Goal'}],missing:['饮食目标未确认']}:{summary:'Analysis',items:[{id:randomUUID(),title:'Keep buffer',reason:'avoid overload'}],missing:[]};
   assert.equal((await req('/api/agent/v1/jobs/'+j.job_id+'/result',{method:'POST',token:worker.data.token,data:{lease_token:j.lease_token,status:'succeeded',output}})).status,200);
  }
  overview=await req('/api/agent/v1/overview?day='+day,{cookie});assert.equal(overview.data.day.plan.summary,'HTTP plan');
  assert.equal((await req('/api/agent/v1/daily/update',{method:'POST',token:read.data.token,data:{day,version:overview.data.day.version,operation:'confirm'}})).status,403);
  assert.equal((await req('/api/agent/v1/daily/update',{method:'POST',cookie,data:{day,version:overview.data.day.version,operation:'confirm'}})).status,200);

  // 单次授权：AI 通道可确认资料整理建议（accept_evidence）；执行者写入审计与记录历史。
  const profileId=randomUUID();
  const profileWrite=await req('/api/v1/records',{method:'POST',token:write.data.token,data:{request_id:randomUUID(),id:profileId,kind:'profile',version:0,data:{topic:'工作现状',statement:'测试状态',status:'known',note:''},metadata:{source:{method:'user_report',original_text:'测试输入'},certainty:'reported'}}});assert.equal(profileWrite.status,200);
  const intakeView=await req('/api/agent/v1/intake?domain=work',{token:write.data.token});assert.equal(intakeView.status,200);
  const started=await req('/api/agent/v1/intake/start',{method:'POST',token:write.data.token,data:{domain:'work',context_hash:intakeView.data.context_hash}});assert.equal(started.status,200);assert.ok(started.data.job_id);
  const claimIntake=await req('/api/agent/v1/jobs/claim',{method:'POST',token:worker.data.token,data:{}});
  assert.ok(claimIntake.data.job&&claimIntake.data.job.action==='intake.work');
  const ijob=claimIntake.data.job;
  const iout={summary:'收集结论',evidence:[{field_key:'work.current',record_id:profileId,record_version:1,value:'整理后的现状',reason:'来自用户输入'}],questions:[]};
  assert.equal((await req('/api/agent/v1/jobs/'+ijob.job_id+'/result',{method:'POST',token:worker.data.token,data:{lease_token:ijob.lease_token,status:'succeeded',output:iout}})).status,200);
  const intakeView2=await req('/api/agent/v1/intake?domain=work',{token:write.data.token});
  const fld=intakeView2.data.fields.find(f=>f.key==='work.current');
  assert.ok(fld&&fld.token);
  assert.equal((await req('/api/agent/v1/intake/update',{method:'POST',token:write.data.token,data:{request_id:randomUUID(),domain:'work',field_key:'work.current',token:fld.token,operation:'accept_evidence',report_job_id:ijob.job_id,evidence_index:0}})).status,200);

  assert.equal((await req('/api/v1/schema',{token:read.data.token})).status,200);
  const record={id:randomUUID(),kind:'account',version:0,data:{title:'Test cash',balance:120000,note:''}};
  assert.equal((await req('/api/v1/records',{method:'POST',token:read.data.token,data:record})).status,403);
  assert.equal((await req('/api/v1/records',{method:'POST',cookie,data:record,requestOrigin:'https://attacker.test'})).status,403);
  assert.equal((await req('/api/v1/records',{method:'POST',token:write.data.token,data:{...record,data:{...record.data,balance:1.5}}})).status,400);
  const saved=await req('/api/v1/records',{method:'POST',token:write.data.token,data:record});assert.equal(saved.status,200);assert.equal(saved.data.record.version,1);
  assert.equal((await req('/api/v1/records',{method:'POST',token:write.data.token,data:record})).status,409);
  const updated=await req('/api/v1/records',{method:'POST',token:write.data.token,data:{...record,version:1,data:{...record.data,balance:110000}}});assert.equal(updated.data.record.version,2);
  await stop();await start();
  const rows=await req('/api/v1/records',{cookie});const accountRow=rows.data.records.find(r=>r.id===record.id);assert.ok(accountRow);assert.equal(accountRow.data.balance,110000);
  assert.equal((await req('/api/keys',{method:'DELETE',cookie,data:{id:read.data.id}})).status,200);
  assert.equal((await req('/api/v1/records',{token:read.data.token})).status,401);
  const deleted=await req('/api/v1/records',{method:'POST',token:write.data.token,data:{...record,version:2,deleted:true}});assert.equal(deleted.status,200);
  assert.equal((await req('/api/v1/records',{cookie})).data.records.some(r=>r.id===record.id),false);
  const sinceRows=(await req('/api/v1/records?since=2000-01-01T00%3A00%3A00.000Z',{cookie})).data.records;assert.equal(sinceRows.find(r=>r.id===record.id).deleted,true);
  const schema=await req('/api/v1/schema',{token:write.data.token});assert.equal(schema.status,200);assert.equal(schema.data.protocolVersion,'1.7.0');assert.ok(schema.data.schemas.mood.properties.text);assert.ok(schema.data.metadataSchema.properties.source);
  const provenance={request_id:randomUUID(),id:randomUUID(),kind:'phone_usage',version:0,data:{date:'2026-10-25',minutes:90},metadata:{source:{method:'device',original_text:'设备统计 90 分钟'}}};
  assert.equal((await req('/api/v1/records',{method:'POST',token:write.data.token,data:provenance})).status,200);
  assert.equal((await req('/api/v1/records',{method:'POST',token:write.data.token,data:provenance})).data.duplicate,true);
  assert.equal((await req('/api/v1/records?id='+provenance.id+'&history=true',{token:write.data.token})).data.history.length,1);
  const malformed=await fetch(`http://127.0.0.1:${port}/api/v1/records`,{method:'POST',headers:{Authorization:'Bearer '+write.data.token,'Content-Type':'application/json'},body:'{"secret":"do-not-echo",}'});const malformedBody=await malformed.json();assert.equal(malformed.status,400);assert.equal(malformedBody.code,'INVALID_JSON');assert.ok(!JSON.stringify(malformedBody).includes('do-not-echo'));
  // v1.3.0：原始资料、统一档案、复核与过滤（HTTP 层）
  // 注：此前第 114 行已删除 reader 密钥，本块新建独立的只读密钥用于权限断言。
  const readOnly=await req('/api/keys',{method:'POST',cookie,data:{name:'reader2',scope:'read',days:90}});assert.equal(readOnly.status,201);
  const rawReqId=randomUUID(),rawText='混合输入：昨晚睡六小时，跑了两公里';
  const src=await req('/api/v1/sources',{method:'POST',token:write.data.token,data:{request_id:rawReqId,method:'user_report',original_text:rawText}});assert.equal(src.status,201);assert.ok(src.data.source.id);
  const shared=src.data.source.id;
  const srcReadResp=await req('/api/v1/sources',{method:'POST',token:readOnly.data.token,data:{method:'user_report',original_text:'只读密钥不能写'}});assert.equal(srcReadResp.status,403);
  const sleepRec={request_id:randomUUID(),id:randomUUID(),kind:'sleep',version:0,data:{date:'2026-10-26',hours:6,note:''},source_id:shared,metadata:{source:{method:'user_report',original_text:'昨晚睡六小时'},certainty:'inferred'}};
  const runRec={request_id:randomUUID(),id:randomUUID(),kind:'exercise',version:0,data:{date:'2026-10-26',title:'跑步',minutes:20,note:''},source_id:shared,metadata:{source:{method:'user_report',original_text:'跑了两公里'}}};
  assert.equal((await req('/api/v1/records',{method:'POST',token:write.data.token,data:sleepRec})).status,200);
  assert.equal((await req('/api/v1/records',{method:'POST',token:write.data.token,data:runRec})).status,200);
  const sourceDetail=await req('/api/v1/sources/'+shared,{token:readOnly.data.token});assert.equal(sourceDetail.data.records.length,2);
  assert.equal((await req('/api/v1/records?source='+shared,{token:readOnly.data.token})).data.records.length,2);
  const profileRes=await req('/api/v1/profile',{token:readOnly.data.token});assert.equal(profileRes.status,200);assert.ok(profileRes.data.domains.work&&profileRes.data.domains.fitness&&profileRes.data.domains.diet);assert.ok(profileRes.data.suggested_questions.length>0);assert.ok(profileRes.data.recent_changes.some(x=>x.record_id===sleepRec.id));
  // 复核：网站会话与已登记 AI 执行者都可确认/否定 AI 推断；执行者身份写入 metadata.review.actor。
  assert.equal((await req('/api/v1/records/review',{method:'POST',cookie,data:{id:sleepRec.id,version:1,decision:'confirm'},requestOrigin:'https://attacker.test'})).status,403);
  const reviewed=await req('/api/v1/records/review',{method:'POST',cookie,data:{id:sleepRec.id,version:1,decision:'confirm'}});assert.equal(reviewed.status,200);assert.equal(reviewed.data.record.metadata.review.status,'confirmed');
  const aiReview=await req('/api/v1/records/review',{method:'POST',token:write.data.token,data:{id:sleepRec.id,version:2,decision:'reject'}});assert.equal(aiReview.status,200);assert.equal(aiReview.data.record.metadata.review.status,'rejected');assert.equal(aiReview.data.record.metadata.review.actor,write.data.id);
  assert.equal((await req('/api/v1/records/review',{method:'POST',cookie,data:{id:sleepRec.id,version:1,decision:'reject'}})).status,409);
  // 归档后普通列表排除，原始资料仍列出（审计保留）
  assert.equal((await req('/api/v1/records',{method:'POST',token:write.data.token,data:{...runRec,request_id:randomUUID(),version:1,deleted:true}})).status,200);
  const listAfterArchive=(await req('/api/v1/records',{cookie})).data.records;assert.ok(listAfterArchive.some(r=>r.id===sleepRec.id)&&listAfterArchive.some(r=>r.id===provenance.id));assert.equal(listAfterArchive.some(r=>r.id===runRec.id),false);
  assert.equal((await req('/api/v1/sources/'+shared,{token:readOnly.data.token})).data.records.length,2);
  // Schema 文档与实现保持同步
  const schemaDoc=await req('/api/v1/schema',{token:readOnly.data.token});assert.ok(schemaDoc.data.sources.includes('/api/v1/sources'));assert.ok(schemaDoc.data.profile.includes('/api/v1/profile'));assert.ok(schemaDoc.data.review.includes('/api/v1/records/review'));
  // 单次授权：AI 通道可调用领域方案确认（本账户无候选方案，鉴权通过则返回 404 而非 401/403）。
  assert.equal((await req('/api/v1/plans/confirm',{method:'POST',token:write.data.token,data:{domain:'fitness',version:99}})).status,404);
  const changed=await req('/api/auth/password',{method:'POST',cookie,data:{currentPassword:password,password:'New-long-test-password!'}});assert.equal(changed.status,200);
  assert.equal((await req('/api/v1/records',{cookie:secondCookie})).status,401);
  const newCookie=changed.cookie.split(';')[0];
  assert.equal((await req('/api/v1/records',{token:write.data.token})).status,200);
  assert.equal((await req('/api/auth/logout',{method:'POST',cookie:newCookie})).status,200);
  assert.equal((await req('/api/v1/records',{cookie:newCookie})).status,401);
});
