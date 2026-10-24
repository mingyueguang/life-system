import {authorize,createApiKey,HttpError} from '@/server/auth.mjs';
import {db} from '@/server/database.mjs';
import {json,body,failure} from '@/server/http.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(req:Request){try{const u=authorize(req,{sessionOnly:true});return json({keys:db().prepare('SELECT id,name,scope,created_at,expires_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC').all(u.id)})}catch(e){return failure(e)}}
export async function POST(req:Request){try{const u=authorize(req,{sessionOnly:true,write:true});const d=await body(req,4096);return json(createApiKey(u.id,d.name,d.scope,d.days),201)}catch(e){return failure(e)}}
export async function DELETE(req:Request){try{const u=authorize(req,{sessionOnly:true,write:true});const d=await body(req,4096);if(typeof d.id!=='string')throw new HttpError(400,'缺少密钥 ID');db().prepare('DELETE FROM api_keys WHERE user_id=? AND id=?').run(u.id,d.id);return json({ok:true})}catch(e){return failure(e)}}
