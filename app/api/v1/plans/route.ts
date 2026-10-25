import {plans,adjustPlan} from '@/server/domain-plans.mjs';
import {authorize} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(req:Request){try{const u=authorize(req);const url=new URL(req.url);return json(plans(u.id,url.searchParams.get('domain')||null,url.searchParams.get('status')||null))}catch(e){return failure(e)}}
export async function POST(req:Request){try{const u=authorize(req,{write:true});const d=await body(req,4096);return json(adjustPlan(u.id,d.domain,d.reason,u.keyId||'website'))}catch(e){return failure(e)}}
