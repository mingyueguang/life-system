'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {lifeApi} from './life-panel';
type Key={id:string;name:string;scope:string;expires_at:number};
export function AgentPanel({keys}:{keys:Key[]}){
 const workers=keys.filter(k=>['worker','write'].includes(k.scope)&&k.expires_at>Date.now());
 const [key,setKey]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const selected=workers.some(k=>k.id===key)?key:workers[0]?.id||'';
 async function act(fn:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 return <section className="grid gap-3"><div className="line"/><h3>接入任意 AI</h3><p className="mini">每个独立账号使用自己的读写密钥。复制下面的说明，连同密钥交给 AI；专业角色由服务器任务决定，不绑定平台。</p><Button variant="outline" disabled={busy} onClick={()=>void act(async()=>{await navigator.clipboard.writeText(`请接入我的人生管理系统：${window.location.origin}。先阅读 ${window.location.origin}/ai-guide.md，使用我单独给你的密钥，不要回显。登记你的真实名称、能力和并发上限（单任务账号为1），领取并完成任务。没有任务则正常结束。不要创建定时任务，待首次真实任务验证后再设置。`);setMessage('接入说明已复制，请另行提供对应密钥。')})}>复制通用接入说明</Button><label className="field">连接测试对象<select value={selected} onChange={e=>setKey(e.target.value)} disabled={busy||!workers.length}>{!workers.length&&<option value="">先创建读写密钥</option>}{workers.map(k=><option key={k.id} value={k.id}>{k.name}</option>)}</select></label><Button disabled={busy||!selected} variant="outline" onClick={()=>void act(async()=>{await lifeApi('jobs',{idempotency_key:crypto.randomUUID(),target_key_id:selected,mode:'simulation',action:'simulation.noop',payload:{instruction:'仅测试领取与回传，不产生外部效果'}});setMessage('测试任务已创建。执行结果在首页 AI 任务进度中查看。')})}>创建连接测试任务</Button>{error&&<p role="alert" className="error">{error}</p>}{message&&<p role="status">{message}</p>}</section>
}
