import {authorize} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
import {confirmPlan} from '@/server/domain-plans.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(req:Request){try{
 const u=authorize(req,{write:true});
 const d=await body(req,4096);
 // 单次授权：登记执行者可直接确认候选方案；执行者身份（keyId 或 'website'）写入审计。
 return json(confirmPlan(u.id,d.domain,d.version,u.keyId||'website'));
}catch(e){return failure(e)}}
