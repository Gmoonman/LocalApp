"use client";
import { useEffect, useState } from "react";
import { RefreshCw, CheckCircle2, CircleAlert, Monitor } from "lucide-react";
import type {PythonEnvironmentComponents} from "./python-environment-form";
export interface SystemEnvironmentComponents extends Pick<PythonEnvironmentComponents, "Button" | "Card" | "CardHeader" | "CardTitle" | "CardDescription" | "CardContent"> {
  PythonEnvironmentForm: React.JSXElementConstructor<{onUpdated: () => Promise<void>}>;
  Badge: React.JSXElementConstructor<React.HTMLAttributes<HTMLSpanElement> & {variant?:"default"|"secondary"|"outline"}>;
  Skeleton: React.JSXElementConstructor<React.HTMLAttributes<HTMLDivElement>>;
}
type Report = { checkedAt: string; platform: string; ready: boolean; checks: Array<{id:string;name:string;status:"ready"|"missing"|"blocked";detail:string;required:boolean}> };
export function createSystemAgentEnvironment(components: SystemEnvironmentComponents) {
const {Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Skeleton, PythonEnvironmentForm} = components;
return function SystemAgentEnvironment() {
 const [report,setReport]=useState<Report|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const check=async()=>{
  setBusy(true);setError("");setReport(null);
  try {
   const response=await fetch("/api/system/agent-environment",{credentials:"include"});
   const body=await response.json();
   if(!response.ok)throw new Error(body.error || "环境检查失败");
   setReport(body.data);
  }catch(e){setError(e instanceof Error ? e.message : "环境检查失败");}finally{setBusy(false);}
 };
 useEffect(()=>{setReport(null);void check();},[]);
 return <div className="max-w-4xl space-y-5">
  <PythonEnvironmentForm onUpdated={check}/>
  <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Monitor className="size-4"/>环境检查</CardTitle><CardDescription>命令在 LocalApp Server 所在电脑上执行。访问远程 Server 时，检查的是远程电脑，而非当前浏览器所在电脑。</CardDescription></CardHeader><CardContent className="space-y-4">
   <p className="text-sm text-muted-foreground">检查 LocalApp 提供的全部文档 Skills 所需的 Python 和依赖，检查结果适用于所有应用。检查不会安装软件，也不会请求大模型。可选依赖缺失不影响基本就绪状态。</p>
   <div className="flex flex-wrap items-center gap-3"><Button variant="outline" onClick={()=>void check()} disabled={busy}><RefreshCw className={busy ? "size-4 animate-spin" : "size-4"}/>{busy ? "检查中…":"重新检查"}</Button>{report && <Badge variant={report.ready ? "default":"secondary"}>{report.ready ? "已就绪":"尚未就绪"}</Badge>}</div>
   {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
   {report && <p className="text-xs text-muted-foreground">Server 系统：{report.platform} · 检查时间：{new Date(report.checkedAt).toLocaleString()}。更新系统依赖后请重新检查；短时间内重复检查会使用缓存。</p>}
  </CardContent></Card>
  {busy && !report && <Skeleton className="h-48 w-full"/>}
  {report && <Card><CardContent className="divide-y pt-2">{report.checks.map(check=><div key={check.id} className="flex gap-3 py-4">{check.status==="ready" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600"/>:<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600"/>}<div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{check.name}</span><Badge variant="outline">{check.status==="ready" ? "可用":check.status==="blocked" ? "未开启或无法执行":"缺少依赖"}</Badge>{!check.required && <span className="text-xs text-muted-foreground">可选</span>}</div><p className="mt-1 break-all text-sm text-muted-foreground">{check.detail}</p></div></div>)}</CardContent></Card>}
 </div>;
}

}
