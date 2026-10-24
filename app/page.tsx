'use client';
import {useCallback,useEffect,useState} from 'react';
import Dashboard from './dashboard';
import {Login,AccountPanel} from './account';
import {Button} from '@/components/ui/button';
export default function Home(){const [status,setStatus]=useState<{registered:boolean;user:{id:string;email:string}|null}|null>(null),[error,setError]=useState('');const refresh=useCallback(async()=>{setError('');try{const r=await fetch('/api/auth/status',{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'无法连接服务');setStatus(d)}catch(e){setError((e as Error).message)}},[]);useEffect(()=>{void refresh()},[refresh]);if(error)return <main className="workspace"><section className="panel"><h1>暂时无法连接</h1><p role="alert">{error}</p><Button onClick={()=>void refresh()}>重试</Button></section></main>;if(!status)return <main className="workspace"><p role="status">正在检查登录状态…</p></main>;if(!status.user)return <Login registered={status.registered} onDone={()=>void refresh()}/>;return <><div className="workspace pb-0"><AccountPanel email={status.user.email} onLogout={()=>{setStatus(null);void refresh()}}/></div><Dashboard/></>}
