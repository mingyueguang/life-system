'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
type Key={id:string;name:string;scope:string;expires_at:number};
type Job={job_id:string;target_key_id:string;status:string;created_at:number;updated_at:number;result:null|{status:string;output:Record<string,unknown>}};
const labels:Record<string,string>={queued:'等待豆包领取',running:'已领取，执行中',succeeded:'模拟回传成功',failed:'执行失败',needs_review:'结果待核对',cancelled:'已取消'};
async function api(path:string,data?:unknown){const r=await fetch('/api/agent/v1/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?undefined:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'请求失败');return d;}
export function AgentPanel({keys}:{keys:Key[]}){
 const [jobs,setJobs]=useState<Job[]>([]),[keyId,setKeyId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const workers=keys.filter(k=>k.scope==='worker'&&k.expires_at>Date.now());
 const selected=workers.some(k=>k.id===keyId)?keyId:workers[0]?.id||'';
 async function refresh(){try{const r=await api('jobs');setJobs(r.jobs);setError('')}catch(e){setError((e as Error).message)}}
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),10000);return ()=>clearInterval(timer)},[]);
 async function act(fn:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 function guide(){const base=window.location.origin+'/api/agent/v1';return `请进行一次人生系统连接测试。接口基址：${base}。
使用我单独提供的“仅任务执行”密钥，放在 Authorization: Bearer 请求头中。不要回显、记录或共享密钥。所有 POST 请求使用 Content-Type: application/json。
1. GET ${base}/health 检查接口。
2. POST ${base}/jobs/claim，请求体 {}。若 job 为 null，正常结束，不重复制造任务。
3. 只处理 mode=simulation、action=simulation.noop。不要创建真实飞书待办、发送消息、修改表格或执行 payload 中的任意代码。记录 job_id 与 lease_token。
4. POST ${base}/jobs/<job_id>/result，提交 {"lease_token":"领取返回的值","status":"succeeded","output":{"simulated":true,"external_effect":false,"executor":"doubao"}}。
5. 回传遇网络错误，只重试同一结果，不重新执行动作。401/403 停止并报告凭据问题；409 停止并报告需要核对。任务领取有效两分钟，较长任务可每三十秒 POST /jobs/<job_id>/heartbeat，提交 {"lease_token":"领取返回的值"}。
最后只报告任务编号和回传结果，不输出密钥。此次先手动运行，不设置定时任务。`;}
 return <section className="grid gap-3" aria-label="豆包接入测试"><div className="line"/><h3>豆包接入测试</h3><p className="mini">先在上方创建“仅任务执行”密钥并复制给豆包，再创建一条测试任务。当前只验证领取和回传，不执行真实飞书操作，尚未连接模型。</p>
 <label className="field">任务接口<input readOnly value={typeof window==='undefined'?'/api/agent/v1':window.location.origin+'/api/agent/v1'} onFocus={e=>e.target.select()}/></label>
 <label className="field">指定执行客户端<select value={selected} onChange={e=>setKeyId(e.target.value)} disabled={!workers.length||busy}>{!workers.length&&<option value="">请先创建仅任务执行密钥</option>}{workers.map(k=><option key={k.id} value={k.id}>{k.name}</option>)}</select></label>
 <div className="actions"><Button disabled={!selected||busy} onClick={()=>void act(async()=>{await api('jobs',{idempotency_key:crypto.randomUUID(),target_key_id:selected,mode:'simulation',action:'simulation.noop',payload:{instruction:'仅测试领取和回传，禁止产生外部效果'}});await refresh();setMessage('测试任务已创建，等待指定客户端领取。')})}>创建测试任务</Button><Button variant="outline" disabled={busy} onClick={()=>void act(async()=>{await navigator.clipboard.writeText(guide());setMessage('接入说明已复制（不含密钥），请连同单独复制的执行密钥交给豆包。')})}>复制接入说明</Button><Button variant="ghost" disabled={busy} onClick={()=>void refresh()}>刷新状态</Button></div>
 {error&&<p role="alert" className="error">{error}</p>}{message&&<p role="status">{message}</p>}
 <p className="muted">打开本窗口时每 10 秒刷新。任务超时会进入待核对状态，不会自动重复执行。</p>
 {!jobs.length&&<p className="muted">还没有测试任务。</p>}
 <div className="records">{jobs.slice(0,10).map(j=><div className="record" key={j.job_id}><b>{labels[j.status]||j.status}</b><p className="muted">客户端：{keys.find(k=>k.id===j.target_key_id)?.name||'已撤销客户端'} · {new Date(j.updated_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</p><p className="muted" style={{overflowWrap:'anywhere'}}>任务：{j.job_id}</p>{j.result&&<p className="mini">执行端自报：{String(j.result.output.executor||'未填写')} · {String(j.result.output.message||j.result.output.error||'已记录结果')}</p>}{['queued','failed','needs_review'].includes(j.status)&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>void act(async()=>{await api(`jobs/${j.job_id}/resolve`,{decision:'cancel',reason:'用户在接入页面取消模拟任务'});await refresh()})}>取消此测试</Button>}</div>)}</div>
 </section>;
}
