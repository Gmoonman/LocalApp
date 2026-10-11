"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {Tabs, TabsList, TabsTrigger, TabsContent} from "@/components/ui/tabs";

import { SystemPluginSettings } from "./plugin-settings";
import { SystemDevelopmentEnvironment } from "./development-environment";
import { SystemAgentEnvironment } from "./agent-environment";

type Settings = { listenHost: string; listenPort: number; publicUrl: string; workspaceDir: string; allowInsecureLan: boolean };

export function SystemPage() {
  const [tab,setTab]=useState("network");
  const [developmentEnabled, setDevelopmentEnabled] = useState(false);
  useEffect(() => {
    let disposed = false;
    fetch("/api/system/plugins", { credentials: "include" }).then(response => {
      if (!response.ok) throw new Error("Plugin status unavailable");
      return response.json();
    }).then(body => {
      if (disposed) return;
      const enabled = body.success === true && body.data?.development === true;
      setDevelopmentEnabled(enabled);
      if (!enabled) setTab(current => current === "development" ? "plugins" : current);
    }).catch(() => {
      if (disposed) return;
      setDevelopmentEnabled(false);
      setTab(current => current === "development" ? "plugins" : current);
    });
    return () => { disposed = true; };
  }, []);
  useEffect(() => { if (new URLSearchParams(window.location.search).get("tab") === "environment") setTab("environment"); else if(new URLSearchParams(window.location.search).get("tab") === "development") setTab("development"); else if(new URLSearchParams(window.location.search).get("tab") === "plugins") setTab("plugins"); }, []);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/system/settings", { credentials: "include" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success) throw new Error(body.error || `HTTP ${response.status}`);
      setSettings(body.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载系统设置失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!settings) return; setSaving(true); setError("");
    try {
      const response = await fetch("/api/system/settings/network", { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ listenHost: settings.listenHost, listenPort: Number(settings.listenPort), allowInsecureLan: settings.allowInsecureLan }) });
      const body = await response.json().catch(() => ({})); if (!response.ok || !body.success) throw new Error(body.error || `HTTP ${response.status}`);
      setMessage("已请求重启以应用网络设置");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存系统设置失败"); }
    finally { setSaving(false); }
  };
  if (!settings) return <div className="space-y-3"><h1 className="text-2xl font-bold">系统设置</h1>{loading ? <p className="text-muted-foreground">加载中...</p> : <><p role="alert" className="text-sm text-destructive">{error || "加载系统设置失败"}</p><Button variant="outline" onClick={() => void load()}>重试</Button></>}</div>;
  return <div className="max-w-2xl space-y-6"><header><h1 className="text-2xl font-bold">系统设置</h1><p className="mt-1 text-sm text-muted-foreground">网络变更会由 Server 安全地暂存并请求受监督的重启。</p></header><Tabs value={tab} onValueChange={setTab}><TabsList aria-label="系统设置"><TabsTrigger value="network">网络</TabsTrigger><TabsTrigger value="plugins">插件组合</TabsTrigger><TabsTrigger value="environment">Python 环境</TabsTrigger>{developmentEnabled && <TabsTrigger value="development">应用开发环境</TabsTrigger>}</TabsList><TabsContent value="plugins"><SystemPluginSettings /></TabsContent>{developmentEnabled && <TabsContent value="development"><SystemDevelopmentEnvironment /></TabsContent>}<TabsContent value="environment"><SystemAgentEnvironment/></TabsContent><TabsContent value="network"><form onSubmit={save} className="space-y-4 rounded-xl border bg-card p-5"><h2 className="flex items-center gap-2 font-semibold"><Network className="size-4" />网络</h2><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="listen-host">监听主机</Label><Input id="listen-host" value={settings.listenHost} onChange={(event) => setSettings({ ...settings, listenHost: event.target.value })} /></div><div className="space-y-2"><Label htmlFor="listen-port">监听端口</Label><Input id="listen-port" type="number" value={settings.listenPort} onChange={(event) => setSettings({ ...settings, listenPort: Number(event.target.value) })} /></div></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.allowInsecureLan} onChange={(event) => setSettings({ ...settings, allowInsecureLan: event.target.checked })} />允许不安全的局域网访问</label><p className="text-xs text-muted-foreground">工作区目录：{settings.workspaceDir}</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p className="text-sm text-emerald-700">{message}</p>}<Button type="submit" disabled={saving}>{saving ? "保存中..." : "保存并重启"}</Button></form></TabsContent></Tabs></div>;
}
