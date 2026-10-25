import { z } from 'zod';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===s},'日期无效');
const optionalDate=z.union([date,z.literal('')]).default('');
const title=z.string().trim().min(1).max(150);
const note=z.string().max(2000).default('');
const amount=z.number().int().min(0).max(1e12);
const num=z.number().min(0).max(1e9);
export const schemas={
 goal:z.object({title,period:z.enum(['life','five','three','near']),due:optionalDate,progress:z.number().min(0).max(100).default(0),note}).strict(),
 task:z.object({title,priority:z.enum(['high','normal','low']).default('normal'),estimated_minutes:z.number().int().min(0).max(1440).default(0),due:optionalDate,done:z.boolean().default(false),goal:z.string().max(150).default(''),platform:z.string().max(100).default(''),note}).strict(),
 account:z.object({title,balance:amount,note}).strict(),
 debt:z.object({title,type:z.enum(['platform','friend']),principal:amount,note}).strict(),
 repayment:z.object({title,type:z.enum(['platform','friend']),due:date,amount,paid:z.boolean().default(false),note}).strict(),
 sleep:z.object({date:optionalDate,hours:z.number().min(0).max(24).nullable().default(null),target:z.number().min(.1).max(24).nullable().default(null),note}).strict(),
 intake:z.object({date:optionalDate,title,kcal:num.nullable().default(null),protein:num.nullable().default(null),water:num.nullable().default(null),note}).strict(),
 exercise:z.object({date:optionalDate,title,minutes:z.number().min(0).max(1440).nullable().default(null),steps:num.nullable().default(null),note}).strict(),
 environment:z.object({date:optionalDate,location:z.string().max(150).default(''),temperature_c:z.number().min(-100).max(100).nullable().default(null),humidity_percent:z.number().min(0).max(100).nullable().default(null),aqi:z.number().min(0).max(1000).nullable().default(null),conditions:z.string().max(2000).default(''),note}).strict(),
 phone_usage:z.object({date:optionalDate,category:z.string().max(100).default('total'),minutes:z.number().min(0).max(1440).nullable().default(null),note}).strict(),
 mood:z.object({date:optionalDate,title:z.string().max(150).default(''),text:z.string().min(1).max(20000),mood_label:z.string().max(100).default(''),rating:z.number().int().min(1).max(5).nullable().default(null),note}).strict(),
 transaction:z.object({date:optionalDate,title,direction:z.enum(['income','expense']),amount:amount.nullable().default(null),account_id:z.string().uuid().nullable().default(null),note}).strict(),
 profile:z.object({topic:title,statement:z.string().max(10000).default(''),status:z.enum(['known','missing','needs_review']).default('needs_review'),note}).strict(),
 unclassified:z.object({title:z.string().max(150).default(''),text:z.string().min(1).max(20000),note}).strict(),
 subscription:z.object({title,type:z.enum(['tool','phone']),start:date,end:date,points:z.number().min(0).nullable().default(null),pointsExpiry:optionalDate,quota:z.string().max(100).default(''),balance:amount.nullable().default(null),plan:z.string().max(150).default(''),note}).strict().refine(x=>x.end>=x.start,'结束日期不能早于开始日期'),
};
