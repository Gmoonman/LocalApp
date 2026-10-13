"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { requestModelSettings } from "@localapp/dsh-agent-settings/model-settings-client";
export interface ModelSettingsComponents {
  Button: React.JSXElementConstructor<any>;
  Input: React.JSXElementConstructor<React.InputHTMLAttributes<HTMLInputElement>>;
  Label: React.JSXElementConstructor<React.LabelHTMLAttributes<HTMLLabelElement>>;
  ChoiceSelect: React.JSXElementConstructor<{label: string; value: string; options: {value: string; label: string}[]; onValueChange: (value: string) => void; className?: string}>;
  AgentSettings: React.JSXElementConstructor<{appId: string}>;
  notifySuccess: (message: string) => void;
}
interface Provider { id: string; name: string; protocol: string; baseUrl: string; model: string; apiKey?: string; hasApiKey?: boolean }
interface McpServer { serverName: string; transport?: "streamable-http" | "stdio"; url?: string; headers?: Record<string, string>; hasHeaders?: boolean; command?: string; args?: string[]; env?: Record<string, string>; hasEnv?: boolean; hasArgs?: boolean; hasUrlQuery?: boolean }
interface Settings { providers: Provider[]; defaultProviderId: string; grants: Record<string, string[]>; mcpServers: McpServer[] }

