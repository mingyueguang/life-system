'use client';
import {useCallback,useEffect,useState} from 'react';
import Dashboard from './dashboard';
import LifePanel from './life-panel';
import IntakePanel from './intake-panel';
import PlansPanel from './plans-panel';
import SystemPanel from './system-panel';
import {Login,AccountPanel} from './account';
import {Button} from '@/components/ui/button';
import {LayoutDashboard,Database,CalendarDays,Target,ServerCog} from 'lucide-react';
type View='overview'|'data'|'daily'|'plans'|'system';
const views:{id:View;label:string;hint:string;icon:React.ReactNode}[]=[
 {id:'overview',label:'总览',hint:'目标、财务、健康、订阅与全部资料',icon:<LayoutDashboard/>},
 {id:'data',label:'资料收集',hint:'工作、健身、饮食的共享档案',icon:<Database/>},
 {id:'daily',label:'每日计划',hint:'当天条件、草案、确认与执行反馈',icon:<CalendarDays/>},
 {id:'plans',label:'领域方案与状态',hint:'可沿用的方案与复核判断',icon:<Target/>},
 {id:'system',label:'执行与系统',hint:'任务、健康与接入协议',icon:<ServerCog/>},
];
export default function Home(){const [status,setStatus]=useState<{registered:boolean;user:{id:string;email:string}|null}|null>(null),[error,setError]=useState(''),[view,setView]=useState<View>('overview');const refresh=useCallback(async()=>{setError('');try{const r=await fetch('/api/auth/status',{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'无法连接服务');setStatus(d)}catch(e){setError((e as Error).message)}},[]);useEffect(()=>{void refresh()},[refresh]);if(error)return <main className="workspace"><section className="panel"><h1>暂时无法连接</h1><p role="alert">{error}</p><Button onClick={()=>void refresh()}>重试</Button></section></main>;if(!status)return <main className="workspace"><p role="status">正在检查登录状态…</p></main>;if(!status.user)return <Login registered={status.registered} onDone={()=>void refresh()}/>;const active=views.find(v=>v.id===view)!;return <div className="shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">L</div><div><b>人生系统</b><small>LIFE SPACE · 1.4.2</small></div></div>{views.map(v=><button key={v.id} type="button" className={'nav-item'+(view===v.id?' active':'')} onClick={()=>setView(v.id)}>{v.icon}<span>{v.label}</span></button>)}</aside><main className="shell-main"><div className="shell-top"><div><h2>{active.label}</h2><p className="mini">{active.hint}</p></div><AccountPanel email={status.user.email} onLogout={()=>{setStatus(null);setView('overview');void refresh()}}/></div>{view==='overview'&&<Dashboard onNavigate={v=>setView(v)}/>}{view==='data'&&<IntakePanel/>}{view==='daily'&&<LifePanel/>}{view==='plans'&&<PlansPanel/>}{view==='system'&&<SystemPanel/>}</main></div>}
