import {authorize} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
import {createRawInput,listRawInputs} from '@/server/records.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(req:Request){try{const u=authorize(req);return json(listRawInputs(u.id,new URL(req.url).searchParams))}catch(e){return failure(e)}}
export async function POST(req:Request){try{const u=authorize(req,{write:true});const d=await body(req,256000);return json(createRawInput(u.id,u.keyId||'website',d),201)}catch(e){return failure(e)}}
