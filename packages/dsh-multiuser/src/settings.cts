export { createSqliteSettingsPersistence } from "./sqlite-settings.cjs";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export interface SettingsPersistence {
  users(): string[];
  read(userId: string): string | undefined;
  write(userId: string, value: string): void;
}

export const AGENT_CAPABILITIES = ["files", "terminal", "mcp", "skills", "subagents", "jobs", "web", "workflow", "schedule"] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];
export interface AgentProvider {
  id: string;
  name: string;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  baseUrl: string;
  model: string;
  apiKey: string;
}
export interface AgentMcpServer {
  serverName: string;
  transport?: "streamable-http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface AgentAppPreferences {
  skills: string[];
  disabledTools: string[];
  tools: Array<{ name: string; description: string }>;
}
export interface AgentSettings {
  providers: AgentProvider[];
  defaultProviderId: string;
  grants: Record<string, AgentCapability[]>;
  mcpServers: AgentMcpServer[];
  applications: Record<string, AgentAppPreferences>;
}
const empty = (): AgentSettings => ({ providers: [], defaultProviderId: "", grants: {}, mcpServers: [], applications: {} });
const validPreferenceId = (id: string) => id === "platform" || /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(id) || /^development:[a-zA-Z0-9-]{1,100}$/.test(id);

/** Server-owned encrypted storage; browser reads never return provider or MCP credentials. */
export class AgentSettingsStore {
  private readonly key: Buffer;
  constructor(dataDir: string, private readonly persistence: SettingsPersistence, private readonly skillIds: readonly string[]) {
    fs.mkdirSync(dataDir, { recursive: true });
    const keyPath = path.join(dataDir, ".agent-settings-key");
    try { fs.writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.key = fs.readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error("Invalid Agent settings encryption key");
  }
  users(): string[] { return this.persistence.users(); }
  read(userId: string): AgentSettings {
    const encoded = this.persistence.read(userId);
    if (encoded === undefined) return empty();
    const [iv, tag, ciphertext] = encoded.split(".").map((part) => Buffer.from(part, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(tag);
    return { ...empty(), ...JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) };
  }
  publicSettings(userId: string) {
    const settings = this.read(userId);
    return { ...settings, providers: settings.providers.map(({ apiKey, ...provider }) => ({ ...provider, hasApiKey: !!apiKey })), mcpServers: settings.mcpServers.map(({ headers, env, args, url, ...server }) => ({ ...server, ...(url ? { url: new URL(url).origin + new URL(url).pathname, hasUrlQuery: !!new URL(url).search } : {}), hasArgs: !!args?.length, hasHeaders: Object.keys(headers ?? {}).length > 0, hasEnv: Object.keys(env ?? {}).length > 0 })) };
  }
  write(userId: string, input: unknown) {
    const settings = input as AgentSettings;
    if (!settings || !Array.isArray(settings.providers) || settings.providers.length > 20 || typeof settings.defaultProviderId !== "string" || settings.grants !== undefined && (!settings.grants || typeof settings.grants !== "object" || Array.isArray(settings.grants)) || !Array.isArray(settings.mcpServers) || settings.mcpServers.length > 20) throw new Error("Invalid Agent settings");
    const previous = this.read(userId);
    const ids = new Set<string>();
    const providers = settings.providers.map((provider) => {
      if (!provider || typeof provider.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(provider.id) || ids.has(provider.id) || typeof provider.name !== "string" || !provider.name.trim() || provider.name.length > 100 || !["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(provider.protocol) || typeof provider.model !== "string" || !provider.model.trim() || provider.model.length > 200 || typeof provider.baseUrl !== "string") throw new Error("Invalid model provider");
      ids.add(provider.id);
      const url = new URL(provider.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid provider URL");
      const apiKey = provider.apiKey === undefined ? previous.providers.find((p) => p.id === provider.id)?.apiKey ?? "" : provider.apiKey;
      if (typeof apiKey !== "string" || apiKey.length > 8192) throw new Error("Invalid API key");
      return { id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: url.toString().replace(/\/$/, ""), model: provider.model, apiKey };
    });
    if (settings.defaultProviderId && !ids.has(settings.defaultProviderId)) throw new Error("Default provider does not exist");
    const grants: Record<string, AgentCapability[]> = {};
    for (const [appId, capabilities] of Object.entries(settings.grants ?? previous.grants)) {
      if (!validPreferenceId(appId) || !Array.isArray(capabilities) || capabilities.some((c) => !AGENT_CAPABILITIES.includes(c))) throw new Error("Invalid application capability grant");
      grants[appId] = [...new Set(capabilities)];
    }
    const mcpServers = settings.mcpServers.map((server): AgentMcpServer => {
      if (!server || !/^[a-zA-Z0-9_-]{1,32}$/.test(server.serverName)) throw new Error("Invalid MCP server");
      const old = previous.mcpServers.find((s) => s.serverName === server.serverName);
      const strings = (value: unknown): value is Record<string, string> => !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([k, v]) => typeof v === "string" && !/[\r\n]/.test(k + v));
      if (server.transport === "stdio") {
        if (typeof server.command !== "string" || !server.command.trim() || /[\r\n]/.test(server.command) || server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string"))) throw new Error("Invalid MCP command");
        const env = server.env === undefined ? old?.env ?? {} : server.env;
        if (!strings(env)) throw new Error("Invalid MCP environment");
        return { serverName: server.serverName, transport: "stdio", command: server.command, args: server.args ?? old?.args ?? [], env };
      }
      if (server.transport && server.transport !== "streamable-http") throw new Error("Invalid MCP transport");
      if (typeof server.url !== "string") throw new Error("Invalid MCP URL");
      const url = new URL(old?.url && server.url === new URL(old.url).origin + new URL(old.url).pathname ? old.url : server.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid MCP URL");
      const headers = server.headers === undefined ? old?.headers ?? {} : server.headers;
      if (!strings(headers)) throw new Error("Invalid MCP headers");
      return { serverName: server.serverName, transport: "streamable-http", url: url.toString(), headers };
    });
    if (new Set(mcpServers.map((s) => s.serverName)).size !== mcpServers.length) throw new Error("Duplicate MCP server");
    const applications = settings.applications ?? previous.applications;
    if (!applications || typeof applications !== "object" || Array.isArray(applications) || Object.keys(applications).length > 1000) throw new Error("Invalid application Agent preferences");
    for (const [id, preferences] of Object.entries(applications)) {
      if (!validPreferenceId(id) || !preferences || !Array.isArray(preferences.skills) || preferences.skills.length > 20 || preferences.skills.some((name) => !this.skillIds.includes(name)) || !Array.isArray(preferences.disabledTools) || preferences.disabledTools.length > 500 || preferences.disabledTools.some((name) => typeof name !== "string" || !name || name.length > 200) || !Array.isArray(preferences.tools) || preferences.tools.length > 100 || preferences.tools.some((tool) => !tool || typeof tool.name !== "string" || !tool.name || tool.name.length > 200 || typeof tool.description !== "string" || tool.description.length > 10000)) throw new Error("Invalid application Agent preferences");
    }
    const value: AgentSettings = { providers, defaultProviderId: settings.defaultProviderId, grants, mcpServers, applications };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(userId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    this.persistence.write(userId, [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString("base64")).join("."));
    return this.publicSettings(userId);
  }
}
