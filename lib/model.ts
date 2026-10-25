import {schemas} from './record-schema.mjs';
export {schemas} from './record-schema.mjs';
export type Kind=keyof typeof schemas;
export type Data=Record<string,string|number|boolean|null>;
export type Metadata={occurred_at:string|null;source:{method:string;original_text:string;reference:string};certainty:string;field_status:Record<string,string>;related_ids:string[]};
export type RecordRow={id:string;kind:Kind;data:Data;version:number;updatedAt:string;deleted:boolean;metadata?:Metadata};
export type Field={key:string;label:string;type?:'text'|'date'|'number'|'money'|'textarea'|'boolean'|'select';options?:[string,string][];required?:boolean;default?:string|number|boolean;max?:number;min?:number};
const n:Field={key:'note',label:'备注',type:'textarea'};const name:Field={key:'title',label:'名称',required:true};
export const catalog:Record<Kind,{label:string;fields:Field[]}>= {
 goal:{label:'目标',fields:[name,{key:'period',label:'目标周期',type:'select',options:[['life','人生目标'],['five','5 年目标'],['three','3 年目标'],['near','近期目标']],default:'near'},{key:'due',label:'截止日期',type:'date'},{key:'progress',label:'成果进度（%）',type:'number',default:0,max:100},n]},
 task:{label:'待办',fields:[name,{key:'priority',label:'优先级',type:'select',options:[['high','高'],['normal','普通'],['low','低']],default:'normal'},{key:'estimated_minutes',label:'预计耗时（分钟，0 表示未知）',type:'number',default:0,max:1440},{key:'due',label:'截止日期',type:'date'},{key:'done',label:'已完成',type:'boolean'},{key:'goal',label:'关联目标'},{key:'platform',label:'使用平台'},n]},
 account:{label:'现金账户',fields:[name,{key:'balance',label:'可用余额（元）',type:'money',required:true},n]},
 debt:{label:'债务',fields:[name,{key:'type',label:'债务类型',type:'select',options:[['platform','平台债务'],['friend','亲友债务']],default:'platform'},{key:'principal',label:'未偿本金（元）',type:'money',required:true},n]},
 repayment:{label:'还款计划',fields:[{...name,label:'还款平台 / 亲友'},{key:'type',label:'类型',type:'select',options:[['platform','平台'],['friend','亲友']],default:'platform'},{key:'due',label:'还款日期',type:'date',required:true},{key:'amount',label:'应还金额（元）',type:'money',required:true},{key:'paid',label:'已还款',type:'boolean'},n]},
 sleep:{label:'睡眠记录',fields:[{key:'date',label:'醒来日期',type:'date'},{key:'hours',label:'睡眠时长（小时，未知留空）',type:'number',max:24},{key:'target',label:'个人目标（小时）',type:'number',max:24},n]},
 intake:{label:'摄入记录',fields:[{key:'date',label:'日期',type:'date'},{...name,label:'餐次 / 食物'},{key:'kcal',label:'热量（kcal，未知留空）',type:'number'},{key:'protein',label:'蛋白质（g）',type:'number'},{key:'water',label:'饮水（ml）',type:'number'},n]},
 exercise:{label:'运动记录',fields:[{key:'date',label:'日期',type:'date'},{...name,label:'运动类型'},{key:'minutes',label:'运动时长（分钟，未知留空）',type:'number',max:1440},{key:'steps',label:'步数',type:'number'},n]},
 environment:{label:'环境',fields:[{key:'date',label:'日期',type:'date'},{key:'location',label:'地点'},{key:'temperature_c',label:'温度（摄氏度）',type:'number',min:-100,max:100},{key:'humidity_percent',label:'湿度（%）',type:'number',max:100},{key:'aqi',label:'空气质量指数',type:'number',max:1000},{key:'conditions',label:'环境和设备条件',type:'textarea'},n]},
 phone_usage:{label:'手机使用',fields:[{key:'date',label:'统计日期',type:'date'},{key:'category',label:'应用或分类（total 表示总计）',default:'total'},{key:'minutes',label:'使用分钟数',type:'number',max:1440},n]},
 mood:{label:'心情日记',fields:[{key:'date',label:'日期',type:'date'},{key:'title',label:'标题'},{key:'text',label:'日记原文',type:'textarea',required:true},{key:'mood_label',label:'自述心情'},{key:'rating',label:'自评（1–5，未知留空）',type:'number',min:1,max:5},n]},
 transaction:{label:'收支流水',fields:[{key:'date',label:'发生日期',type:'date'},name,{key:'direction',label:'方向',type:'select',options:[['income','收入'],['expense','支出']],default:'expense'},{key:'amount',label:'金额（元，未知留空）',type:'money'},{key:'account_id',label:'关联账户 ID（可留空）'},n]},
 profile:{label:'个人资料与待补信息',fields:[{key:'topic',label:'资料主题',required:true},{key:'statement',label:'已知内容',type:'textarea'},{key:'status',label:'状态',type:'select',options:[['known','已知'],['missing','待补充'],['needs_review','待核实']],default:'needs_review'},n]},
 unclassified:{label:'未归类记录',fields:[{key:'title',label:'标题'},{key:'text',label:'原文',type:'textarea',required:true},n]},
 subscription:{label:'会员 / 通信资源',fields:[name,{key:'type',label:'服务类型',type:'select',options:[['tool','制作工具'],['phone','通信套餐']],default:'tool'},{key:'start',label:'周期开始',type:'date',required:true},{key:'end',label:'周期结束',type:'date',required:true},{key:'points',label:'积分（未知留空）',type:'number'},{key:'pointsExpiry',label:'积分到期日',type:'date'},{key:'quota',label:'剩余额度与单位'},{key:'balance',label:'话费 / 账户余额（元）',type:'money'},{key:'plan',label:'关联制作计划'},n]}
};
export function shanghaiToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
export function daysBetween(a:string,b:string){return Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000)}
