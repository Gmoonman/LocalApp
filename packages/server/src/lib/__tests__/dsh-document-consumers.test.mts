import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { Context } from "@deepseek-ai/cordis";
import DocumentTools from "@localapp/dsh-document-tools";
import Multiuser from "@localapp/dsh-multiuser";
import { AgentSettingsStore } from "@localapp/dsh-agent-settings/settings";
import { registerAgentRoutes } from "@localapp/dsh-agent-runtime/agent-routes";
import { expect, it } from "vitest";

it.each([false, true])("stops document consumers including pending initialization=%s while preserving other workspaces", async pendingInitialization => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/document-consumers");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const values = new Map<string, string>();
  const settings = new AgentSettingsStore(root, { users: () => [...values.keys()], read: id => values.get(id), write: (id, value) => { values.set(id, value); } }, ["pdf"]);
  settings.write("alice", { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://localhost:1/v1", model: "own", apiKey: "own" }], defaultProviderId: "own", grants: { platform: ["skills"] }, applications: { platform: { skills: ["pdf"], disabledTools: [], tools: [] } }, mcpServers: [] });
  const context = new Context(), app = Fastify();
  const instances: Array<{ skills: string[]; closed: boolean }> = [];
  let entered!: () => void, resume!: () => void;
  const initializing = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { resume = resolve; });
  let request: Promise<{ statusCode: number }> | undefined;
  try {
    const documents = await context.plugin(DocumentTools);
    await context.plugin(Multiuser);
    await registerAgentRoutes(app, {
      dataDir: root, settings, runtimes: context.localappMultiuser,
      documents: () => context.get("localappDocuments"),
      userId: () => "alice", isAuthenticated: () => true,
      resolveApp: (_user, appId) => ({ id: appId ?? "platform", capabilities: ["skills"] }),
      environment: async () => ({ checks: ["runner", "python", "pypdf", "pdfplumber", "reportlab"].map(id => ({ id, status: "ready" })) }) as any,
      clientAssets: async () => { throw new Error("Unused"); },
      createHarness: config => {
        const instance = { skills: config.skills ?? [], closed: false }; instances.push(instance);
        return { initialize: async () => { if (instance.skills.length) { entered(); if (pendingInitialization) await pending; } }, close: async () => { instance.closed = true; }, isRunning: () => false, listSessions: async () => [], toolCatalog: () => [] } as any;
      },
    });
    expect((await app.inject("/api/agent/sessions?appId=alice/other")).statusCode).toBe(200);
    request = app.inject("/api/agent/sessions");
    await initializing;
    if (!pendingInitialization) expect((await request).statusCode).toBe(200);
    await documents.dispose(); resume();
    expect((await request).statusCode).toBe(pendingInitialization ? 400 : 200);
    expect(instances.find(instance => instance.skills.includes("pdf"))?.closed).toBe(true);
    expect(instances[0].closed).toBe(false);
    expect(context.localappMultiuser.forUser("alice")).toHaveLength(1);
    const preferences = await app.inject("/api/agent/app-settings?appId=platform");
    expect(preferences.statusCode).toBe(200);
    expect(preferences.json().data.enabledSkills).toEqual([]);
    expect(preferences.json().data.skills.every((skill: any) => !skill.available)).toBe(true);
    await context.plugin(DocumentTools);
    expect((await app.inject("/api/agent/app-settings?appId=platform")).json().data.enabledSkills).toEqual(["pdf"]);
    expect(instances.at(-1)?.skills).toEqual(["pdf"]);
    expect(instances[0].closed).toBe(false);
  } finally { resume(); await request; await app.close(); await context.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
