import {intakeOverview,startIntake,updateIntake} from '@/server/intake.mjs';
import {protocol} from '@/server/protocol.mjs';
import {authorize,HttpError} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
import {activeJobs,listJobs,createJob,claimJob,updateJob,resolveJob,saveEvent} from '@/server/agent-jobs.mjs';
import {overview,updateDay,generate,registerExecutor,setExecutor,saveSettings,today,tick} from '@/server/life.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(req:Request){try{
 const url=new URL(req.url),path=url.pathname;
 if(path==='/api/agent/v1/health')return json({status:'ok',api_version:1,mode:'collaboration',model_connected:false,auth:'site_api_keys',release:'1.5.0',protocol_url:'/api/agent/v1/protocol'});
 if(path==='/api/agent/v1'||path==='/api/agent/v1/'||path==='/api/agent/v1/protocol')return json(protocol());
 if(path==='/api/agent/v1/jobs/active'){const u=authorize(req,{workerOnly:true});return json(activeJobs(u.id,u.keyId))}
 const u=authorize(req);
 if(path==='/api/agent/v1/intake')return json(intakeOverview(u.id,url.searchParams.get('domain')||'work'));
 if(path==='/api/agent/v1/jobs')return json(listJobs(u.id));
 if(path==='/api/agent/v1/overview')return json(overview(u.id,url.searchParams.get('day')||today()));
 throw new HttpError(404,'接口不存在');
}catch(e){return failure(e)}}
export async function POST(req:Request){try{
 const path=new URL(req.url).pathname;
 const m=path.match(/^\/api\/agent\/v1\/jobs\/([^/]+)\/(heartbeat|result|resolve)$/);
 const worker=path.endsWith('/jobs/claim')||path.endsWith('/executors/register')||path.endsWith('/events')||m&&['heartbeat','result'].includes(m[2]);
 // 单次授权：登记的执行者持读写密钥即获得完整操作权限（读取/写入/确认/核实/设置），不再按操作单独授权。
 // 所有写操作都带执行者身份（keyId 或 'website'）进入审计或记录历史；
 // 确认/核实/设置类操作由协议约束为"用户对话同意后 AI 转达"，服务器只留痕、不设关卡。
 const u=worker?authorize(req,{workerOnly:true}):authorize(req,{write:true});
 const data=await body(req,256000);
 if(path==='/api/agent/v1/intake/start')return json(startIntake(u.id,data));
 if(path==='/api/agent/v1/intake/update')return json(updateIntake(u.id,u.keyId||'website',data));

 if(path==='/api/agent/v1/jobs')return json(createJob(u.id,data),201);
 if(path==='/api/agent/v1/jobs/claim'){tick();return json(claimJob(u.id,u.keyId,data))}
 if(path==='/api/agent/v1/events')return json(saveEvent(u.id,u.keyId,data));
 if(path==='/api/agent/v1/executors/register')return json(registerExecutor(u.id,u.keyId,data));
 if(path==='/api/agent/v1/executors/update')return json(setExecutor(u.id,data));
 if(path==='/api/agent/v1/daily/update')return json(updateDay(u.id,{...data,actor:u.keyId||'website'}));
 if(path==='/api/agent/v1/daily/generate')return json(generate(u.id,data));
 if(path==='/api/agent/v1/settings')return json(saveSettings(u.id,{...data,actor:u.keyId||'website'}));
 if(m)return json(m[2]==='resolve'?resolveJob(u.id,m[1],data):updateJob(u.id,u.keyId,m[1],m[2],data));
 throw new HttpError(404,'接口不存在');
}catch(e){return failure(e)}}
