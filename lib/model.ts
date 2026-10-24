import { z } from 'zod';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===s},'日期无效');
const optionalDate=z.union([date,z.literal('')]).default('');
const title=z.string().trim().min(1).max(150);
const note=z.string().max(2000).default('');
const amount=z.number().int().min(0).max(1e12);
const num=z.number().min(0).max(1e9);
export const schemas={
 goal:z.object({title,period:z.enum(['life','five','three','near']),due:optionalDate,progress:z.number().min(0).max(100).default(0),note}).strict(),
 task:z.object({title,due:optionalDate,done:z.boolean().default(false),goal:z.string().max(150).default(''),platform:z.string().max(100).default(''),note}).strict(),
 account:z.object({title,balance:amount,note}).strict(),
 debt:z.object({title,type:z.enum(['platform','friend']),principal:amount,note}).strict(),
 repayment:z.object({title,type:z.enum(['platform','friend']),due:date,amount,paid:z.boolean().default(false),note}).strict(),
 sleep:z.object({date,hours:z.number().min(0).max(24),target:z.number().min(.1).max(24).default(7.5),note}).strict(),
 intake:z.object({date,title,kcal:num,protein:num.default(0),water:num.default(0),note}).strict(),
 exercise:z.object({date,title,minutes:z.number().min(0).max(1440),steps:num.default(0),note}).strict(),
 subscription:z.object({title,type:z.enum(['tool','phone']),start:date,end:date,points:z.number().min(0).nullable().default(null),pointsExpiry:optionalDate,quota:z.string().max(100).default(''),balance:amount.nullable().default(null),plan:z.string().max(150).default(''),note}).strict().refine(x=>x.end>=x.start,'结束日期不能早于开始日期'),
};
export type Kind=keyof typeof schemas;
export type Data=Record<string,string|number|boolean|null>;
export type RecordRow={id:string;kind:Kind;data:Data;version:number;updatedAt:string;deleted:boolean};
export type Field={key:string;label:string;type?:'text'|'date'|'number'|'money'|'textarea'|'boolean'|'select';options?:[string,string][];required?:boolean;default?:string|number|boolean;max?:number};
const n:Field={key:'note',label:'备注',type:'textarea'};const name:Field={key:'title',label:'名称',required:true};
export const catalog:Record<Kind,{label:string;fields:Field[]}>= {
 goal:{label:'目标',fields:[name,{key:'period',label:'目标周期',type:'select',options:[['life','人生目标'],['five','5 年目标'],['three','3 年目标'],['near','近期目标']],default:'near'},{key:'due',label:'截止日期',type:'date'},{key:'progress',label:'成果进度（%）',type:'number',default:0,max:100},n]},
 task:{label:'待办',fields:[name,{key:'due',label:'截止日期',type:'date'},{key:'done',label:'已完成',type:'boolean'},{key:'goal',label:'关联目标'},{key:'platform',label:'使用平台'},n]},
 account:{label:'现金账户',fields:[name,{key:'balance',label:'可用余额（元）',type:'money',required:true},n]},
 debt:{label:'债务',fields:[name,{key:'type',label:'债务类型',type:'select',options:[['platform','平台债务'],['friend','亲友债务']],default:'platform'},{key:'principal',label:'未偿本金（元）',type:'money',required:true},n]},
 repayment:{label:'还款计划',fields:[{...name,label:'还款平台 / 亲友'},{key:'type',label:'类型',type:'select',options:[['platform','平台'],['friend','亲友']],default:'platform'},{key:'due',label:'还款日期',type:'date',required:true},{key:'amount',label:'应还金额（元）',type:'money',required:true},{key:'paid',label:'已还款',type:'boolean'},n]},
 sleep:{label:'睡眠记录',fields:[{key:'date',label:'醒来日期',type:'date',required:true},{key:'hours',label:'睡眠时长（小时）',type:'number',required:true,max:24},{key:'target',label:'个人目标（小时）',type:'number',default:7.5,max:24},n]},
 intake:{label:'摄入记录',fields:[{key:'date',label:'日期',type:'date',required:true},{...name,label:'餐次 / 食物'},{key:'kcal',label:'热量（kcal）',type:'number',required:true},{key:'protein',label:'蛋白质（g）',type:'number',default:0},{key:'water',label:'饮水（ml）',type:'number',default:0},n]},
 exercise:{label:'运动记录',fields:[{key:'date',label:'日期',type:'date',required:true},{...name,label:'运动类型'},{key:'minutes',label:'运动时长（分钟）',type:'number',required:true,max:1440},{key:'steps',label:'步数',type:'number',default:0},n]},
 subscription:{label:'会员 / 通信资源',fields:[name,{key:'type',label:'服务类型',type:'select',options:[['tool','制作工具'],['phone','通信套餐']],default:'tool'},{key:'start',label:'周期开始',type:'date',required:true},{key:'end',label:'周期结束',type:'date',required:true},{key:'points',label:'积分（未知留空）',type:'number'},{key:'pointsExpiry',label:'积分到期日',type:'date'},{key:'quota',label:'剩余额度与单位'},{key:'balance',label:'话费 / 账户余额（元）',type:'money'},{key:'plan',label:'关联制作计划'},n]}
};
export function shanghaiToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
export function daysBetween(a:string,b:string){return Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000)}
