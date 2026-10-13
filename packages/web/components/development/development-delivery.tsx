"use client";
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {Textarea} from '@/components/ui/textarea';
import type {DevelopmentShellProps} from '@localapp/dsh-agent-ui/ui/conversation-types';
import {activatePageContext} from './page-context';
const statusText:Record<string,string>={passed:'通过',failed:'失败',observed:'仅记录观察',succeeded:'构建通过',running:'执行中',queued:'排队中',cancelled:'已取消',interrupted:'已中断'};
export function DevelopmentDelivery({value:p}:{value:DevelopmentShellProps}){
 const [data,setData]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[seed,setSeed]=useState('empty');
 const [steps,setSteps]=useState('[\n  {"action":"assert","selector":"h1","visible":true}\n]');
 const base=`/api/development/projects/${encodeURIComponent(p.project?.id??'')}`;
 async function load(){const res=await fetch(base+'/delivery');const body=await res.json();if(!res.ok||!body.success)throw new Error(body.error??'无法读取开发结果');setData(body.data);}
 useEffect(()=>{let active=true;const poll=()=>{if(active)void load().catch(error=>{if(active)setError(String(error.message))});};poll();const timer=setInterval(poll,3000);return()=>{active=false;clearInterval(timer)};},[base]);
 async function verify(){if(busy||!p.build)return;setBusy(true);setError('');try{const plan=JSON.parse(steps);await activatePageContext(p.project!.id);const res=await fetch(base+'/verification',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({buildId:p.build.id,steps:plan,seedProduction:seed==='production'})});const body=await res.json();if(!res.ok||!body.success)throw new Error(body.error??'验收失败');await load();}catch(error){setError(error instanceof Error?error.message:String(error))}finally{setBusy(false)}}
 const checking=busy||!!data?.verification?.some((run:any)=>['queued','running'].includes(run.status));
 const latest=data?.verification?.find((run:any)=>run.buildId===p.build?.id),release=data?.releases?.[0],preview=data?.previews?.find((preview:any)=>preview.buildId===p.build?.id&&!preview.verification);
 return <section className="space-y-5" aria-label="开发完成摘要">
  <div className="grid grid-cols-2 gap-3 rounded-lg border p-4 text-sm">
   <div><span className="text-muted-foreground">源码版本</span><p>{(p.build?.sourceVersion??data?.versions?.[0]?.id)?.slice(0,8)??'暂无'}</p></div>
   <div><span className="text-muted-foreground">当前构建</span><p>{statusText[p.build?.status]??'尚未构建'}{p.build?.purpose==='preview'?' · 预览编译':''}</p></div>
   <div><span className="text-muted-foreground">页面验收</span><p>{latest?statusText[latest.status]:'待验收'}{latest?.result?.imageError?' · 截图失败':''}</p></div>
   <div><span className="text-muted-foreground">已上线版本</span><p>{release?`v${release.version} · 源码 ${release.sourceVersion.slice(0,8)}`:data?.liveVersion?`v${data.liveVersion} · 源码关联暂无记录`:'尚未上线'}</p></div>
   <div className="col-span-2"><span className="text-muted-foreground">当前构建的预览</span><p>{preview?`${preview.id.slice(0,8)} · 构建 ${p.build.id.slice(0,8)}`:"尚未打开预览"}</p></div>
  </div>
  <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={p.pending||p.build?.status!=='succeeded'} onClick={p.actions.preview}>打开当前构建预览</Button><Button variant="ghost" size="sm" disabled={p.pending} onClick={p.actions.diff}>刷新改动</Button><span className="text-xs text-muted-foreground">本次源码版本 {data?.changedFiles?.length??0} 个改动文件{p.changes.length?` · 工作区另有 ${p.changes.length} 个改动`:""}</span></div>
  {data?.changedFiles?.length>0&&<ul className="text-xs text-muted-foreground">{data.changedFiles.map((file:string)=><li key={file}>{file}</li>)}</ul>}
  {p.changes.length>0&&<ul className="text-xs text-muted-foreground">{p.changes.map((file:any)=><li key={file.path}>{file.path}</li>)}</ul>}
  <div className="space-y-2"><h3 className="text-sm font-medium">自动页面验收</h3><p className="text-xs text-muted-foreground">在独立测试预览执行。支持 scroll、click、assert；点击仅支持页签或 data-localapp-test-action 控件。没有预期检查时只记录观察。</p>
   <Select value={seed} onValueChange={setSeed} disabled={checking}><SelectTrigger aria-label="验收初始数据"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="empty">新建测试数据</SelectItem><SelectItem value="production">生产数据的测试副本</SelectItem></SelectContent></Select>
   <Textarea aria-label="页面验收步骤" value={steps} onChange={event=>setSteps(event.target.value)} disabled={checking} className="min-h-28 font-mono text-xs"/>
   <Button size="sm" disabled={checking||p.running||p.pending||p.build?.status!=='succeeded'} onClick={()=>void verify()}>{checking?'正在执行独立验收…':'执行页面验收'}</Button>
  </div>
  {data?.verification?.length>0&&<div className="space-y-2"><h3 className="text-sm font-medium">最近验收</h3>{data.verification.slice(0,5).map((run:any)=><div key={run.id} className="rounded-lg border p-3 text-xs"><div className="flex justify-between gap-2"><span>{statusText[run.status]} · 源码 {run.sourceVersion.slice(0,8)} · {new Date(run.createdAt).toLocaleString()}</span>{run.screenshot&&<a className="text-primary underline" href={`${base}/verification/${run.id}/screenshot`} target="_blank" rel="noreferrer">查看截图</a>}</div>{run.result.error&&<p className="mt-2 text-destructive">{run.result.error}</p>}{run.result.results?.filter((step:any)=>step.status==='failed').map((step:any,index:number)=><p key={index} className="mt-2 text-destructive">{step.step.selector}：{step.error}</p>)}</div>)}</div>}
  <div className="space-y-2"><h3 className="text-sm font-medium">恢复源码版本</h3><Select value={p.version} onValueChange={p.actions.setVersion} disabled={p.running||p.pending||checking}><SelectTrigger aria-label="恢复源码版本"><SelectValue placeholder="选择版本"/></SelectTrigger><SelectContent>{p.versions.map(version=><SelectItem key={version.id} value={version.id}>{version.message} · {version.id.slice(0,8)}{data?.releases?.find((release:any)=>release.sourceVersion===version.id)?` · 已上线 v${data.releases.find((release:any)=>release.sourceVersion===version.id).version}`:""}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">当前源码会自动保存。恢复不会修改生产应用；重新检查、预览后再决定上线。</p><Button variant="outline" size="sm" disabled={!p.version||p.running||p.pending||checking} onClick={p.actions.restore}>恢复选中源码</Button></div>
  {error&&<p className="text-sm text-destructive" role="alert">{error}</p>}
 </section>;
}
