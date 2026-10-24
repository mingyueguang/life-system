import {requireOrigin,logout,sessionCookie} from '@/server/auth.mjs';
import {json,failure} from '@/server/http.mjs';
export const runtime='nodejs';
export async function POST(req:Request){try{requireOrigin(req);logout(req);return json({ok:true},200,{'Set-Cookie':sessionCookie('',0)})}catch(e){return failure(e)}}
