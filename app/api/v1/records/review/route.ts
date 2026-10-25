import {authorize,HttpError} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
import {reviewRecord} from '@/server/records.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(req:Request){try{
 const u=authorize(req,{sessionOnly:true,write:true});
 // AI 不得确认或否定自己的推断；纠错请走正常写入流程（版本号递增 + 新数据）。
 if(u.type!=='session')throw new HttpError(403,'AI 提取的信息请由用户在网站核对');
 return json(reviewRecord(u.id,'website',await body(req,4096)));
}catch(e){return failure(e)}}
