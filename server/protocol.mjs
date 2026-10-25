import {intakeOutputSchema} from './intake.mjs';
import {planSchema,analysisSchema,fitnessPlanSchema,dietPlanSchema,reviewSchema,publishSchema} from './life.mjs';
export const protocolVersion='1.5.0';
// Derive the wire schema from the same validators that accept results.
export function jsonSchema(s){const d=s._def;switch(d.typeName){
 case 'ZodObject':{const shape=s.shape;return {type:'object',properties:Object.fromEntries(Object.entries(shape).map(([k,v])=>[k,jsonSchema(v)])),required:Object.entries(shape).filter(([,v])=>!v.isOptional()).map(([k])=>k),additionalProperties:d.unknownKeys!=='strict'}}
 case 'ZodString':{const r={type:'string'};for(const c of d.checks){if(c.kind==='min')r.minLength=c.value;if(c.kind==='max')r.maxLength=c.value;if(c.kind==='uuid')r.format='uuid';if(c.kind==='url')r.format='uri';if(c.kind==='datetime')r.format='date-time';if(c.kind==='regex')r.pattern=c.regex.source}return r}
 case 'ZodNumber':{const r={type:d.checks.some(c=>c.kind==='int')?'integer':'number'};for(const c of d.checks){if(c.kind==='min')r.minimum=c.value;if(c.kind==='max')r.maximum=c.value}return r}
 case 'ZodArray':return {type:'array',items:jsonSchema(d.type),...(d.minLength?{minItems:d.minLength.value}:{}),...(d.maxLength?{maxItems:d.maxLength.value}:{})};
 case 'ZodBoolean':return {type:'boolean'};
 case 'ZodEnum':return {type:'string',enum:d.values};
 case 'ZodUnion':return {anyOf:d.options.map(jsonSchema)};
 case 'ZodRecord':return {type:'object',additionalProperties:jsonSchema(d.valueType)};
 case 'ZodEffects':return {...jsonSchema(d.schema),description:'另受服务器语义校验约束，例如日期必须真实有效'};
 case 'ZodLiteral':return {const:d.value};
 case 'ZodNullable':return {anyOf:[jsonSchema(d.innerType),{type:'null'}]};
 case 'ZodOptional':return jsonSchema(d.innerType);
 case 'ZodDefault':return {...jsonSchema(d.innerType),default:d.defaultValue()};
 default:throw Error('Unsupported protocol validator: '+d.typeName);
}}
const examples={
 intake:{summary:'已有资料与缺失信息概述，不制定计划',evidence:[],questions:[{field_key:'替换为当前角色提供的字段 key',question:'需要了解的问题',reason:'这个信息影响什么判断'}]},
 analysis:{summary:'基于已有记录的分析',recommendations:['保留机动时间'],missing:[]},
 fitness:{summary:'次日训练安排',sessions:[{id:'123e4567-e89b-42d3-a456-426614174000',title:'力量训练',minutes:45,reason:'与训练目标的关系'}],missing:[]},
 diet:{summary:'次日饮食安排',meals:[{id:'123e4567-e89b-42d3-a456-426614174000',title:'早餐：燕麦牛奶',reason:'与目标的关系'}],missing:[]},
 plan:{summary:'候选安排，请核对可用时间',items:[{id:'123e4567-e89b-42d3-a456-426614174000',title:'具体行动',minutes:30,reason:'与目标的关系',task_id:null}],buffer_minutes:15,deferred:[],missing:['可用时间尚未填写']},
 review:{summary:'当日复盘',observations:['基于实际反馈的观察'],adjustments:['后续调整'],missing:[]},
 publish:{external_effect:true,receipts:[{item_id:'替换为计划事项 ID',external_id:'替换为真实飞书回执 ID'}]},
 simulation:{simulated:true,external_effect:false,executor:'你的身份名称',message:'连接测试完成'}
};
export function contract(action){
 const kind=action.startsWith('intake.')?'intake':action.startsWith('analysis.')?({'analysis.fitness':'fitness','analysis.diet':'diet'})[action]||'analysis':({'daily.plan':'plan','daily.review':'review','feishu.publish':'publish','feishu.publish.fitness':'publish','feishu.publish.diet':'publish','simulation.noop':'simulation'})[action];
 const s={intake:intakeOutputSchema,analysis:analysisSchema,fitness:fitnessPlanSchema,diet:dietPlanSchema,plan:planSchema,review:reviewSchema,publish:publishSchema}[kind];
 return {protocol_version:protocolVersion,output_schema:s?jsonSchema(s):{type:'object',required:['simulated','external_effect'],properties:{simulated:{const:true},external_effect:{const:false}}},success_example:{lease_token:'替换为领取响应中的值',status:'succeeded',output:examples[kind]},lease_seconds:action==='simulation.noop'||action.startsWith('feishu.publish')?120:600,external_effect:action.startsWith('feishu.publish'),rules:kind==='plan'?['事项 ID 必须为 UUID，示例 ID 不可重复使用','关联待办必须存在且未完成','总分钟数加机动时间不得超过已知可用时间','可用时间未知时 missing 必须说明，草案只是候选安排','核对清单中的已完成或过期记录仅作提示，周期事项照常安排；如确需继续，在 reason 说明理由']:kind==='fitness'||kind==='diet'?['关键资料未确认（见 context.intake.<domain>.required_missing）时必须列出 missing，禁止输出确定性方案；缺失时可保留候选','方案是候选，统筹会按最终选中事项发布，未选中时不会进入执行清单']:kind==='intake'?['一轮最多 3 问，不重复询问已知或暂缓字段','AI 推断不作为事实：确认/核实须在用户对话中取得真实意图后转达，执行者写入审计，不得自行确认自己的推断']:[]};
}
export function protocol(){return {protocol_version:protocolVersion,guide:'/ai-guide.md?v='+protocolVersion,schema:'/api/agent/v1/protocol',register:{method:'POST',path:'/api/agent/v1/executors/register',example:{name:'平台和账号标识',capabilities:['analysis'],max_parallel:1}},claim:{method:'POST',path:'/api/agent/v1/jobs/claim',example:{}},recover:{method:'GET',path:'/api/agent/v1/jobs/active',note:'仅返回当前密钥仍有效的任务和原租约，不续期、不重新执行外部操作'},heartbeat_interval_seconds:30,interface_catalog:{records:{title:'记录与资料写入',paths:['GET /api/v1/schema','POST /api/v1/sources','GET /api/v1/sources','GET /api/v1/sources/:id','POST /api/v1/records','GET /api/v1/records','POST /api/v1/records/review'],note:'原始信息、分类记录、查询、纠错、归档、来源与历史追溯；request_id 幂等；未知类型保存为 unclassified'},profile:{title:'个人档案与资料准备',paths:['GET /api/v1/profile','GET /api/agent/v1/intake','POST /api/agent/v1/intake/start','POST /api/agent/v1/intake/update'],note:'查询已知和缺失信息、提交回答、暂缓问题、核实推断（AI 通道可用；确认/核实须在用户对话同意后转达，执行者写入审计）'},goals_and_plans:{title:'目标与领域方案',paths:['POST /api/agent/v1/daily/generate','POST /api/agent/v1/daily/update','GET /api/v1/plans','POST /api/v1/plans','POST /api/v1/plans/confirm'],note:'长期目标存 records kind=goal；领域方案独立保存（版本/依据 source_job_id/有效期 review_at/状态）；确认、申请调整与资料纠错均可在 AI 通道完成（确认须用户对话同意后转达），操作执行者写入审计'},domain_state:{title:'领域状态',paths:['GET /api/v1/domain-state?day=&domain=','GET /api/v1/profile','GET /api/agent/v1/overview'],note:'四态（资料不足/正常/需要关注/需要调整）由服务器确定性推导并写入 domain_state_log；触发原因、缺失数据、所用方案版本与复核时间可查询；同一异常当天不重复派任务'},daily_plan:{title:'每日计划',paths:['POST /api/agent/v1/daily/generate','POST /api/agent/v1/daily/update','GET /api/agent/v1/overview'],note:'汇总三域候选、固定安排与重要临时事项生成次日草案；时间预算由服务器校验（总耗时+机动≤可用时间）；事项必须关联领域方案来源；不强制精确时间槽；普通记录写入不触发整套重算；统筹取舍只从确认快照派生发布'},execution:{title:'执行与反馈',paths:['POST /api/agent/v1/executors/register','POST /api/agent/v1/jobs/claim','GET /api/agent/v1/jobs/active','POST /api/agent/v1/jobs/:id/heartbeat','POST /api/agent/v1/jobs/:id/result','POST /api/agent/v1/jobs/:id/resolve','POST /api/agent/v1/events'],note:'执行者登记、领取、恢复执行、回传结果；反馈支持完成/部分完成/未完成及可选原因，不要求精确耗时；完成事项不重复结转；未完成带标记结转；明确反馈异常（部分/未完成）自动标记相关领域方案需复核；外部操作结果不明时不自动重做（飞书发布成功必须回传覆盖全部事项的回执）'},runtime:{title:'系统运行记录',paths:['GET /api/agent/v1/jobs','GET /api/agent/v1/health'],note:'任务状态与事件；为什么触发/为什么没触发的分析原因随后续阶段写入审计'}},error_catalog:[
 {code:'INVALID_REQUEST',status:400,meaning:'请求体不符合协议或业务校验',action:'按响应 details 中的字段路径修正；普通资料读写不需要租约'},
 {code:'VALIDATION_ERROR',status:400,meaning:'输出不符合该 action 的结构',action:'按响应 details 的字段路径修正 output 后用原租约重发；missing 没有内容也要提供 []，长任务继续发送心跳'},
 {code:'UNAUTHENTICATED',status:401,meaning:'缺少有效密钥或会话',action:'检查请求头 Authorization: Bearer <密钥>；不要生成或搜索其他凭据'},
 {code:'FORBIDDEN',status:403,meaning:'密钥无权限或执行者被暂停',action:'检查密钥 scope（读写/执行）与执行者状态；不要绕过'},
 {code:'NOT_FOUND',status:404,meaning:'接口或资源不存在',action:'按协议接口目录核对路径；不要猜测接口'},
 {code:'CONFLICT',status:409,meaning:'版本/租约/幂等冲突',action:'重新读取相关数据或任务状态（GET /jobs/active、GET /overview），用最新版本继续；不要用旧结果覆盖'},
 {code:'PAYLOAD_TOO_LARGE',status:413,meaning:'请求体过大',action:'压缩内容或分批提交'},
 {code:'UNSUPPORTED_MEDIA_TYPE',status:415,meaning:'请求头不是 application/json',action:'用 JSON 序列化生成请求体'},
 {code:'INTERNAL_ERROR',status:500,meaning:'服务器错误',action:'报告失败步骤与状态码，不要反复重试'}
],lease_rules:{notes:['只有需要执行过程的 live 任务使用租约；普通数据读写、档案查询、日记保存不需要租约','纯分析任务租约 10 分钟，模拟与外部操作租约 2 分钟，心跳建议每 30 秒一次，以响应的 lease_expires_at 为准','任务执行期间保持心跳；无法保持租约时不要启动外部操作'],recovery:{method:'GET',path:'/api/agent/v1/jobs/active',note:'返回原租约，不续期、不复活过期任务；若外部操作可能已完成，先核对结果，勿重复执行'}},actions:Object.fromEntries(['intake.work','intake.fitness','intake.diet','analysis.work','analysis.energy','analysis.fitness','analysis.diet','daily.plan','daily.review','feishu.publish','feishu.publish.fitness','feishu.publish.diet','simulation.noop'].map(a=>[a,contract(a)]))}}
