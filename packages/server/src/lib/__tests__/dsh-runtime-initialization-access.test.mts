import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { Context } from "@deepseek-ai/cordis";
import Multiuser from "@localapp/dsh-multiuser";
import { AgentSettingsStore } from "@localapp/dsh-multiuser/settings";
import { registerAgentRoutes } from "@localapp/dsh-multiuser/agent-routes";
import { expect, it, vi } from "vitest";

it.each(["application", "capabilities", "python", "provider", "mcp", "tools", "credentials-run", "credentials-context", "credentials-native"] as const)("rejects a runtime when %s access changes during initialization", async reason => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/runtime-initialization-access");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const values = new Map<string, string>();
  const settings = new AgentSettingsStore(root, { users: () => [...values.keys()], read: id => values.get(id), write: (id, value) => { values.set(id, value); } }, []);
  settings.write("alice", { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://localhost:1/v1", model: "own", apiKey: "own" }], defaultProviderId: "own", grants: { platform: ["files"] }, mcpServers: [] });
  let available = true, filesAllowed = true, closed = 0;
  let authenticated = true, dispatched = 0;
  let entered!: () => void, resume!: () => void;
  const initializing = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { resume = resolve; });
  const context = new Context(), app = Fastify();
  let request: Promise<{ statusCode: number }> | undefined;
  try {
    await context.plugin(Multiuser);
    await registerAgentRoutes(app, {
      dataDir: root, settings, runtimes: context.localappMultiuser,
      userId: () => "alice", isAuthenticated: () => authenticated,
      resolveApp: () => { if (!available) throw new Error("Application unavailable"); return { id: "platform", capabilities: filesAllowed ? ["files"] : [] }; },
      environment: async () => ({ checks: [] }) as any,
      clientAssets: async () => { throw new Error("Unused"); },
      createHarness: () => ({ initialize: async () => { entered(); await pending; }, close: async () => { closed++; }, isRunning: () => false, listSessions: async () => [], run: async () => { dispatched++; }, bindNativeApplication: async () => { dispatched++; } }) as any,
    });
    request = reason.startsWith("credentials-") ? app.inject({ method: "POST", url: reason === "credentials-run" ? "/api/agent/run" : reason === "credentials-native" ? "/api/agent/native/api/session/list" : "/api/agent/native-context", payload: { sessionId: "credential-session", prompt: "Do work", systemPrompt: "", tools: [] } }) : app.inject("/api/agent/sessions");
    await initializing;
    if (reason === "application") available = false;
    else if (reason.startsWith("credentials-")) authenticated = false;
    else if (reason === "python") await fs.writeFile(path.join(root, "python-environment.json"), JSON.stringify({ executable: path.join(root, "python", "bin", "python"), directory: path.join(root, "python"), baseDirectory: path.join(root, "base-python"), revision: "new-environment", managed: true, version: "3.12.0" }));
    else if (reason === "provider") settings.write("alice", { ...settings.read("alice"), providers: [{ ...settings.read("alice").providers[0], apiKey: "replacement-key" }] });
    else if (reason === "mcp") settings.write("alice", { ...settings.read("alice"), mcpServers: [{ serverName: "changed", transport: "stdio", command: "node" }] });
    else if (reason === "tools") settings.write("alice", { ...settings.read("alice"), applications: { platform: { skills: [], tools: [], disabledTools: ["read"] } } });
    else filesAllowed = false;
    resume();
    expect((await request).statusCode).toBe(400);
    expect(closed).toBe(1);
    expect(dispatched).toBe(0);
    expect(context.localappMultiuser.forUser("alice")).toHaveLength(0);
  } finally { resume(); await request; await app.close(); await context.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
