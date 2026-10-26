import {adjustmentRequests} from '@/server/domain-plans.mjs';
import {authorize} from '@/server/auth.mjs';
import {json,failure} from '@/server/http.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(req:Request){try{const u=authorize(req);const url=new URL(req.url);return json({adjustments:adjustmentRequests(u.id,{domain:url.searchParams.get('domain')||undefined,status:url.searchParams.get('status')||undefined})})}catch(e){return failure(e)}}
