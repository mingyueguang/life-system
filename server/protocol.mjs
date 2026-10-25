import {intakeOutputSchema} from './intake.mjs';
import {planSchema,analysisSchema,fitnessPlanSchema,dietPlanSchema,reviewSchema,publishSchema} from './life.mjs';
export const protocolVersion='1.4.2';
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
 return {protocol_version:protocolVersion,output_schema:s?jsonSchema(s):{type:'object',required:['simulated','external_effect'],properties:{simulated:{const:true},external_effect:{const:false}}},success_example:{lease_token:'替换为领取响应中的值',status:'succeeded',output:examples[kind]},rules:kind==='plan'?['事项 ID 必须为 UUID，示例 ID 不可重复使用','关联待办必须存在且未完成','总分钟数加机动时间不得超过已知可用时间','可用时间未知时 missing 必须说明，草案只是候选安排','核对清单中的已完成或过期记录仅作提示，周期事项照常安排；如确需继续，在 reason 说明理由']:[]};
}
export function protocol(){return {protocol_version:protocolVersion,guide:'/ai-guide.md?v='+protocolVersion,schema:'/api/agent/v1/protocol',register:{method:'POST',path:'/api/agent/v1/executors/register',example:{name:'平台和账号标识',capabilities:['analysis'],max_parallel:1}},claim:{method:'POST',path:'/api/agent/v1/jobs/claim',example:{}},recover:{method:'GET',path:'/api/agent/v1/jobs/active',note:'仅返回当前密钥仍有效的任务和原租约，不续期、不重新执行外部操作'},heartbeat_interval_seconds:30,actions:Object.fromEntries(['intake.work','intake.fitness','intake.diet','analysis.work','analysis.energy','analysis.fitness','analysis.diet','daily.plan','daily.review','feishu.publish','feishu.publish.fitness','feishu.publish.diet','simulation.noop'].map(a=>[a,contract(a)]))}}
