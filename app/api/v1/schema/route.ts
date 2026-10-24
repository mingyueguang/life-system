import {catalog} from '@/lib/model';
import {authorize} from '@/server/auth.mjs';
import {json,failure} from '@/server/http.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(req:Request){try{authorize(req);return json({apiVersion:1,catalog,moneyUnit:'integer CNY cents',write:'POST /api/v1/records {id:UUID,kind,version:0 for new or last-read version,data,deleted?:boolean}',read:'GET /api/v1/records?kind=&since=UTC_ISO&cursor=',sync:'飞书同步未启用，保留稳定 UUID、版本、更新时间与软删除标记。'})}catch(e){return failure(e)}}
