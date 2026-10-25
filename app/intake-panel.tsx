'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {lifeApi} from './life-panel';
type Field={key:string;label:string;question:string;required:boolean;status:string;token:string;record:null|{data:{statement?:string};version:number}};
type Evidence={current:boolean;field_key:string;record_id:string;record_version:number;value:string;reason:string};
type Intake={domain:string;context_hash:string;state:string;fields:Field[];jobs:{id:string;status:string}[];report:null|{summary:string;current:boolean;job_id:string;evidence:Evidence[];questions:{field_key:string;question:string;reason:string}[]}};
const domainLabels={work:'日常工作',fitness:'健身',diet:'饮食'};
const labels:Record<string,string>={known:'已了解',missing:'待了解',needs_review:'待核对',deferred:'稍后补充'};
function Answer({field,question,reason,busy,onAction}:{field:Field;question:string;reason?:string;busy:boolean;onAction:(field:Field,op:string,value?:string)=>Promise<void>}){
 const [value,setValue]=useState(field.record?.data.statement||'');
 return <article className="record grid gap-2"><div className="row"><b>{field.label}</b><span className="pill">{labels[field.status]}</span></div>{field.status==='known'?<p className="mini">{field.record?.data.statement}</p>:<><p>{question}</p>{reason&&<p className="mini">为什么需要了解：{reason}</p>}</>}
 <form className="grid gap-2" onSubmit={e=>{e.preventDefault();void onAction(field,'answer',value)}}><label className="field">{field.status==='known'?'补充或修正':'你的回答'}<textarea required maxLength={10000} value={value} onChange={e=>setValue(e.target.value)} placeholder="可以只填写目前知道的部分，不需要一次答完"/></label><div className="actions"><Button type="submit" size="sm" disabled={busy||!value.trim()}>保存回答</Button>{field.status!=='known'&&<Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>void onAction(field,field.status==='deferred'?'resume':'defer')}>{field.status==='deferred'?'恢复沟通':'稍后再说'}</Button>}</div></form></article>
}
export default function IntakePanel(){
 const [domain,setDomain]=useState<keyof typeof domainLabels>('work'),[data,setData]=useState<Intake|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 useEffect(()=>{let cancelled=false;async function load(){try{const d=await lifeApi('intake?domain='+domain);if(!cancelled)setData(d)}catch(e){if(!cancelled)setError((e as Error).message)}}setData(null);setError('');setMessage('');void load();const t=setInterval(()=>void load(),10000);return()=>{cancelled=true;clearInterval(t)}},[domain]);
 async function act(fn:()=>Promise<unknown>,notice:string){setBusy(true);setError('');setMessage('');try{await fn();setData(await lifeApi('intake?domain='+domain));setMessage(notice)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function answer(field:Field,operation:string,value?:string){await act(()=>lifeApi('intake/update',{request_id:crypto.randomUUID(),domain,field_key:field.key,token:field.token,operation,...(value?{answer:value}:{})}),operation==='defer'?'已记为稍后补充，不会继续追问。':'已保存到共享档案，其他角色可以接续使用。')}
 const known=data?.fields.filter(f=>f.status==='known')||[],pending=data?.fields.filter(f=>!['known','deferred'].includes(f.status))||[];
 const questions=data?.report?.current?data.report.questions:[];
 const selected=questions.length?questions.map(q=>pending.find(f=>f.key===q.field_key)).filter(Boolean) as Field[]:pending.filter(f=>!data?.report?.evidence.some(e=>e.current&&e.field_key===f.key)).sort((a,b)=>Number(b.required)-Number(a.required)).slice(0,3);
 return <section className="workspace"><div className="panel grid gap-4"><div><span className="eyebrow">先了解你，再制定计划</span><h2>工作、健身与饮食资料</h2><p className="mini">可以分次填写，也可以让已接入的 AI 代为记录真实回答。共用资料只问一次，不推算未知信息；本阶段不生成个人计划。</p></div><div className="actions">{Object.entries(domainLabels).map(([key,label])=><Button key={key} variant={domain===key?'default':'outline'} disabled={busy} onClick={()=>setDomain(key as keyof typeof domainLabels)}>{label}</Button>)}</div>
 {error&&<p className="error" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
 {!data?<p>正在读取共享资料…</p>:<><p className="mini">已了解 {known.length} 项 · 待补 {pending.length} 项 · 稍后补充 {data.fields.filter(f=>f.status==='deferred').length} 项</p><div className="actions"><Button disabled={busy||!!data.jobs.length||!pending.length} onClick={()=>void act(()=>lifeApi('intake/start',{domain,context_hash:data.context_hash}),'已安排资料梳理，等待 AI 领取；只整理已有信息与必要问题。')}>{data.jobs.length?'AI 资料梳理等待或执行中':'让 AI 先整理已有资料'}</Button></div>
 {data.report&&<div className="daily-note"><b>{data.report.current?'本轮资料梳理':'上轮梳理（资料已更新）'}</b><p>{data.report.summary}</p>{!data.report.current&&<p className="mini">旧结论保留供参考。下方只展示来源仍有效、尚未确认的整理建议；已有回答已保留。</p>}</div>}
 {data.report&&data.report.evidence.map((e,i)=>{const field=data.fields.find(f=>f.key===e.field_key);if(!field||!e.current)return null;return <article className="record" key={e.field_key+e.record_id+i}><b>已有资料可能回答：{field.label}</b><p>{e.value}</p><p className="mini">整理依据：{e.reason} · 来源记录 {e.record_id}，版本 {e.record_version}</p><Button size="sm" disabled={busy} onClick={()=>void act(()=>lifeApi('intake/update',{request_id:crypto.randomUUID(),domain,field_key:field.key,token:field.token,operation:'accept_evidence',report_job_id:data.report!.job_id,evidence_index:i}),'已确认并保存，其他角色不再重复询问这一项。')}>符合我的情况，采用</Button></article>})}
 {data.state==='basics_collected'&&<p className="daily-note">初步关键资料已收集。下一阶段仍需专业判断与方案核对，不会自动开始训练、饮食或工作计划。</p>}
 {selected.map(f=><Answer key={f.key+f.token} field={f} question={questions.find(q=>q.field_key===f.key)?.question||f.question} reason={questions.find(q=>q.field_key===f.key)?.reason} busy={busy} onAction={answer}/>)}
 <details><summary>已了解的资料（可修正）</summary>{known.map(f=><Answer key={f.key+f.token} field={f} question={f.question} busy={busy} onAction={answer}/>)}</details>
 <details><summary>其他资料与稍后补充</summary>{data.fields.filter(f=>f.status!=='known'&&!selected.some(s=>s.key===f.key)).map(f=><Answer key={f.key+f.token} field={f} question={f.question} busy={busy} onAction={answer}/>)}</details>
 </>}
 </div></section>
}