export function createAgentPreferences(components: ModelSettingsComponents) {
const {Button, Input, Label, ChoiceSelect, AgentSettings, notifySuccess} = components;
return function AgentModelSettings({showCapabilities = true}: {showCapabilities?: boolean} = {}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [standalone, setStandalone] = useState(false);
  useEffect(() => { if (!showCapabilities) return; fetch("/api/system/plugins").then(r => r.json()).then(body => setStandalone(body.data?.applications === false)).catch(() => {}); }, [showCapabilities]);
  const [saving, setSaving] = useState(false);
  const [appId, setAppId] = useState("");
  const [error, setError] = useState("");
  const [mcpArguments, setMcpArguments] = useState<Record<number, string>>({});
  const [mcpEnvironment, setMcpEnvironment] = useState<Record<number, string>>({});
  useEffect(() => { requestModelSettings().then(setSettings).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    const changed=(event:MessageEvent)=>{if(event.origin!==window.location.origin||event.data?.type!=="localapp-model-settings-updated")return;const frame=document.querySelector<HTMLIFrameElement>('iframe[src="/api/model-settings/native/"]');if(frame?.contentWindow!==event.source)return;requestModelSettings().then(setSettings).catch(e=>setError(e.message));};
    window.addEventListener("message",changed);return()=>window.removeEventListener("message",changed);
  },[]);
  const save = async () => {
    setSaving(true); setError("");
    try {
      const latest:Settings=await requestModelSettings();
      const payload = { providers: latest.providers, defaultProviderId: latest.providers.some(p=>p.id===settings?.defaultProviderId)?settings?.defaultProviderId:latest.defaultProviderId, mcpServers: settings?.mcpServers.map((server, index) => server.transport === "stdio" ? { ...server, args: !mcpArguments[index] ? server.hasArgs ? undefined : server.args ?? [] : JSON.parse(mcpArguments[index]), env: !mcpEnvironment[index] ? server.env : JSON.parse(mcpEnvironment[index]) } : server) };
      setSettings(await requestModelSettings(payload)); setMcpArguments({}); setMcpEnvironment({}); notifySuccess("Agent 设置已保存");
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };
  if (!settings) return <p role={error ? "alert" : "status"}>{error || "加载中..."}</p>;
  return <div className="w-full space-y-6">
    <h2 className="text-lg font-semibold">Agent 与 MCP 设置</h2>
    <p className="text-sm text-muted-foreground">应用使用你选择的供应商和模型。凭据保存在此 Server，其他用户和应用不会收到你的 API Key。</p>
    {settings.providers.length>0 && <ChoiceSelect label="默认供应商" value={settings.defaultProviderId} options={settings.providers.map(p=>({value:p.id,label:p.name+" · "+p.model}))} onValueChange={id=>setSettings({...settings,defaultProviderId:id})} />}
    {showCapabilities && standalone && <section className="space-y-3"><h2 className="text-lg font-semibold">工作区 Agent 设置</h2><AgentSettings appId="platform" /><Button disabled={!settings.defaultProviderId} onClick={() => { const scope = btoa(JSON.stringify({ appId: "platform", providerId: settings.defaultProviderId })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); window.location.href = `/api/agent/native/${scope}/`; }}>打开工作区对话</Button></section>}
    {showCapabilities && !standalone && <section className="space-y-3"><h2 className="text-lg font-semibold">应用 Agent 设置</h2>
      <p className="text-sm text-muted-foreground">Skills、能力和工具在各应用的设置页选择，仅影响当前用户。</p>
      <div className="flex gap-2"><Input aria-label="应用地址" placeholder="用户名/应用名" value={appId} onChange={(event) => setAppId(event.target.value)} /><Button variant="outline" onClick={() => { if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(appId)) { setError("请填写 用户名/应用名"); return; } window.location.href = `/my/agent?${new URLSearchParams({ appId })}`; }}>打开应用设置</Button></div>
      {Object.keys(settings.grants).map((id) => <a className="block underline" key={id} href={`/my/agent?${new URLSearchParams({ appId: id })}`}>{id}</a>)}
    </section>}
    <section className="space-y-3"><h2 className="text-lg font-semibold">MCP 服务</h2>
      {settings.mcpServers.map((server, index) => <div key={index} className="space-y-2 rounded border p-3">
        <Input aria-label={`MCP 名称 ${index + 1}`} placeholder="名称" value={server.serverName} onChange={(e) => setSettings({ ...settings, mcpServers: settings.mcpServers.map((s, i) => i === index ? { ...s, serverName: e.target.value } : s) })} />
        <ChoiceSelect label={`MCP 连接方式 ${index + 1}`} value={server.transport ?? "streamable-http"} onValueChange={transport => setSettings({ ...settings, mcpServers: settings.mcpServers.map((s, i) => i === index ? { ...s, transport: transport as McpServer["transport"], args: s.args } : s) })} options={[{value: "streamable-http", label: "Streamable HTTP"}, {value: "stdio", label: "本机 stdio（在应用工作区运行）"}]} />
        {server.transport === "stdio" ? <>
          <Input aria-label={`MCP 命令 ${index + 1}`} placeholder="命令，例如 npx" value={server.command ?? ""} onChange={(e) => setSettings({ ...settings, mcpServers: settings.mcpServers.map((s, i) => i === index ? { ...s, command: e.target.value } : s) })} />
          <Input aria-label={`MCP 参数 ${index + 1}`} placeholder={server.hasArgs ? "参数已保存，留空保留（JSON 数组）" : 'JSON 数组，例如 ["-y", "服务包名"]'} value={mcpArguments[index] ?? (server.hasArgs ? "" : JSON.stringify(server.args ?? []))} onChange={(e) => setMcpArguments({ ...mcpArguments, [index]: e.target.value })} />
          <Input aria-label={`MCP 环境变量 ${index + 1}`} type="password" autoComplete="new-password" placeholder={server.hasEnv ? "已保存，留空保留（JSON 对象）" : "环境变量 JSON 对象（可选）"} value={mcpEnvironment[index] ?? ""} onChange={(e) => setMcpEnvironment({ ...mcpEnvironment, [index]: e.target.value })} />
        </> : <>
        <Input aria-label={`MCP URL ${index + 1}`} placeholder="Streamable HTTP URL" value={server.url ?? ""} onChange={(e) => setSettings({ ...settings, mcpServers: settings.mcpServers.map((s, i) => i === index ? { ...s, url: e.target.value } : s) })} />
        <Input aria-label={`MCP Token ${index + 1}`} type="password" autoComplete="new-password" placeholder={server.hasHeaders ? "凭据已保存，留空保留" : "Bearer Token（可选）"} onChange={(e) => setSettings({ ...settings, mcpServers: settings.mcpServers.map((s, i) => i === index ? { ...s, headers: e.target.value ? { Authorization: `Bearer ${e.target.value}` } : undefined } : s) })} />
        </>}
        <Button variant="ghost" aria-label={`删除 MCP ${index + 1}`} onClick={() => { setSettings({ ...settings, mcpServers: settings.mcpServers.filter((_, i) => i !== index) }); const reindex = (values: Record<number, string>) => Object.fromEntries(Object.entries(values).filter(([key]) => Number(key) !== index).map(([key, value]) => [Number(key) > index ? Number(key) - 1 : Number(key), value])); setMcpArguments(reindex(mcpArguments)); setMcpEnvironment(reindex(mcpEnvironment)); }}><Trash2 className="h-4 w-4" /></Button>
      </div>)}
      <Button variant="outline" onClick={() => setSettings({ ...settings, mcpServers: [...settings.mcpServers, { serverName: "", url: "" }] })}><Plus className="mr-2 h-4 w-4" />添加 MCP 服务</Button>
    </section>
    {error && <p role="alert" className="text-destructive">{error}</p>}<Button onClick={save} disabled={saving}>{saving ? "保存中..." : "保存 Agent 设置"}</Button>
  </div>;
}

}

/** Compatibility export; provider editing is exclusively handled by dsh. */
export const createAgentModelSettings=createAgentPreferences;
