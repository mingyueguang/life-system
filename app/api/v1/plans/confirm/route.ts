import {authorize,HttpError} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
import {confirmPlan} from '@/server/domain-plans.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(req:Request){try{
 const u=authorize(req,{sessionOnly:true,write:true});
 if(u.type!=='session')throw new HttpError(403,'领域方案请由用户在网站确认');
 const d=await body(req,4096);
 return json(confirmPlan(u.id,d.domain,d.version,'website'));
}catch(e){return failure(e)}}
