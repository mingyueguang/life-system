import {authorize,changePassword,newSession,sessionCookie} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
export const runtime='nodejs';
export async function POST(req:Request){try{const u=authorize(req,{write:true,sessionOnly:true});const d=await body(req,4096);await changePassword(u.id,d.currentPassword,d.password);return json({ok:true},200,{'Set-Cookie':sessionCookie(newSession(u.id))})}catch(e){return failure(e)}}
