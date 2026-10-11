"use client";
import { useEffect, useState } from "react";
import type { ModelSettingsComponents } from "./model-settings";
export interface PythonEnvironmentComponents extends Pick<ModelSettingsComponents, "Button" | "Input" | "Label"> {
  Card: React.JSXElementConstructor<React.HTMLAttributes<HTMLDivElement>>;
  CardHeader: React.JSXElementConstructor<React.HTMLAttributes<HTMLDivElement>>;
  CardTitle: React.JSXElementConstructor<React.HTMLAttributes<HTMLDivElement>>;
  CardDescription: React.JSXElementConstructor<React.HTMLAttributes<HTMLDivElement>>;
  CardContent: React.JSXElementConstructor<React.HTMLAttributes<HTMLDivElement>>;
  Switch: React.JSXElementConstructor<{id?: string; checked: boolean; onCheckedChange: (value: boolean) => void; disabled?: boolean}>;
}
type Environment = { executable:string; directory:string; version:string; managed:boolean };
export function createPythonEnvironmentForm(components: PythonEnvironmentComponents) {
const {Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Input, Label, Switch} = components;
return function PythonEnvironmentForm({onUpdated}:{onUpdated:()=>Promise<void>}) {
 const [environment,setEnvironment]=useState<Environment|null>(null);
 const [executable,setExecutable]=useState("");
 const [baseExecutable,setBaseExecutable]=useState("");
 const [installDocuments,setInstallDocuments]=useState(false);
 const [mode,setMode]=useState("existing");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [message,setMessage]=useState("");
 useEffect(()=>{
  let live=true;
  fetch("/api/system/python-environment",{credentials:"include"}).then(async response=>{
   const body=await response.json(); if(!response.ok)throw new Error(body.error || "加载 Python 配置失败");
   if(live){setEnvironment(body.data.environment ?? null);setExecutable(body.data.environment?.executable ?? "");}
  }).catch(e=>{if(live)setError(e.message);});
  return ()=>{live=false;};
 },[]);
 const update=async(action:"select"|"create"|"install")=>{
  setBusy(true);setError("");setMessage("");
  try {
   const url=action === "select" ? "/api/system/python-environment" : action === "create" ? "/api/system/python-environment/create" : "/api/system/python-environment/install-document-dependencies";
   const response=await fetch(url,{method:action === "select" ? "PUT":"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(action === "select" ? {executable} : action === "create" ? {baseExecutable,installDocuments} : {})});
   const body=await response.json();if(!response.ok)throw new Error(body.error || "更新失败");
   setEnvironment(body.data.environment);setExecutable(body.data.environment.executable);setMessage("Python 环境已更新，后续 Agent 命令将使用此环境。");await onUpdated();
  }catch(e){setError(e instanceof Error ? e.message : "更新失败");}finally{setBusy(false);}
 };
 return <Card><CardHeader><CardTitle className="text-base">Python 环境</CardTitle><CardDescription>LocalApp Server 的通用 Python 虚拟环境，供所有应用的 Agent 脚本使用。</CardDescription></CardHeader><CardContent className="space-y-4">
  <p className="break-all text-sm text-muted-foreground">{environment ? `当前环境：Python ${environment.version} · ${environment.executable}` : "尚未配置专用虚拟环境；当前使用 Server 可找到的 Python。"}</p>
  <div role="group" aria-label="Python 环境配置方式" className="flex flex-wrap gap-2"><Button variant={mode === "existing" ? "secondary":"outline"} onClick={()=>setMode("existing")} disabled={busy}>使用已有虚拟环境</Button><Button variant={mode === "create" ? "secondary":"outline"} onClick={()=>setMode("create")} disabled={busy}>创建专用虚拟环境</Button></div>
  {mode === "existing" ? <div className="space-y-2"><Label htmlFor="python-executable">虚拟环境 Python 路径</Label><Input id="python-executable" value={executable} onChange={e=>setExecutable(e.target.value)} placeholder="/path/to/.venv/bin/python" disabled={busy}/><Button onClick={()=>void update("select")} disabled={busy || !executable.trim()}>保存并使用</Button></div> : <div className="space-y-3"><Label htmlFor="python-base">基础 Python 路径（3.10+）</Label><Input id="python-base" value={baseExecutable} onChange={e=>setBaseExecutable(e.target.value)} placeholder="/path/to/python3" disabled={busy}/><div className="flex items-center gap-2"><Switch id="python-documents" checked={installDocuments} onCheckedChange={setInstallDocuments} disabled={busy}/><Label htmlFor="python-documents">同时安装公共文档 Skills 依赖</Label></div><p className="text-xs text-muted-foreground">在 LocalApp 数据目录创建独立虚拟环境，不覆盖已有目录。安装依赖时会从 PyPI 下载包。</p><Button onClick={()=>void update("create")} disabled={busy || !baseExecutable.trim()}>创建并使用</Button></div>}
  {environment && <Button variant="outline" disabled={busy} onClick={()=>void update("install")}>安装文档 Skills 依赖</Button>}
  {busy && <p role="status" className="text-sm text-muted-foreground">正在更新 Python 环境，安装依赖可能需要几分钟…</p>}
  {error && <p role="alert" className="break-all text-sm text-destructive">{error}</p>}
  {message && <p role="status" className="text-sm text-green-700">{message}</p>}
 </CardContent></Card>;
}

}
