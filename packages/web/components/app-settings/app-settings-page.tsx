"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleCheck, CircleOff, Database, Download, ExternalLink, Plus, Power, RefreshCw, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

type Json = Record<string, any>;
type Version = { version: number; createdAt: string; fileCount: number; totalSize: number };
type Settings = {
  app: { name: string; userId: string; currentVersion: number; versionCount: number; createdAt: string; updatedAt: string; lifecycleStatus: "online" | "offline"; versions: Version[] };
  sourceKind: "uploaded" | "legacy-projection";
  sourceManifest: Json;
  platformManifest: Json;
  effectiveManifest: Json;
};
type Backup = {
  id: string;
  name: string;
  createdAt: string;
  size: number;
  source: string;
  format: "zip" | "legacy-db";
  fileCount: number;
  fileSize: number;
  reason?: string;
};
type DataState = {
  database: { exists: boolean; size: number };
  files: { count: number; size: number };
  backups: Backup[];
};
import { AppAgentSettings } from "./agent-settings";

type Tab = "agent" | "info" | "general" | "access" | "database" | "notify" | "data" | "manage";

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "info", label: "应用信息" },
  { id: "general", label: "基础设置" },
  { id: "access", label: "访问控制" },
  { id: "database", label: "数据权限" },
  { id: "notify", label: "通知" },
  { id: "data", label: "数据管理" },
  { id: "manage", label: "应用管理" },
  { id: "agent", label: "Agent" },
];
const accessLevels = ["public", "authenticated", "owner", "acl"];

