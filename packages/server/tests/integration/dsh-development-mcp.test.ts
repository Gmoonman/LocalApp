import { processExists } from "../../src/lib/__tests__/helpers/processExists.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import { findUserByName, getDb, flushMetaDb, closeMetaDb } from "../../src/lib/meta-sqlite.js";
import { AgentSettingsStore } from "../../src/lib/agent-settings.js";

it.each(["account", "configuration", "capabilities"] as const)("calls a real project MCP service and stops it after %s removal", async reason => {
  const parent = path.resolve(__dirname, "../../../../tmp/developer-mcp");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  let called = false;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    const done = request.messages.some((m: any) => m.role === "tool");
    if (done) {
      expect(JSON.stringify(request.messages)).toContain("project-mcp-marker");
      expect(JSON.stringify(request.messages)).toContain("outside-denied");
      expect(JSON.stringify(request.messages)).not.toContain("outside-private-marker");
      called = true;
    }
    const delta = done ? { content: "MCP finished" } : { tool_calls: [{ index: 0, id: "mcp-call", function: { name: "mcp__project__inspect", arguments: "{}" } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  const tokens = new SetupTokenStore();
  const serverOptions = { setupTokens: tokens, pluginCombination: "full" as const, env: { DATA_DIR: root, BOOTSTRAP_API_KEY: "mcp-key", JWT_SECRET: "mcp-secret" } };
  let app = await buildServer(serverOptions);
  try {
    expect((await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: tokens.issue().token, username: "mcp-owner", password: "mcp-owner-password" } })).statusCode).toBe(201);
    const owner = findUserByName("mcp-owner")!;
    const created = await app.inject({ method: "POST", url: "/api/development/projects", headers: { "X-API-Key": "mcp-key" }, payload: { name: "mcp-app" } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().data.id;
    const workspace = path.join(root, "development", "projects", id, "workspace");
    const outside = path.join(root, "outside-private.txt");
    await fs.writeFile(outside, "outside-private-marker");
    const script = `const fs = require("node:fs");
fs.writeFileSync("mcp.pid", String(process.pid));
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
 const message = JSON.parse(line); if (message.id === undefined) return;
 let result = {};
 if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "project", version: "1.0.0" } };
 if (message.method === "tools/list") result = { tools: [{ name: "inspect", description: "Inspect project", inputSchema: { type: "object", properties: {} } }] };
 if (message.method === "tools/call") {
  let outside; try { outside = fs.readFileSync(${JSON.stringify(outside)}, "utf8"); } catch { outside = "outside-denied"; }
  result = { content: [{ type: "text", text: "project-mcp-marker " + process.cwd() + " " + outside }] };
 }
 process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});`;
    await fs.writeFile(path.join(workspace, "project-mcp.cjs"), script);
    new AgentSettingsStore(root).write(owner.id, { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://model.test/v1", model: "own", apiKey: "own" }], defaultProviderId: "own", grants: {}, mcpServers: [{ serverName: "project", transport: "stdio", command: process.execPath, args: ["project-mcp.cjs"] }] });
    const run = await app.inject({ method: "POST", url: `/api/development/projects/${id}/agent/run`, headers: { "X-API-Key": "mcp-key" }, payload: { sessionId: "mcp-project-session", prompt: "Inspect project through MCP" } });
    expect(run.statusCode, run.body).toBe(200);
    expect(called, run.body).toBe(true);
    const pid = Number(await fs.readFile(path.join(workspace, "mcp.pid"), "utf8"));
    expect(processExists(pid)).toBe(true);
    if (reason === "account") { getDb().run("DELETE FROM users WHERE id = ?", [owner.id]); flushMetaDb(); }
    else if (reason === "configuration") {
      const settings = new AgentSettingsStore(root);
      settings.write(owner.id, { ...settings.read(owner.id), mcpServers: [] });
    } else {
      const changed = await app.inject({ method: "PUT", url: `/api/development/projects/${id}/agent/settings`, headers: { "X-API-Key": "mcp-key" }, payload: { enabledCapabilities: [], disabledTools: ["write"] } });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().data).toMatchObject({ enabledCapabilities: [], disabledTools: ["write"] });
      const saved = await app.inject({ url: `/api/development/projects/${id}/agent/settings`, headers: { "X-API-Key": "mcp-key" } });
      expect(saved.json().data).toMatchObject({ enabledCapabilities: [], disabledTools: ["write"] });
      expect(new AgentSettingsStore(root).read(owner.id).grants["development:" + id]).toEqual([]);
    }
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }, { timeout: 5000 }).toBe(true);
    if (reason === "capabilities") {
      await app.close(); closeMetaDb();
      app = await buildServer(serverOptions);
      const restored = await app.inject({ url: `/api/development/projects/${id}/agent/settings`, headers: { "X-API-Key": "mcp-key" } });
      expect(restored.statusCode, restored.body).toBe(200);
      expect(restored.json().data).toMatchObject({ enabledCapabilities: [], disabledTools: ["write"] });
    }
  } finally { await app.close(); closeMetaDb(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 20000);
