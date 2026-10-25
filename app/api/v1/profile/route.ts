import {authorize} from '@/server/auth.mjs';
import {json,failure} from '@/server/http.mjs';
import {profile} from '@/server/profile.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(req:Request){try{const u=authorize(req);return json(profile(u.id))}catch(e){return failure(e)}}
