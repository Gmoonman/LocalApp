"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { requestModelSettings } from "@localapp/dsh-multiuser/model-settings-client";
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

export function createAgentModelSettings(components: ModelSettingsComponents) {
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
  const updateProvider = (id: string, patch: Partial<Provider>) => setSettings((current) => current && ({ ...current, providers: current.providers.map((p) => p.id === id ? { ...p, ...patch } : p) }));
  const save = async () => {
    setSaving(true); setError("");
    try {
      const payload = { providers: settings?.providers, defaultProviderId: settings?.defaultProviderId, mcpServers: settings?.mcpServers.map((server, index) => server.transport === "stdio" ? { ...server, args: !mcpArguments[index] ? server.hasArgs ? undefined : server.args ?? [] : JSON.parse(mcpArguments[index]), env: !mcpEnvironment[index] ? server.env : JSON.parse(mcpEnvironment[index]) } : server) };
      setSettings(await requestModelSettings(payload)); setMcpArguments({}); setMcpEnvironment({}); notifySuccess("模型与 Agent 设置已保存");
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };
  if (!settings) return <p role={error ? "alert" : "status"}>{error || "加载中..."}</p>;
  return <div className="max-w-3xl space-y-6">
    <h1 className="text-2xl font-bold">模型与 Agent</h1>
    <p className="text-sm text-muted-foreground">应用使用你选择的供应商和模型。凭据保存在此 Server，其他用户和应用不会收到你的 API Key。</p>
    <div className="space-y-4"><h2 className="text-lg font-semibold">模型供应商</h2>
      {settings.providers.map((provider, index) => <fieldset key={provider.id} className="space-y-3 rounded-xl border p-4"><legend className="px-1">供应商 {index + 1}</legend>
        <Label htmlFor={`provider-name-${provider.id}`}>名称</Label><Input id={`provider-name-${provider.id}`} value={provider.name} onChange={(e) => updateProvider(provider.id, { name: e.target.value })} />
        <Label>接口协议</Label><ChoiceSelect label={`供应商接口协议 ${index + 1}`} value={provider.protocol} onValueChange={protocol => updateProvider(provider.id, {protocol})} options={[
          {value: "openai-completions", label: "OpenAI Chat Completions / DeepSeek / 兼容接口"},
          {value: "openai-responses", label: "OpenAI Responses"},
          {value: "anthropic-messages", label: "Anthropic Messages"},
          {value: "google-generative-ai", label: "Google Gemini"},
        ]} />
        <Label htmlFor={`provider-url-${provider.id}`}>API 地址</Label><Input id={`provider-url-${provider.id}`} type="url" placeholder="https://api.deepseek.com/v1" value={provider.baseUrl} onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })} />
        <Label htmlFor={`provider-model-${provider.id}`}>模型名称</Label><Input id={`provider-model-${provider.id}`} value={provider.model} onChange={(e) => updateProvider(provider.id, { model: e.target.value })} />
        <Label htmlFor={`provider-key-${provider.id}`}>API Key</Label><Input id={`provider-key-${provider.id}`} type="password" autoComplete="new-password" placeholder={provider.hasApiKey ? "已保存，留空保留" : "填写 API Key"} value={provider.apiKey ?? ""} onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value || undefined })} />
        <div className="flex items-center justify-between"><Button variant="outline" aria-pressed={settings.defaultProviderId === provider.id} onClick={() => setSettings({ ...settings, defaultProviderId: provider.id })}>{settings.defaultProviderId === provider.id ? "默认供应商" : "设为默认"}</Button>
          <Button variant="ghost" aria-label={`删除供应商 ${index + 1}`} onClick={() => setSettings({ ...settings, providers: settings.providers.filter((p) => p.id !== provider.id), defaultProviderId: settings.defaultProviderId === provider.id ? "" : settings.defaultProviderId })}><Trash2 className="h-4 w-4" /></Button></div>
      </fieldset>)}
      <Button variant="outline" onClick={() => { const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""); setSettings({ ...settings, defaultProviderId: settings.defaultProviderId || id, providers: [...settings.providers, { id, name: "", protocol: "openai-completions", baseUrl: "https://api.deepseek.com/v1", model: "", apiKey: "" }] }); }}><Plus className="mr-2 h-4 w-4" />添加供应商</Button>
    </div>
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
    {error && <p role="alert" className="text-destructive">{error}</p>}<Button onClick={save} disabled={saving}>{saving ? "保存中..." : "保存模型与 Agent 设置"}</Button>
  </div>;
}

}
