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
  assert.equal((await req('/api/v1/records',{token:worker.data.token})).status,403);
  assert.equal((await req('/api/v1/schema',{token:worker.data.token})).status,403);
  assert.equal((await req('/api/agent/v1/jobs',{token:worker.data.token})).status,401);
  assert.equal((await req('/api/agent/v1/jobs/claim',{method:'POST',token:write.data.token,data:{}})).status,403);
  assert.equal((await req('/api/agent/v1/jobs/claim',{method:'POST',cookie,data:{}})).status,401);
  const jobInput={idempotency_key:randomUUID(),target_key_id:worker.data.id,mode:'simulation',action:'simulation.noop',payload:{test:true}};
  assert.equal((await req('/api/agent/v1/jobs',{method:'POST',cookie,data:jobInput,requestOrigin:'https://attacker.test'})).status,403);
  const job=await req('/api/agent/v1/jobs',{method:'POST',cookie,data:jobInput});assert.equal(job.status,201);
  assert.equal((await req('/api/agent/v1/jobs',{method:'POST',cookie,data:jobInput})).data.job_id,job.data.job_id);
  assert.equal((await req('/api/agent/v1/jobs',{method:'POST',cookie,data:{...jobInput,action:'feishu.task.create'}})).status,400);
  assert.equal((await req('/api/agent/v1/jobs/claim',{method:'POST',token:worker2.data.token,data:{job_id:job.data.job_id}})).data.job,null);
  const claims=await Promise.all(Array.from({length:8},()=>req('/api/agent/v1/jobs/claim',{method:'POST',token:worker.data.token,data:{job_id:job.data.job_id}})));
  const claimed=claims.map(c=>c.data.job).filter(Boolean);assert.equal(claimed.length,1);
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

  assert.equal((await req('/api/v1/schema',{token:read.data.token})).status,200);
  const record={id:randomUUID(),kind:'account',version:0,data:{title:'Test cash',balance:120000,note:''}};
  assert.equal((await req('/api/v1/records',{method:'POST',token:read.data.token,data:record})).status,403);
  assert.equal((await req('/api/v1/records',{method:'POST',cookie,data:record,requestOrigin:'https://attacker.test'})).status,403);
  assert.equal((await req('/api/v1/records',{method:'POST',token:write.data.token,data:{...record,data:{...record.data,balance:1.5}}})).status,400);
  const saved=await req('/api/v1/records',{method:'POST',token:write.data.token,data:record});assert.equal(saved.status,200);assert.equal(saved.data.record.version,1);
  assert.equal((await req('/api/v1/records',{method:'POST',token:write.data.token,data:record})).status,409);
  const updated=await req('/api/v1/records',{method:'POST',token:write.data.token,data:{...record,version:1,data:{...record.data,balance:110000}}});assert.equal(updated.data.record.version,2);
  await stop();await start();
  const rows=await req('/api/v1/records',{cookie});assert.equal(rows.data.records.length,1);assert.equal(rows.data.records[0].data.balance,110000);
  assert.equal((await req('/api/keys',{method:'DELETE',cookie,data:{id:read.data.id}})).status,200);
  assert.equal((await req('/api/v1/records',{token:read.data.token})).status,401);
  const deleted=await req('/api/v1/records',{method:'POST',token:write.data.token,data:{...record,version:2,deleted:true}});assert.equal(deleted.status,200);
  assert.equal((await req('/api/v1/records',{cookie})).data.records.length,0);
  assert.equal((await req('/api/v1/records?since=2000-01-01T00%3A00%3A00.000Z',{cookie})).data.records[0].deleted,true);
  const changed=await req('/api/auth/password',{method:'POST',cookie,data:{currentPassword:password,password:'New-long-test-password!'}});assert.equal(changed.status,200);
  assert.equal((await req('/api/v1/records',{cookie:secondCookie})).status,401);
  const newCookie=changed.cookie.split(';')[0];
  assert.equal((await req('/api/v1/records',{token:write.data.token})).status,200);
  assert.equal((await req('/api/auth/logout',{method:'POST',cookie:newCookie})).status,200);
  assert.equal((await req('/api/v1/records',{cookie:newCookie})).status,401);
});
