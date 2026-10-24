import {authorize,HttpError} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
import {listJobs,createJob,claimJob,updateJob,resolveJob,saveEvent} from '@/server/agent-jobs.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(req:Request){try{
 const path=new URL(req.url).pathname;
 if(path==='/api/agent/v1/health')return json({status:'ok',api_version:1,mode:'simulation_only',model_connected:false,auth:'site_api_keys',release:'1.1.0'});
 const u=authorize(req,{sessionOnly:true});
 if(path==='/api/agent/v1/jobs')return json(listJobs(u.id));
 throw new HttpError(404,'接口不存在');
}catch(e){return failure(e)}}
export async function POST(req:Request){try{
 const path=new URL(req.url).pathname;
 const m=path.match(/^\/api\/agent\/v1\/jobs\/([^/]+)\/(heartbeat|result|resolve)$/);
 const control=path==='/api/agent/v1/jobs'||m?.[2]==='resolve';
 const u=control?authorize(req,{sessionOnly:true,write:true}):authorize(req,{workerOnly:true});
 const data=await body(req);
 if(path==='/api/agent/v1/jobs')return json(createJob(u.id,data),201);
 if(path==='/api/agent/v1/jobs/claim')return json(claimJob(u.id,u.keyId,data));
 if(path==='/api/agent/v1/events')return json(saveEvent(u.id,u.keyId,data));
 if(m)return json(m[2]==='resolve'?resolveJob(u.id,m[1],data):updateJob(u.id,u.keyId,m[1],m[2],data));
 throw new HttpError(404,'接口不存在');
}catch(e){return failure(e)}}
