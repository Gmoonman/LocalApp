"use client";
import { useEffect, useState } from "react";
import { requestCapabilitySettings } from "@localapp/dsh-agent-settings/capability-settings-client";
import type { PythonEnvironmentComponents } from "@localapp/dsh-execution-environment/ui/python-environment-form";
export interface AgentCapabilityComponents extends PythonEnvironmentComponents {
  Badge: React.JSXElementConstructor<React.HTMLAttributes<HTMLSpanElement> & {variant?: "default" | "secondary" | "outline"}>;
  Skeleton: React.JSXElementConstructor<React.HTMLAttributes<HTMLDivElement>>;
}
import { Bot, FileText, FileSpreadsheet, FileType, FolderOpen, Terminal, Search, Wrench, Sparkles, Save, Check, ChevronDown, ChevronUp, Settings2 } from "lucide-react";

type Settings = {
  appId: string;
  capabilities: string[];
  enabledCapabilities: string[];
  enabledSkills: string[];
  disabledTools: string[];
  skills: Array<{ id: string; name: string; description: string; dependencies: string; available?: boolean; unavailableReason?: string }>;
  toolsNotice?: string;
  tools: Array<{ name: string; description: string; source: string }>;
};
const labels: Record<string, string> = { files: "工作区文件", terminal: "终端执行", skills: "Skills", mcp: "MCP 服务", subagents: "子 Agent", jobs: "后台任务", web: "网页访问", workflow: "工作流", schedule: "定时任务" };
export function createAgentCapabilitySettings(components: AgentCapabilityComponents) {
const {Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Switch, Badge, Input, Label, Skeleton} = components;
return function AppAgentSettings({ appId }: { appId: string }) {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [showRequirements, setShowRequirements] = useState(false);
  const [expandedTools, setExpandedTools] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setSettings(undefined); setError(""); setSaved(false);
    requestCapabilitySettings(appId).then((data) => {
      if (live) setSettings(data);
    }).catch((error) => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [appId]);
  const toggle = (field: "enabledCapabilities" | "enabledSkills" | "disabledTools", id: string) => {
    setSaved(false);
    setSettings((current) => current && ({ ...current, [field]: current[field].includes(id) ? current[field].filter((value) => value !== id) : [...current[field], id] }));
  };
  const save = async () => {
    setBusy(true); setError(""); setSaved(false);
    try {
      if (!settings) return;
      const data = await requestCapabilitySettings(appId, {
        enabledCapabilities: settings.enabledCapabilities,
        enabledSkills: settings.enabledSkills,
        disabledTools: settings.disabledTools,
      });
      setSettings(data); setSaved(true);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const tools = settings?.tools.filter((tool) => (source === "all" || tool.source === source) && `${tool.name} ${tool.description} ${toolLabels[tool.name] ?? ""}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <section className="max-w-4xl space-y-5">
    <div className="flex items-start gap-3 rounded-lg bg-muted/40 p-4">
      <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-1 text-sm"><p>{appId === "platform" ? "为你的工作区 Agent 选择能力和工具。" : "为你在此应用中的 Agent 选择能力和工具。"}</p><p className="text-muted-foreground">仅对你的账号生效。<a className="font-medium underline underline-offset-4" href="/my/models">管理模型供应商</a></p></div>
    </div>
    {error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</p>}
    {!settings ? !error && <div role="status" aria-label="加载中" className="space-y-4"><Skeleton className="h-40 w-full rounded-xl" /><Skeleton className="h-64 w-full rounded-xl" /></div> : <>
      <Card className="shadow-sm">
        <CardHeader className="pb-4"><CardTitle className="flex items-center gap-2 text-base"><Settings2 className="size-4 text-muted-foreground" />可用能力<Badge variant="outline" className="ml-auto">{settings.enabledCapabilities.length} / {settings.capabilities.length}</Badge></CardTitle><CardDescription>{appId === "platform" ? "工作区能力需要你开启后才会使用。" : "应用声明的能力，需要你开启后才会使用。"}</CardDescription></CardHeader>
        <CardContent>
          {settings.capabilities.length ? <div className="divide-y">{settings.capabilities.map((id) => {
            const Icon = id === "files" ? FolderOpen : id === "terminal" ? Terminal : id === "skills" ? Sparkles : Wrench;
            return <div key={id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"><Icon className="size-4 shrink-0 text-muted-foreground" /><Label htmlFor={`capability-${id}`} className="flex-1 cursor-pointer text-sm font-normal">{labels[id] ?? id}</Label><Switch id={`capability-${id}`} aria-label={labels[id] ?? id} checked={settings.enabledCapabilities.includes(id)} disabled={busy} onCheckedChange={() => toggle("enabledCapabilities", id)} /></div>;
          })}</div> : <p className="text-sm text-muted-foreground">应用尚未声明 Agent 扩展能力。</p>}
        </CardContent>
      </Card>
      <Card className="shadow-sm">
        <CardHeader className="pb-4"><CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4 text-muted-foreground" />公共文档 Skills<Badge variant="outline" className="ml-auto">{settings.enabledSkills.length} 已选</Badge></CardTitle><CardDescription>按需开启文档处理，默认关闭。</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {!settings.capabilities.includes("skills") && <p className="text-sm text-muted-foreground">此应用尚未开放 Skills 能力。</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {settings.skills.map((skill) => {
              const Icon = skill.id === "xlsx" ? FileSpreadsheet : skill.id === "docx" ? FileType : FileText;
              const selected = settings.enabledSkills.includes(skill.id);
              return <div key={skill.id} className={`rounded-lg border p-4 transition-colors ${selected ? "border-primary/40 bg-primary/5" : "bg-background"}`}>
                <div className="flex items-center gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"><Icon className="size-4 text-muted-foreground" /></div><Label htmlFor={`skill-${skill.id}`} className="min-w-0 flex-1 cursor-pointer font-medium">{skill.name}</Label><Switch id={`skill-${skill.id}`} aria-label={skill.name} checked={selected} disabled={busy || !settings.capabilities.includes("skills") || skill.available === false} onCheckedChange={() => toggle("enabledSkills", skill.id)} /></div>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{skill.description}</p>{skill.available === false && <p className="mt-2 text-xs text-amber-700">{skill.unavailableReason}</p>}
              </div>;
            })}
          </div>
          <Button variant="ghost" size="sm" className="-ml-3 text-muted-foreground" aria-expanded={showRequirements} onClick={() => setShowRequirements(!showRequirements)}>{showRequirements ? <ChevronUp /> : <ChevronDown />}运行要求</Button>
          {showRequirements && <div className="space-y-2 rounded-lg bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground"><p>运行脚本需要开启 Skills、工作区文件和终端执行，系统依赖由管理员在系统设置中检查。扫描件需要 OCR；图片理解还需要应用和模型支持图片输入。</p>{settings.skills.map((skill) => <p key={skill.id}><span className="font-medium text-foreground">{skill.name}：</span>{skill.dependencies}</p>)}</div>}
        </CardContent>
      </Card>
      <Card className="shadow-sm">
        <CardHeader className="pb-4"><CardTitle className="flex items-center gap-2 text-base"><Wrench className="size-4 text-muted-foreground" />工具<Badge variant="outline" className="ml-auto">{settings.tools.filter((tool) => !settings.disabledTools.includes(tool.name)).length} 已开启</Badge></CardTitle><CardDescription>关闭后，Agent 无法调用对应工具。</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center"><div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="搜索工具" placeholder="搜索工具…" className="pl-9" value={query} onChange={(event:React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} /></div><div className="flex gap-1 rounded-lg bg-muted/60 p-1" role="group" aria-label="工具来源">{[["all", "全部"], ["app", "应用"], ["dsh", "DSH"]].map(([id, text]) => <Button key={id} size="sm" variant={source === id ? "secondary" : "ghost"} className={source === id ? "bg-background shadow-sm" : "text-muted-foreground"} aria-pressed={source === id} onClick={() => setSource(id)}>{text}</Button>)}</div></div>
          {settings.toolsNotice && <p className="text-sm text-muted-foreground">{settings.toolsNotice}</p>}
          <div className="divide-y">{tools.map((tool) => {
            const key = `${tool.source}:${tool.name}`;
            const expanded = expandedTools.includes(key);
            return <div key={key} className="py-3 first:pt-0 last:pb-0"><div className="flex items-center gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><Label htmlFor={`tool-${key}`} className="cursor-pointer break-all font-medium">{toolLabels[tool.name] ?? tool.name}</Label><Badge variant="outline">{tool.source === "app" ? "应用" : "DSH"}</Badge></div>{toolLabels[tool.name] && <p className="mt-1 font-mono text-xs text-muted-foreground">{tool.name}</p>}</div><Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" aria-label={`${tool.name} 详情`} aria-expanded={expanded} onClick={() => setExpandedTools((current) => expanded ? current.filter((value) => value !== key) : [...current, key])}>{expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}</Button><Switch id={`tool-${key}`} aria-label={tool.name} checked={!settings.disabledTools.includes(tool.name)} disabled={busy} onCheckedChange={() => toggle("disabledTools", tool.name)} /></div>{expanded && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">{tool.description}</p>}</div>;
          })}</div>
          {!tools.length && <p className="py-4 text-center text-sm text-muted-foreground">{query ? "没有匹配的工具" : "暂无工具"}</p>}
          <p className="text-xs leading-relaxed text-muted-foreground">打开应用后同步应用工具；开启能力并保存后显示相应 DSH 工具。</p>
        </CardContent>
      </Card>
      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-4 backdrop-blur"><span role={saved ? "status" : undefined} className="flex items-center gap-2 text-sm text-muted-foreground">{saved ? <><Check className="size-4" />Agent 设置已保存</> : "选择仅用于当前用户和应用"}</span><Button disabled={busy} onClick={save}><Save className="size-4" />{busy ? "保存中..." : "保存 Agent 设置"}</Button></div>
    </>}
  </section>;
}

}

const toolLabels: Record<string, string> = { read: "读取文件", write: "写入文件", edit: "编辑文件", glob: "查找文件", grep: "搜索文件内容", bash: "执行命令", skill: "加载 Skill", ask_user_question: "向用户提问", exit_plan_mode: "确认执行计划", todo_write: "任务清单", get_goal: "查看目标", create_goal: "创建目标", update_goal: "更新目标", getCurrentUser: "当前用户", subagent: "创建子 Agent", subagent_fork: "复制子 Agent", workflow: "运行工作流" };
