import {authorize} from '@/server/auth.mjs';
import {json,failure} from '@/server/http.mjs';
import {getRawInput} from '@/server/records.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(req:Request){try{const u=authorize(req);return json(getRawInput(u.id,new URL(req.url).pathname.split('/').filter(Boolean).at(-1)||''))}catch(e){return failure(e)}}
