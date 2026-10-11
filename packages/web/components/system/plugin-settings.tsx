"use client";
import { useEffect, useState } from "react";
import { Blocks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
const combinations = {
  full: { label: "完整 LocalApp", description: "多人使用、应用托管、在线开发、构建与上线。" },
  platform: { label: "应用平台", description: "多人使用和应用托管；已安装应用继续运行，不提供在线开发。" },
  multiuser: { label: "多人 Agent", description: "账号、个人模型配置与 dsh 对话；不提供应用托管或在线开发。" },
};
type Combination = keyof typeof combinations;
export function SystemPluginSettings() {
  const [choice, setChoice] = useState<Combination>("full");
  const [current, setCurrent] = useState<Combination | null>(null);
  const [controlled, setControlled] = useState(false);
  const [documents, setDocuments] = useState(true);
  const [currentDocuments, setCurrentDocuments] = useState(true);
  const [documentsControlled, setDocumentsControlled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restarting, setRestarting] = useState(false);
  async function load() {
    setError("");
    try {
      const response = await fetch("/api/system/settings/plugins", { credentials: "include" });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "加载插件设置失败");
      if (!Object.hasOwn(combinations, body.data?.combination)) throw new Error("无效的插件组合");
      setCurrent(body.data.combination); setChoice(body.data.combination); setControlled(body.data.controlledByEnvironment === true);
      setDocuments(body.data.documentsEnabled !== false); setCurrentDocuments(body.data.documentsEnabled !== false); setDocumentsControlled(body.data.documentsControlled === true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "加载插件设置失败"); }
  }
  useEffect(() => { void load(); }, []);
  async function save() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/system/settings/plugins", { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ combination: choice, documentsEnabled: documents }) });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "保存插件设置失败");
      setRestarting(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存插件设置失败"); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 rounded-xl border bg-card p-5">
    <h2 className="flex items-center gap-2 font-semibold"><Blocks className="size-4" />插件组合</h2>
    <p className="text-sm text-muted-foreground">切换后 Server 将重启，当前运行的任务和对话会停止。已有应用、源码和会话数据保留。</p>
    {current && <><Label htmlFor="plugin-combination">启用功能</Label><Select value={choice} onValueChange={value => setChoice(value as Combination)} disabled={controlled || busy || restarting}><SelectTrigger id="plugin-combination"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(combinations).map(([value, item]) => <SelectItem key={value} value={value}>{item.label}</SelectItem>)}</SelectContent></Select><p className="text-sm text-muted-foreground">{combinations[choice].description}</p></>}
    {controlled && <p className="text-sm text-muted-foreground">启动配置已指定插件组合，请修改启动配置后重启。</p>}
    {current && <div className="flex items-start justify-between gap-4 rounded-lg border p-4"><div className="space-y-1"><Label htmlFor="document-extension">公共文档 Skills</Label><p className="text-sm text-muted-foreground">提供 PDF、DOCX、XLSX 和 MarkItDown。关闭后应用无法启用这些 Skills，已上传文件保留。</p>{documentsControlled && <p className="text-sm text-muted-foreground">启动配置已指定文档扩展状态。</p>}</div><Switch id="document-extension" checked={documents} onCheckedChange={setDocuments} disabled={documentsControlled || busy || restarting} /></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {restarting && <p role="status" className="text-sm">已保存，正在重启。服务恢复后刷新页面。</p>}
    {!current ? <Button variant="outline" onClick={() => void load()}>重新加载</Button> : <Button onClick={() => void save()} disabled={busy || restarting || (choice === current && documents === currentDocuments)}>{busy ? "保存中…" : "保存并重启"}</Button>}
  </section>;
}
