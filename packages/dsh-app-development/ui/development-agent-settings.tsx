"use client";
import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import type { CreationDialogComponents } from "./creation-dialog";
export interface DevelopmentSettingsComponents extends Pick<CreationDialogComponents, "Dialog" | "DialogContent" | "DialogTitle" | "DialogDescription" | "Button" | "Textarea"> {
  DialogTrigger: React.JSXElementConstructor<React.PropsWithChildren<{asChild?: boolean}>>;
  Label: React.JSXElementConstructor<React.LabelHTMLAttributes<HTMLLabelElement>>;
  Switch: React.JSXElementConstructor<{id?: string; disabled?: boolean; checked: boolean; onCheckedChange: (value: boolean) => void}>;
}
const labels: Record<string, string> = { files: "读写项目文件", skills: "开发 Skills", terminal: "终端命令", jobs: "后台任务", subagents: "子 Agent", workflow: "Workflow 脚本", web: "网页访问", schedule: "定时任务", mcp: "个人 MCP 服务" };
interface Preferences { availableCapabilities: string[]; enabledCapabilities: string[]; disabledTools: string[]; enabledSkills?: string[]; skills?: Array<{ id: string; name: string; description: string; available: boolean; unavailableReason?: string }> }
export type DevelopmentSettingsFormComponents = Pick<DevelopmentSettingsComponents, "Button" | "Textarea" | "Label" | "Switch">;
export function createDevelopmentSettingsForm(components: DevelopmentSettingsFormComponents) {
const {Button, Textarea, Label, Switch} = components;
return function DevelopmentSettingsForm({projectId, onSaved, onCancel, onBusyChange}: {
  projectId: string; onSaved?: () => void; onCancel?: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const [value, setValue] = useState<Preferences | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [tools, setTools] = useState("");
  useEffect(() => { setSaved(false); }, [value, tools]);
  const endpoint = `/api/development/projects/${encodeURIComponent(projectId)}/agent/settings`;
  useEffect(() => {
    let active = true;
    setValue(null); setError("");
    void fetch(endpoint, { credentials: "include" }).then(async response => {
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "加载开发设置失败");
      if (active) { setValue(body.data); setTools(body.data.disabledTools.join("\n")); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "加载开发设置失败"); });
    return () => { active = false; };
  }, [endpoint]);
  async function save() {
    if (!value) return;
    setBusy(true); onBusyChange?.(true); setError(""); setSaved(false);
    try {
      const response = await fetch(endpoint, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabledCapabilities: value.enabledCapabilities, enabledSkills: value.enabledSkills ?? [], disabledTools: [...new Set(tools.split(/\n/).map(name => name.trim()).filter(Boolean))] }) });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "保存开发设置失败");
      setSaved(true); onSaved?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存开发设置失败"); }
    finally { setBusy(false); onBusyChange?.(false); }
  }
  return <>
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      {!value && !error && <p role="status" className="mt-4 text-sm text-muted-foreground">正在加载…</p>}
      {value && <div className="mt-5 space-y-4">
        {value.availableCapabilities.map(capability => <div key={capability} className="flex items-center justify-between gap-4">
          <Label htmlFor={`development-${capability}`}>{labels[capability] ?? capability}</Label>
          <Switch id={`development-${capability}`} disabled={busy} checked={value.enabledCapabilities.includes(capability)} onCheckedChange={enabled => setValue({ ...value, enabledCapabilities: enabled ? [...value.enabledCapabilities, capability] : value.enabledCapabilities.filter(item => item !== capability) })} />
        </div>)}
        {!!value.skills?.length && <div className="space-y-4 border-t pt-4">
          <p className="text-sm font-medium">公共文档 Skills</p>
          {value.skills.map(skill => <div key={skill.id} className="flex items-start justify-between gap-4">
            <div className="space-y-1"><Label htmlFor={`development-skill-${skill.id}`}>{skill.name}</Label><p className="text-xs text-muted-foreground">{skill.description}</p>{!skill.available && <p className="text-xs text-muted-foreground">{skill.unavailableReason}</p>}</div>
            <Switch id={`development-skill-${skill.id}`} disabled={busy || (!skill.available && !(value.enabledSkills ?? []).includes(skill.id))} checked={(value.enabledSkills ?? []).includes(skill.id)} onCheckedChange={enabled => setValue({ ...value, enabledSkills: enabled ? [...(value.enabledSkills ?? []), skill.id] : (value.enabledSkills ?? []).filter(id => id !== skill.id) })} />
          </div>)}
          <p className="text-xs text-muted-foreground">执行文档 Skill 需要启用上方的开发 Skills 能力。</p>
        </div>}
        <div className="space-y-2"><Label htmlFor="development-disabled-tools">禁用工具</Label><Textarea id="development-disabled-tools" value={tools} onChange={event => setTools(event.target.value)} disabled={busy} placeholder={"每行一个工具名，例如 write 或 bash"} /><p className="text-xs text-muted-foreground">保留能力，同时关闭其中的指定工具。</p></div>
      </div>}
      <div className="mt-6 flex justify-end gap-2">{onCancel && <Button variant="outline" disabled={busy} onClick={onCancel}>取消</Button>}<Button disabled={busy || !value} onClick={() => void save()}>{busy ? "正在保存…" : "保存"}</Button></div>
    {saved && <p role="status" className="mt-4 text-sm text-muted-foreground">开发 Agent 设置已保存</p>}
  </>;
};
}

export function createDevelopmentAgentSettings(components: DevelopmentSettingsComponents) {
  const {Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger, Button} = components;
  const Form = createDevelopmentSettingsForm(components);
  return function DevelopmentAgentSettings({projectId}: {projectId: string}) {
    const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
    return <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
      <DialogTrigger asChild><Button variant="ghost" size="icon" aria-label="开发 Agent 设置" title="开发 Agent 设置"><Settings size={17} /></Button></DialogTrigger>
      <DialogContent closeLabel="关闭开发设置" className="max-h-[85dvh] max-w-lg overflow-y-auto">
        <DialogTitle className="text-lg font-semibold">开发 Agent 设置</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">仅影响你在此应用中的开发 Agent。保存会停止当前开发任务，之后的对话使用新设置。</DialogDescription>
        {open && <Form projectId={projectId} onBusyChange={setBusy} onSaved={() => setOpen(false)} onCancel={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>;
  };
}
