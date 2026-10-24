import {ownerExists,sessionUser,appOrigin} from '@/server/auth.mjs';
import {json,failure} from '@/server/http.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(req:Request){try{appOrigin();return json({registered:ownerExists(),user:sessionUser(req)})}catch(e){return failure(e)}}
