"use client";
import { createAgentPreferences } from "@localapp/dsh-agent-settings/ui/model-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChoiceSelect } from "@/components/ui/choice-select";
import { AppAgentSettings } from "@/components/app-settings/agent-settings";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
const Preferences=createAgentPreferences({Button,Input,Label,ChoiceSelect,AgentSettings:AppAgentSettings,notifySuccess:message=>toast.success(message)});
export default function Page() {
 const frame = useRef<HTMLIFrameElement>(null);
 const [height, setHeight] = useState(480);
 const [canAdd, setCanAdd] = useState(false);
 const [editing, setEditing] = useState(false);
 const [modelDocument, setModelDocument] = useState<Document | null>(null);
 const addControl = () => Array.from(modelDocument?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(button => ["添加模型提供商", "Add model provider"].includes(button.textContent?.trim() ?? ""));
 useEffect(() => {
  if (!modelDocument) return;
  const update = () => {
   const button = Array.from(modelDocument.querySelectorAll<HTMLButtonElement>("button")).find(button => ["添加模型提供商", "Add model provider"].includes(button.textContent?.trim() ?? ""));
   setCanAdd(!!button && !button.disabled);
   setEditing(!button && !!modelDocument.querySelector('[role="tablist"][aria-label="添加方式"], [role="tablist"][aria-label="Add mode"], input'));
  };
  const observer = new MutationObserver(update);
  observer.observe(modelDocument.body, {subtree:true, childList:true, attributes:true});
  update();
  return () => observer.disconnect();
 }, [modelDocument]);
 useEffect(() => {
  const resize = (event: MessageEvent) => {
   if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow || event.data?.type !== "localapp-model-settings-resize") return;
   const value = event.data.height;
   if (typeof value === "number" && Number.isFinite(value)) setHeight(Math.max(320, Math.min(20000, Math.ceil(value))));
  };
  window.addEventListener("message", resize);
  return () => window.removeEventListener("message", resize);
 }, []);
 return <div className="mx-auto w-full max-w-4xl space-y-6">
  <header><h1 className="text-2xl font-semibold tracking-tight">模型与 Agent</h1><p className="mt-2 text-sm text-muted-foreground">管理你的模型连接与 Agent 能力。配置和凭据仅属于当前账号。</p></header>
  <Tabs defaultValue="models">
   <TabsList aria-label="模型与 Agent 设置"><TabsTrigger value="models">模型供应商</TabsTrigger><TabsTrigger value="agent">Agent 与 MCP</TabsTrigger></TabsList>
   <TabsContent value="models" className="pt-2">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
     <p className="text-sm text-muted-foreground">{editing ? "请先保存或取消当前编辑，再添加下一个供应商。" : "可以添加多个供应商，在对话中选择要使用的模型。"}</p>
     <Button variant="outline" disabled={!canAdd} onClick={() => addControl()?.click()}><Plus className="mr-2 h-4 w-4" />添加供应商</Button>
    </div>
    <iframe ref={frame} onLoad={() => setModelDocument(frame.current?.contentDocument ?? null)} title="dsh 模型供应商设置" src="/api/model-settings/native/" style={{height}} className="block w-full border-0 bg-background" />
   </TabsContent>
   <TabsContent value="agent" className="pt-2"><Preferences /></TabsContent>
  </Tabs>
 </div>;
}