async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body.data;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function AppSettingsPage({ name }: { name: string }) {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Json>({});
  const [view, setView] = useState<"platform" | "source">("platform");
  const [tab, setTab] = useState<Tab>("info");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<DataState | null>(null);
  const [backupName, setBackupName] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const base = `/api/me/pages/${encodeURIComponent(name)}`;

  const load = async () => {
    const loaded = await json<Settings>(`${base}/settings`);
    setSettings(loaded);
    setDraft(loaded.platformManifest);
  };
  const loadData = async () => setData(await json<DataState>(`${base}/data`));

  useEffect(() => { void load().catch(() => toast.error("加载应用设置失败")); }, [name]);
  useEffect(() => {
    const selected = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (selected && tabs.some((item) => item.id === selected)) setTab(selected);
  }, []);
  useEffect(() => { tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [tab, !!settings]);
  useEffect(() => { if (tab === "data") void loadData().catch(() => toast.error("加载数据状态失败")); }, [tab]);

  const manifest = useMemo(() => view === "source" ? settings?.sourceManifest ?? {} : draft, [view, settings, draft]);
  const readonly = view === "source";
  const change = (path: string[], value: unknown) => {
    setDraft((current) => {
      const next = structuredClone(current);
      let cursor = next;
      for (const key of path.slice(0, -1)) cursor = cursor[key] ??= {};
      cursor[path.at(-1)!] = value;
      return next;
    });
  };
  const switchTab = (next: Tab) => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  };
  const save = async () => {
    setBusy(true);
    try {
      const loaded = await json<Settings>(`${base}/settings/manifest-platform`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
      });
      setSettings(loaded); setDraft(loaded.platformManifest); toast.success("平台配置已保存");
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  };
  const confirmName = () => window.prompt(`请输入应用名 ${name} 以确认操作`) === name;
  const dataAction = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try { await action(); await loadData(); toast.success(success); }
    catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  };
  const changeLifecycle = async (status: "online" | "offline") => {
    if (status === "offline" && !window.confirm("下线后，所有用户将无法访问应用页面和应用 API。确定继续？")) return;
    setBusy(true);
    try {
      const loaded = await json<Settings>(`${base}/lifecycle`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setSettings(loaded);
      setDraft((current) => ({ ...current, lifecycle: loaded.platformManifest.lifecycle }));
      toast.success(status === "offline" ? "应用已下线" : "应用已重新上线");
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  };
  const factoryReset = () => confirmName() && dataAction(async () => {
    await json(`${base}/data/factory-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmName: name }),
    });
    await load();
  }, "已恢复出厂设置");
  const deleteApp = async () => {
    if (!confirmName()) return;
    setBusy(true);
    try {
      await json(base, { method: "DELETE" });
      toast.success("应用已永久删除");
      router.push("/my/apps");
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  };

  if (!settings) return <p className="text-muted-foreground">加载中...</p>;
  const pageAccess = manifest.pageAccess ?? { level: "public", acl: [] };
  const db = manifest.db ?? { mode: "crud", sqlAccess: "owner", defaultAccess: {} };
  const notify = manifest.notify ?? { enabled: false };
  const manifestTab = !(["info", "data", "manage", "agent"] as Tab[]).includes(tab);

  return <div className="w-full">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <Button asChild variant="ghost" size="icon"><Link href="/my/apps" title="返回我的应用"><ArrowLeft /></Link></Button>
        <div className="min-w-0"><h1 className="truncate text-2xl font-bold">{settings.app.name} 设置</h1><p className="text-sm text-muted-foreground">{settings.app.userId} / v{settings.app.currentVersion}</p></div>
      </div>
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
        <div className="inline-flex shrink-0 rounded-md border p-0.5" role="group" aria-label="配置来源">
          <button aria-pressed={view === "platform"} className={`h-8 px-3 text-sm ${view === "platform" ? "rounded bg-secondary font-medium" : "text-muted-foreground"}`} onClick={() => setView("platform")}>平台配置</button>
          <button aria-pressed={view === "source"} className={`h-8 px-3 text-sm ${view === "source" ? "rounded bg-secondary font-medium" : "text-muted-foreground"}`} onClick={() => setView("source")}>应用自带配置</button>
        </div>
        {settings.app.lifecycleStatus === "online"
          ? <Button asChild variant="outline" size="sm"><Link href={`/${settings.app.userId}/${settings.app.name}/`}><ExternalLink />打开应用</Link></Button>
          : <Button asChild variant="outline" size="sm"><Link href={`/${settings.app.userId}/${settings.app.name}/`}><CircleOff />查看下线页</Link></Button>}
      </div>
    </div>

    <div ref={tabsRef} className="mb-5 flex gap-1 overflow-x-auto border-b" role="tablist">
      {tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} className={`h-10 shrink-0 border-b-2 px-3 text-sm ${tab === item.id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground"}`} onClick={() => switchTab(item.id)}>{item.label}</button>)}
    </div>

    {manifestTab && <div className="mb-5 flex items-center justify-end border-b pb-4">
      {readonly ? <span className="text-xs font-medium text-muted-foreground">只读</span> : <Button size="sm" onClick={save} disabled={busy}><Save />保存配置</Button>}
    </div>}

    {tab === "agent" && <AppAgentSettings appId={`${settings.app.userId}/${settings.app.name}`} />}
    {tab === "info" && <section className="space-y-5">
      <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2"><Info label="应用名称" value={settings.app.name}/><Info label="所有者" value={settings.app.userId}/><Info label="创建时间" value={new Date(settings.app.createdAt).toLocaleString()}/><Info label="更新时间" value={new Date(settings.app.updatedAt).toLocaleString()}/><Info label="当前版本" value={`v${settings.app.currentVersion}`}/><Info label="版本数量" value={String(settings.app.versionCount)}/></dl>
      <div><h2 className="mb-2 text-sm font-semibold">版本历史</h2><div className="divide-y border-y">{settings.app.versions.slice().reverse().map((version) => <div key={version.version} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span className="font-medium">v{version.version}</span><span className="text-muted-foreground">{new Date(version.createdAt).toLocaleString()} · {version.fileCount} 个文件 · {formatSize(version.totalSize)}</span></div>)}</div></div>
    </section>}

    {tab === "general" && <section className="max-w-2xl space-y-5">
      <Field label="应用描述"><Textarea id="description" aria-label="应用描述" value={manifest.description ?? ""} disabled={readonly} onChange={(e) => change(["description"], e.target.value)} /></Field>
      <Check label="显示平台导航栏" checked={manifest.shell?.navbar ?? true} disabled={readonly} onChange={(value) => change(["shell", "navbar"], value)} />
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Switch id="agent-conversation" checked={manifest.shell?.agentConversation ?? (readonly ? false : settings.sourceManifest.shell?.agentConversation ?? false)} disabled={readonly || busy} onCheckedChange={(value) => change(["shell", "agentConversation"], value)} />
          <Label htmlFor="agent-conversation">启用 Agent 对话框</Label>
        </div>
        <p className="text-sm text-muted-foreground">关闭后，应用页面不显示 Agent 入口和对话框。开发管理仍可从“应用开发”进入。保存后重新打开应用生效。</p>
      </div>
    </section>}
    {tab === "access" && <section className="max-w-2xl space-y-5"><Select label="页面访问级别" value={pageAccess.level} disabled={readonly} onChange={(value) => change(["pageAccess", "level"], value)} options={accessLevels}/><Field label="ACL 用户或群组"><Input value={(pageAccess.acl ?? []).join(", ")} disabled={readonly} placeholder="user-id, group:team" onChange={(e) => change(["pageAccess", "acl"], e.target.value.split(",").map((v) => v.trim()).filter(Boolean))}/></Field></section>}
    {tab === "database" && <section className="max-w-2xl space-y-5"><Select label="数据库模式" value={db.mode ?? "crud"} disabled={readonly} onChange={(value) => change(["db", "mode"], value)} options={["crud", "sql"]}/><Select label="原始 SQL 权限" value={db.sqlAccess ?? "owner"} disabled={readonly} onChange={(value) => change(["db", "sqlAccess"], value)} options={accessLevels}/><Check label="允许前端直接执行 SQL" checked={db.dangerouslyAllowFrontendSql ?? false} disabled={readonly} onChange={(value) => change(["db", "dangerouslyAllowFrontendSql"], value)}/>{["read", "create", "update", "delete"].map((action) => <Select key={action} label={`${action.toUpperCase()} 默认权限`} value={db.defaultAccess?.[action] ?? "public"} disabled={readonly} onChange={(value) => change(["db", "defaultAccess", action], value)} options={accessLevels}/>)}</section>}
    {tab === "notify" && <section className="max-w-2xl space-y-5"><Check label="启用应用通知" checked={notify.enabled ?? false} disabled={readonly} onChange={(value) => change(["notify", "enabled"], value)}/><Field label="通知权限表"><Input value={notify.permission?.table ?? ""} disabled={readonly} onChange={(e) => change(["notify", "permission", "table"], e.target.value)}/></Field><Field label="用户字段"><Input value={notify.permission?.userColumn ?? ""} disabled={readonly} onChange={(e) => change(["notify", "permission", "userColumn"], e.target.value)}/></Field><Field label="附加条件"><Input value={notify.permission?.where ?? ""} disabled={readonly} onChange={(e) => change(["notify", "permission", "where"], e.target.value)}/></Field></section>}

    {tab === "data" && <section className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-5">
        <div>
          <h2 className="font-semibold">应用数据</h2>
          <p className="text-sm text-muted-foreground">
            {data?.database.exists ? `数据库 ${formatSize(data.database.size)}` : "尚未创建数据库"}
            {data ? ` · ${data.files.count} 个文件 · ${formatSize(data.files.size)}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm"><a href={`${base}/data/export`} download><Download />导出 ZIP</a></Button>
          <Button variant="outline" size="sm" onClick={() => importRef.current?.click()} disabled={busy}><Upload />导入 ZIP</Button>
          <input
            ref={importRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file || !confirmName()) return;
              const form = new FormData();
              form.set("confirmName", name);
              form.set("archive", file);
              await dataAction(() => json(`${base}/data/import`, { method: "POST", body: form }), "应用数据已导入");
              event.target.value = "";
            }}
          />
        </div>
      </div>
      <div>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="备份名称"><Input value={backupName} onChange={(e) => setBackupName(e.target.value)} placeholder="例如：发布前" /></Field>
          <Button size="sm" disabled={busy} onClick={() => dataAction(() => json(`${base}/data/backups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: backupName }) }), "备份已创建")}><Plus />创建备份</Button>
          <Button variant="ghost" size="icon" title="刷新" onClick={() => void loadData()}><RefreshCw /></Button>
        </div>
        <div className="divide-y border-y">
          {data?.backups.length ? data.backups.map((backup) => <div key={backup.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium"><span>{backup.name}</span><span className="text-xs font-normal text-muted-foreground">{backup.format === "zip" ? "完整数据包" : "旧格式，仅数据库"}</span></div>
              <div className="text-xs text-muted-foreground">
                {new Date(backup.createdAt).toLocaleString()} · {formatSize(backup.size)} · {backup.source === "manual" ? "手动" : "自动"}
                {backup.format === "zip" ? ` · ${backup.fileCount} 个文件` : ""}
              </div>
            </div>
            <div className="flex gap-1">
              <Button asChild variant="ghost" size="icon"><a href={`${base}/data/backups/${backup.id}/download`} download title="下载备份"><Download /></a></Button>
              <Button variant="ghost" size="icon" title="恢复备份" disabled={busy} onClick={() => confirmName() && dataAction(() => json(`${base}/data/backups/${backup.id}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmName: name }) }), "备份已恢复")}><RotateCcw /></Button>
              <Button variant="ghost" size="icon" title="删除备份" disabled={busy} onClick={() => window.confirm("确定删除此备份？") && dataAction(() => json(`${base}/data/backups/${backup.id}`, { method: "DELETE" }), "备份已删除")}><Trash2 /></Button>
            </div>
          </div>) : <p className="py-5 text-sm text-muted-foreground">暂无备份</p>}
        </div>
      </div>
    </section>}

    {tab === "manage" && <section className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-6">
        <div>
          <h2 className="font-semibold">运行状态</h2>
          <div className="mt-2 flex items-center gap-2 text-sm">
            {settings.app.lifecycleStatus === "online"
              ? <><CircleCheck className="size-4 text-emerald-600" /><span className="font-medium text-emerald-700">已上线</span></>
              : <><CircleOff className="size-4 text-muted-foreground" /><span className="font-medium text-muted-foreground">已下线</span></>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">下线会屏蔽应用内容、静态资源和应用 API；正式地址仍保留平台导航与下线状态页。</p>
        </div>
        {settings.app.lifecycleStatus === "online"
          ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void changeLifecycle("offline")}><Power />下线应用</Button>
          : <Button size="sm" disabled={busy} onClick={() => void changeLifecycle("online")}><Power />重新上线</Button>}
      </div>

      <div className="border-b pb-6">
        <h2 className="font-semibold">恢复出厂设置</h2>
        <p className="mt-1 text-sm text-muted-foreground">保留应用、版本和访问地址，重建空数据库、删除应用文件并清除平台配置。应用将恢复为上线状态。</p>
        <Button className="mt-3" variant="outline" size="sm" disabled={busy} onClick={factoryReset}><Database />恢复出厂设置</Button>
      </div>

      <div>
        <h2 className="font-semibold text-destructive">永久删除应用</h2>
        <p className="mt-1 text-sm text-muted-foreground">永久删除应用的全部版本、数据库、文件和备份。此操作不可恢复。</p>
        <Button className="mt-3" variant="destructive" size="sm" disabled={busy} onClick={() => void deleteApp()}><Trash2 />永久删除应用</Button>
      </div>
    </section>}
  </div>;
}

function Info({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-sm">{value}</dd></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="min-w-56 space-y-1.5"><Label>{label}</Label>{children}</div>; }
function Check({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) { return <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4"/>{label}</label>; }
function Select({ label, value, disabled, options, onChange }: { label: string; value: string; disabled: boolean; options: string[]; onChange: (value: string) => void }) { return <Field label={label}><select className="h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-50" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select></Field>; }
