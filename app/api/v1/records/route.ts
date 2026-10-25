import {authorize} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
import {readRecords,saveRecord} from '@/server/records.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(req:Request){try{const u=authorize(req);return json(readRecords(u.id,new URL(req.url).searchParams))}catch(e){return failure(e)}}
export async function POST(req:Request){try{const u=authorize(req,{write:true});return json(saveRecord(u.id,u.keyId||'website',await body(req,256000)))}catch(e){return failure(e)}}
