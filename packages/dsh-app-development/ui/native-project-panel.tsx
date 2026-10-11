import { useEffect, useRef, useState } from "react";
import { DiffBlock, TerminalBlock } from "@deepseek-ai/dsh-client-ui-primitives";
import { Button } from "@localapp/dsh-multiuser/ui/shadcn/button";
import { Input } from "@localapp/dsh-multiuser/ui/shadcn/input";
import { Textarea } from "@localapp/dsh-multiuser/ui/shadcn/textarea";
import { ChoiceSelect } from "@localapp/dsh-multiuser/ui/shadcn/choice-select";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@localapp/dsh-multiuser/ui/shadcn/dialog";
import { createDevelopmentPage } from "./development-page";
import type { DevelopmentShellProps } from "./development-types";
const folding = {
  codeLabel:"代码",wrapLabel:"自动换行",unwrapLabel:"保留列宽",
  copy:"复制",copied:"已复制",collapseAria:"收起",collapse:"收起",
  expandAria:(n:number)=>`展开 ${n} 行`,expand:(n:number)=>`展开 ${n} 行`,
};

function ProjectContents(p: DevelopmentShellProps) {
  const [path, setPath] = useState("");
  const ready = p.build?.status === "succeeded";
  const building = ["queued", "running"].includes(p.build?.status);
  return <div className="localapp-native-settings h-full overflow-auto p-4 space-y-4">
    <h2 className="text-lg font-semibold">{p.project?.name ?? "加载应用…"}</h2>
    {p.error && <p role="alert" className="text-destructive">{p.error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button disabled={!p.project || p.pending || building} onClick={p.actions.build}>检查与构建</Button>
      {building && <Button variant="outline" onClick={p.actions.cancelBuild}>取消构建</Button>}
      <Button variant="outline" disabled={!ready || p.pending} onClick={p.actions.preview}>预览</Button>
      <Button variant="outline" disabled={!ready || p.pending || p.build?.purpose === "preview"} onClick={p.actions.publish}>上线</Button>
    </div>
    <div className="grid gap-4 md:grid-cols-[220px_1fr]">
      <aside className="space-y-2">
        <ChoiceSelect label="源码文件" value={p.file?.path ?? ""} options={p.files.map(value => ({value,label:value}))} onValueChange={p.actions.open} contentClassName="localapp-native-settings" />
        <Input aria-label="新文件路径" placeholder="新文件路径" value={path} onChange={e=>setPath(e.target.value)} />
        <Button variant="outline" disabled={!path.trim() || p.pending || !p.project} onClick={()=>p.actions.newFile(path.trim())}>新建文件</Button>
        <ChoiceSelect label="源码版本" value={p.version} options={p.versions.map(v=>({value:v.id,label:v.message || v.id}))} onValueChange={p.actions.setVersion} contentClassName="localapp-native-settings" />
        <div className="flex gap-2">
          <Button variant="outline" disabled={!p.version || p.pending} onClick={p.actions.diff}>查看改动</Button>
          <Button variant="outline" disabled={!p.version || p.pending} onClick={p.actions.restore}>恢复版本</Button>
        </div>
      </aside>
      <section className="space-y-2">
        {p.file ? <><p className="text-sm">{p.file.path}</p><Textarea aria-label="源码内容" className="min-h-80 font-mono" value={p.text} onChange={e=>p.actions.setText(e.target.value)} /><Button disabled={p.pending} onClick={p.actions.save}>保存文件</Button></> : <p className="text-muted-foreground">选择源码文件开始编辑，也可以回到对话让 Agent 修改。</p>}
      </section>
    </div>
    {p.changes.length > 0 && <section aria-label="源码改动"><DiffBlock diffs={p.changes.map(c=>({path:c.path,oldText:c.before,newText:c.after??""}))} labels={folding} maxLines={60}/></section>}
    {p.build && <p role="status">构建：{p.build.status}</p>}
    {(p.log || building) && <section aria-label="构建日志"><TerminalBlock command="应用检查与构建" output={p.log} running={building}
      exitCode={p.build?.status === "succeeded" ? 0 : p.build?.status === "failed" ? 1 : undefined}
      labels={{...folding,commandLine:n=>`命令第 ${n} 行`,signal:s=>`信号 ${s}`,exitCode:n=>`退出码 ${n}`,noExitCode:"已结束",running:"运行中",failed:"失败",done:"已完成",noOutput:"暂无输出"}}/></section>}
  </div>;
}
const Page = createDevelopmentPage({AppDevelopmentDock:()=>null,DshDevelopmentShell:ProjectContents});
export function NativeProjectPanel({projectId,onConversation}:{projectId:string;onConversation:()=>void}) {
  const [confirmation,setConfirmation] = useState("");
  const pending = useRef<((value:boolean)=>void) | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  useEffect(()=>()=>{pending.current?.(false);pending.current=null;},[]);
  function settle(value:boolean) {pending.current?.(value);pending.current=null;setConfirmation("");}
  return <div className="h-full overflow-hidden flex flex-col">
    <div className="localapp-native-settings p-3 border-b"><Button variant="ghost" onClick={onConversation}>返回开发对话</Button></div>
    <div className="flex-1 min-h-0"><Page initialProjectId={projectId} workspaceOnly confirmAction={message=>new Promise(resolve=>{pending.current?.(false);pending.current=resolve;focus.current=document.activeElement as HTMLElement;setConfirmation(message);})} /></div>
    <Dialog open={!!confirmation} onOpenChange={open=>{if(!open)settle(false);}}>
      <DialogContent className="localapp-native-settings max-w-md" closeLabel="关闭确认" onCloseAutoFocus={event=>{event.preventDefault();focus.current?.focus();}}>
        <DialogTitle>确认操作</DialogTitle><DialogDescription className="my-4">{confirmation}</DialogDescription>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={()=>settle(false)}>取消</Button><Button onClick={()=>settle(true)}>确认</Button></div>
      </DialogContent>
    </Dialog>
  </div>;
}
