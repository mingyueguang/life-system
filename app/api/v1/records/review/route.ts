import {authorize} from '@/server/auth.mjs';
import {json,body,failure} from '@/server/http.mjs';
import {reviewRecord} from '@/server/records.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(req:Request){try{
 const u=authorize(req,{write:true});
 // 单次授权：登记执行者可确认/否定 AI 提取信息；执行者身份写入 metadata.review.actor。
 // 协议约束：AI 须在用户对话中取得真实意图后转达，不得自行确认自己的推断。
 return json(reviewRecord(u.id,u.keyId||'website',await body(req,4096)));
}catch(e){return failure(e)}}
