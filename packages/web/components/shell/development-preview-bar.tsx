"use client";
import {useRef,useState} from "react";
import {Dialog,DialogContent,DialogTitle,DialogDescription} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@/components/ui/select";
export function DevelopmentPreviewBar({url,onPreview,onClose}:{url:string;onPreview:(url:string)=>void;onClose:()=>void}) {
 const syncButton = useRef<HTMLButtonElement>(null);
 const [syncOpen,setSyncOpen]=useState(false),[notice,setNotice]=useState<string|null>(null);
 const [readSource,setReadSource]=useState("test"),[writeSource,setWriteSource]=useState("test"),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 async function change(read:string,write:string) {
  if(busy)return;
  const id=new URL(url,window.location.origin).searchParams.get("previewId");
  if(!id){setError("预览已失效，请重新打开");return;}
  setBusy(true);setError(null);
  try{
   const response=await fetch(`/api/development/previews/${encodeURIComponent(id)}/data-mode`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({readSource:read,writeSource:write})});
   const result=await response.json();
   if(!response.ok||!result.success)throw new Error(result.error||"切换数据失败");
   setReadSource(read);setWriteSource(write);onPreview(result.data.url);
  }catch(e){setError(e instanceof Error?e.message:"切换数据失败");}finally{setBusy(false);}
 }
 async function sync() {
  const id=new URL(url,window.location.origin).searchParams.get("previewId");
  if(!id||busy)return;
  setBusy(true);setError(null);setNotice(null);
  try {
   const response=await fetch(`/api/development/previews/${encodeURIComponent(id)}/sync-data`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({direction:"production-to-test",confirmed:true})});
   const result=await response.json();
   if(!response.ok||!result.success)throw new Error(result.error||"同步失败");
   setSyncOpen(false);setNotice(`同步完成，原测试数据已备份（${result.data.safetyBackupId}）${result.data.warning ? "。"+result.data.warning : ""}`);
   const refresh=await fetch(`/api/development/previews/${encodeURIComponent(id)}/data-mode`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({readSource,writeSource})});
   const updated=await refresh.json();
   if(!refresh.ok||!updated.success)throw new Error("数据已同步，预览刷新失败，请重新打开预览");
   onPreview(updated.data.url);
  }catch(e){setError(e instanceof Error?e.message:"同步失败");}finally{setBusy(false);}
 }
 return <div className="flex min-w-0 items-center gap-2 text-xs" role="region" aria-label="开发预览状态">
   <span className="whitespace-nowrap text-sky-200" title="开发预览 · 尚未上线">开发预览</span>
   <span className="sr-only">开发预览 · 读取{readSource==="production"?"生产":"测试"} · 写入{writeSource==="production"?"生产":"测试"} · 尚未上线</span>
   <Select value={readSource} onValueChange={next=>void change(next,writeSource)} disabled={busy}>
    <SelectTrigger aria-label="读取数据来源" className="h-7 w-36 border-sky-300/30 bg-transparent text-xs"><SelectValue>{`读：${readSource==="production"?"生产数据":"测试数据"}`}</SelectValue></SelectTrigger>
    <SelectContent><SelectItem value="test">测试数据</SelectItem><SelectItem value="production">生产数据</SelectItem></SelectContent>
   </Select>
   <Select value={writeSource} onValueChange={next=>void change(readSource,next)} disabled={busy}>
    <SelectTrigger aria-label="写入数据来源" className="h-7 w-36 border-sky-300/30 bg-transparent text-xs"><SelectValue>{`写：${writeSource==="production"?"生产数据":"测试数据"}`}</SelectValue></SelectTrigger>
    <SelectContent><SelectItem value="test">测试数据</SelectItem><SelectItem value="production">生产数据</SelectItem></SelectContent>
   </Select>
   <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={busy} ref={syncButton} onClick={()=>setSyncOpen(true)}>从生产刷新测试数据</Button>
   <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={busy} onClick={onClose}>查看已上线版本</Button>
   {notice&&<span role="status" className="sr-only">{notice}</span>}
   <Dialog open={syncOpen} onOpenChange={open=>{if(!busy)setSyncOpen(open)}}>
    <DialogContent onCloseAutoFocus={event=>{event.preventDefault();syncButton.current?.focus()}} closeLabel="关闭数据同步" className="max-w-lg"><div className="space-y-3"><DialogTitle>用生产数据刷新测试环境？</DialogTitle><DialogDescription>将生产数据库和附件完整复制到当前预览的测试环境，替换现有测试数据。生产数据保持不变。同步前自动备份测试数据；结构不兼容时停止同步。</DialogDescription></div>
     {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
     <div className="mt-6 flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={()=>setSyncOpen(false)}>取消</Button><Button variant="destructive" disabled={busy} onClick={()=>void sync()}>{busy?"正在同步…":"确认刷新测试数据"}</Button></div>
    </DialogContent>
   </Dialog>
   {error&&!syncOpen&&<span role="alert" title={error} className="max-w-48 truncate text-xs text-amber-200">{error}</span>}
 </div>;
}
