import {requireOrigin,registerOwner,newSession,sessionCookie} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
export const runtime='nodejs';
export async function POST(req:Request){try{requireOrigin(req);const d=await body(req,4096);const user=await registerOwner(d.email,d.password,d.bootstrapToken);return json({user},201,{'Set-Cookie':sessionCookie(newSession(user.id))})}catch(e){return failure(e)}}
