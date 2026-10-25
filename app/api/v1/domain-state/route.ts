import {domainState} from '@/server/domain-state.mjs';
import {authorize} from '@/server/auth.mjs';
import {json,failure} from '@/server/http.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(req:Request){try{const u=authorize(req);const url=new URL(req.url);return json(domainState(u.id,{day:url.searchParams.get('day')||undefined,domain:url.searchParams.get('domain')||undefined}))}catch(e){return failure(e)}}
