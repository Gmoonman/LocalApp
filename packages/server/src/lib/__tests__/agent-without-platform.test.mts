import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import Fastify from "fastify";
import { Context } from "@deepseek-ai/cordis";
import Multiuser from "@localapp/dsh-multiuser";
import fs from "node:fs/promises";
import path from "node:path";
import { createAgentRoutesHost } from "../../routes/agent.js";
import { createLlmRoutesHost } from "../../routes/llm.js";
import { loadConfig } from "../config.js";
import { initMetaDb, closeMetaDb, createUser, createApiKey } from "../meta-sqlite.js";
import { AgentSettingsStore } from "../agent-settings.js";

it("uses real dsh sessions without implicitly loading application platform", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/agent-without-platform");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "agent-"));
  const context = new Context();
  const app = Fastify();
  try {
    await initMetaDb(root);
    createUser("alice", "alice", "unused-test-password-hash");
    const credentials = createApiKey("alice");
    await context.plugin(Multiuser, { capacity: 2 });
    app.decorate("config", await loadConfig({ DATA_DIR: root, LISTEN_PORT: "0" }));
    app.decorateRequest("userId", "alice");
    new AgentSettingsStore(root).write("alice", { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://localhost:1/v1", model: "model", apiKey: "test-secret" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    context.localappMultiuser.registerModelRoutes(app, {
      authenticate: async scope => { scope.addHook("onRequest", async request => { request.headers["x-api-key"] = credentials.key; }); }, llm: createLlmRoutesHost(app, context.localappMultiuser),
      agent: () => createAgentRoutesHost(app, context),
    });
    expect((await app.inject({ url: "/api/agent/sessions" })).statusCode).toBe(200);
    const denied = await app.inject({ url: "/api/agent/sessions?appId=owner/application" });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toContain("not enabled");
    expect(context.get("localappApps")).toBeUndefined();
    expect(context.localappMultiuser.forUser("alice")).toHaveLength(1);
    const store = new AgentSettingsStore(root);
    const saved = store.read("alice");
    const workspace = path.join(root, "agent", createHash("sha256").update(JSON.stringify(["alice", "platform", "own"])).digest("hex"), "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "private.txt"), "Standalone private file marker");
    const modelRequests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body); modelRequests.push(request);
      const completed = request.messages.some((message: any) => message.role === "tool");
      const delta = completed ? { content: "Standalone completed" } : { tool_calls: [{ index: 0, id: "standalone-read", function: { name: "read", arguments: JSON.stringify({ file_path: "private.txt" }) } }] };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: completed ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }));
    const disabled = await app.inject({ method: "POST", url: "/api/agent/run", payload: { sessionId: "standalone-disabled", prompt: "Try reading before enable", systemPrompt: "", tools: [] } });
    expect(disabled.statusCode).toBe(200);
    expect(JSON.stringify(modelRequests)).not.toContain("Standalone private file marker");
    expect(modelRequests[0].tools.map((tool: any) => tool.function.name)).not.toContain("read");
    modelRequests.length = 0;
    const enabled = await app.inject({ method: "PUT", url: "/api/agent/app-settings", payload: { appId: "platform", enabledCapabilities: ["files"], enabledSkills: [], disabledTools: [] } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().data.enabledCapabilities).toEqual(["files"]);
    const run = await app.inject({ method: "POST", url: "/api/agent/run", payload: { sessionId: "standalone-files", prompt: "Read private file", systemPrompt: "", tools: [] } });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.body).toContain("Standalone completed");
    expect(JSON.stringify(modelRequests)).toContain("Standalone private file marker");
    expect(context.get("localappApps")).toBeUndefined();
  } finally { vi.unstubAllGlobals(); await app.close(); await context.fiber.dispose(); closeMetaDb(); await fs.rm(root, { recursive: true, force: true }); }
});
