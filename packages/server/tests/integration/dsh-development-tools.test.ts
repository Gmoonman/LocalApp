import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import { findUserByName, closeMetaDb } from "../../src/lib/meta-sqlite.js";
import { AgentSettingsStore } from "../../src/lib/agent-settings.js";

it("enforces a disabled developer tool even when the model calls it", async () => {
  const parent = path.resolve(__dirname, "../../../../tmp/developer-tools");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const done = request.messages.some((m: any) => m.role === "tool");
    const delta = done ? { content: "Attempt finished" } : { tool_calls: [{ index: 0, id: "disabled-call", function: { name: "write", arguments: JSON.stringify({ file_path: "blocked.txt", content: "must not be written" }) } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  const tokens = new SetupTokenStore();
  const app = await buildServer({ setupTokens: tokens, pluginCombination: "full", env: { DATA_DIR: root, BOOTSTRAP_API_KEY: "tools-key", JWT_SECRET: "tools-secret" } });
  try {
    expect((await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: tokens.issue().token, username: "tools-owner", password: "tools-owner-password" } })).statusCode).toBe(201);
    const owner = findUserByName("tools-owner")!;
    new AgentSettingsStore(root).write(owner.id, { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://model.test/v1", model: "own", apiKey: "own" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    const created = await app.inject({ method: "POST", url: "/api/development/projects", headers: { "X-API-Key": "tools-key" }, payload: { name: "tools-app" } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().data.id;
    const changed = await app.inject({ method: "PUT", url: `/api/development/projects/${id}/agent/settings`, headers: { "X-API-Key": "tools-key" }, payload: { enabledCapabilities: ["files"], disabledTools: ["write"] } });
    expect(changed.statusCode, changed.body).toBe(200);
    const run = await app.inject({ method: "POST", url: `/api/development/projects/${id}/agent/run`, headers: { "X-API-Key": "tools-key" }, payload: { sessionId: "disabled-tool-session", prompt: "Try writing a file" } });
    expect(run.statusCode, run.body).toBe(200);
    expect(requests[0].tools.some((tool: any) => tool.function.name === "write")).toBe(false);
    expect(requests[0].tools.some((tool: any) => tool.function.name === "read")).toBe(true);
    expect(JSON.stringify(requests.at(-1).messages.filter((m: any) => m.role === "tool"))).toMatch(/关闭|disabled|not found|unknown tool/i);
    expect(await fs.stat(path.join(root, "development", "projects", id, "workspace", "blocked.txt")).catch(() => undefined)).toBeUndefined();
    const restored = await app.inject({ method: "PUT", url: `/api/development/projects/${id}/agent/settings`, headers: { "X-API-Key": "tools-key" }, payload: { enabledCapabilities: ["files"], disabledTools: [] } });
    expect(restored.statusCode, restored.body).toBe(200);
    const resumed = await app.inject({ method: "POST", url: `/api/development/projects/${id}/agent/run`, headers: { "X-API-Key": "tools-key" }, payload: { sessionId: "enabled-tool-session", prompt: "Write the file after enabling" } });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(await fs.readFile(path.join(root, "development", "projects", id, "workspace", "blocked.txt"), "utf8")).toBe("must not be written");
    expect(requests.some(request => request.tools?.some((tool: any) => tool.function.name === "write"))).toBe(true);
  } finally { await app.close(); closeMetaDb(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 15000);
