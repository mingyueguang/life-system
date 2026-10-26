import {plans,adjustPlan,currentPlan} from '@/server/domain-plans.mjs';
import {db} from '@/server/database.mjs';
import {authorize} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(req:Request){try{const u=authorize(req);const url=new URL(req.url);
 const domain=url.searchParams.get('domain')||null,status=url.searchParams.get('status')||null;
 // 当前状态与历史判断分开：current=各域当前有效方案（confirmed 且未过复核时间，服务器判定）；
 // plans=查询范围内的完整历史（含 superseded/needs_review 等），前端不需要自己猜哪条最新。
 const current=['work','fitness','diet'].map(x=>currentPlan(db(),u.id,x)).filter(Boolean);
 return json({current,plans:plans(u.id,domain,status)})}catch(e){return failure(e)}}
export async function POST(req:Request){try{const u=authorize(req,{write:true});const d=await body(req,4096);return json(adjustPlan(u.id,d.domain,d.reason,u.keyId||'website'))}catch(e){return failure(e)}}
