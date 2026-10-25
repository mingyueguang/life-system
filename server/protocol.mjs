import {planSchema,analysisSchema,reviewSchema,publishSchema} from './life.mjs';
export const protocolVersion='1.3.0';
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
 analysis:{summary:'基于已有记录的分析',recommendations:['保留机动时间'],missing:[]},
 plan:{summary:'候选安排，请核对可用时间',items:[{id:'123e4567-e89b-42d3-a456-426614174000',title:'具体行动',minutes:30,reason:'与目标的关系',task_id:null}],buffer_minutes:15,deferred:[],missing:['可用时间尚未填写']},
 review:{summary:'当日复盘',observations:['基于实际反馈的观察'],adjustments:['后续调整'],missing:[]},
 publish:{external_effect:true,receipts:[{item_id:'替换为计划事项 ID',external_id:'替换为真实飞书回执 ID'}]},
 simulation:{simulated:true,external_effect:false,executor:'你的身份名称',message:'连接测试完成'}
};
export function contract(action){
 const kind=action.startsWith('analysis.')?'analysis':({'daily.plan':'plan','daily.review':'review','feishu.publish':'publish','simulation.noop':'simulation'})[action];
 const s={analysis:analysisSchema,plan:planSchema,review:reviewSchema,publish:publishSchema}[kind];
 return {protocol_version:protocolVersion,output_schema:s?jsonSchema(s):{type:'object',required:['simulated','external_effect'],properties:{simulated:{const:true},external_effect:{const:false}}},success_example:{lease_token:'替换为领取响应中的值',status:'succeeded',output:examples[kind]},rules:kind==='plan'?['事项 ID 必须为 UUID，示例 ID 不可重复使用','关联待办必须存在且未完成','总分钟数加机动时间不得超过已知可用时间','可用时间未知时 missing 必须说明，草案只是候选安排','先核对 context.preflight，过期或疑似完成事项不能当成已确认事实']:[]};
}
export function protocol(){return {protocol_version:protocolVersion,guide:'/ai-guide.md?v='+protocolVersion,schema:'/api/agent/v1/protocol',register:{method:'POST',path:'/api/agent/v1/executors/register',example:{name:'平台和账号标识',capabilities:['analysis'],max_parallel:1}},claim:{method:'POST',path:'/api/agent/v1/jobs/claim',example:{}},recover:{method:'GET',path:'/api/agent/v1/jobs/active',note:'仅返回当前密钥仍有效的任务和原租约，不续期、不重新执行外部操作'},heartbeat_interval_seconds:30,actions:Object.fromEntries(['analysis.work','analysis.energy','daily.plan','daily.review','feishu.publish','simulation.noop'].map(a=>[a,contract(a)]))}}
