'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Server,RefreshCw,KeyRound} from 'lucide-react';
import {lifeApi} from './life-panel';
type Health={status:string;api_version:number;mode:string;model_connected:boolean;auth:string;release:string;protocol_url:string};
type Protocol={protocol_version:string;guide:string;schema:string;heartbeat_interval_seconds:number;interface_catalog:Record<string,{title:string;paths:string[];note:string}>;register:{method:string;path:string;example:object};recover:{method:string;path:string;note:string}};
type Job={job_id:string;action:string;status:string;day:string|null;created_at:string;updated_at:string;attempts:number};
const actionLabel:Record<string,string>={'intake.work':'工作资料沟通','intake.fitness':'健身资料沟通','intake.diet':'饮食资料沟通','analysis.work':'目标与工作分析','analysis.energy':'行为与精力分析','analysis.fitness':'健身方案','analysis.diet':'饮食方案','daily.plan':'统筹每日计划','daily.review':'每日复盘','feishu.publish':'发布到飞书','feishu.publish.fitness':'发布健身清单','feishu.publish.diet':'发布饮食清单','simulation.noop':'连接测试'};
const statusLabel:Record<string,string>={queued:'等待执行',running:'执行中',succeeded:'已完成',failed:'失败',needs_review:'需核对',cancelled:'已取消'};
export default function SystemPanel(){
 const [health,setHealth]=useState<Health|null>(null),[protocol,setProtocol]=useState<Protocol|null>(null),[jobs,setJobs]=useState<Job[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function load(){try{const [h,p,j]=await Promise.all([lifeApi('health'),lifeApi('protocol'),lifeApi('jobs')]);setHealth(h);setProtocol(p);setJobs(j.jobs||[])}catch(e){setError((e as Error).message)}}
 useEffect(()=>{void load()},[]);
 const counts=jobs.reduce<Record<string,number>>((a,j)=>{a[j.status]=(a[j.status]||0)+1;return a},{});
 const recent=jobs.slice(0,12);
 return <div className="view"><div className="daily-heading"><div><span className="eyebrow">执行与系统</span><h2>任务、健康与接入协议</h2><p className="mini">AI 领取的任务在这里可见。密钥在「总览」右上角的「账号与 AI 密钥」中创建，接入说明由协议接口提供。</p></div><Button variant="outline" disabled={busy} onClick={()=>void load()}><RefreshCw size={14}/>刷新</Button></div>
 {error&&<p role="alert" className="error">{error}</p>}
 <div className="kpis"><div className="kpi"><small>健康状态</small><b style={{color:health?.status==='ok'?'#16885c':'#b54433'}}>{health?.status==='ok'?'正常':'异常'}</b></div><div className="kpi"><small>服务版本</small><b>{health?.release||'—'}</b></div><div className="kpi"><small>API 版本</small><b>v{health?.api_version||'—'}</b></div><div className="kpi"><small>待执行任务</small><b>{counts.queued||0}</b></div><div className="kpi"><small>执行中</small><b>{counts.running||0}</b></div><div className="kpi"><small>需核对 / 失败</small><b>{(counts.needs_review||0)+(counts.failed||0)}</b></div></div>
 {health&&<div className="panel"><div className="section-title"><span className="icon green"><Server/></span><h3>健康检查</h3></div><p className="mini">状态 {health.status} · 模式 {health.mode} · 认证 {health.auth}{health.model_connected?' · 模型已连接':' · 模型未连接'}</p></div>}
 {protocol&&<div className="panel mt-4"><div className="section-title"><span className="icon blue"><KeyRound/></span><h3>接入协议（机器可读）</h3></div><p className="mini">登记：{protocol.register.method} {protocol.register.path}（示例：{JSON.stringify(protocol.register.example)}）</p><p className="mini">恢复：{protocol.recover.method} {protocol.recover.path}——{protocol.recover.note}</p><p className="mini">心跳间隔 {protocol.heartbeat_interval_seconds} 秒 · 接入文档 {protocol.guide}</p><details><summary>接口目录</summary>{Object.entries(protocol.interface_catalog).map(([key,it])=><div className="record" key={key}><b>{it.title}</b><ul className="mini" style={{listStyle:'disc',paddingLeft:'1.4rem'}}>{it.paths.map(p=><li key={p}>{p}</li>)}</ul><p className="mini">{it.note}</p></div>)}</details></div>}
 <div className="panel mt-4"><h3>最近任务</h3>{!recent.length?<p className="empty">还没有任务。在「每日计划」生成，或等待 AI 连接测试。</p>:<table className="data"><thead><tr><th>动作</th><th>状态</th><th>日期</th><th>尝试</th></tr></thead><tbody>{recent.map(j=><tr key={j.job_id}><td className="mini">{actionLabel[j.action]||j.action}</td><td><span className={'badge '+j.status}>{statusLabel[j.status]||j.status}</span></td><td className="mini">{j.day||'—'}</td><td className="mini">{j.attempts}</td></tr>)}</tbody></table>}</div>
 <p className="muted mt-4">任务明细与结果可在「每日计划」页下方「AI 执行者与任务进度」中查看；取消或核实重试也在那里操作。</p>
 </div>;
}
