import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import { findUserByName, closeMetaDb } from "../../src/lib/meta-sqlite.js";
import { AgentSettingsStore } from "../../src/lib/agent-settings.js";

it("runs the native developer web tool and respects network and capability boundaries", async () => {
  const parent = path.resolve(__dirname, "../../../../tmp/developer-web");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const requests: any[] = [], pageRequests: any[] = [];
  const pageUrl = "https://93.184.216.34/developer-test";
  const require = createRequire(import.meta.url);
  const providerRequire = createRequire(require.resolve("@deepseek-ai/dsh-web-fetch-http"));
  const { Agent, MockAgent } = providerRequire("undici");
  const transport = new MockAgent();
  transport.disableNetConnect();
  transport.get("https://93.184.216.34").intercept({ path: "/developer-test", method: "GET" }).reply(200, () => {
    pageRequests.push({});
    return "<html><body>developer-web-marker</body></html>";
  }, { headers: { "content-type": "text/html" } });
  const originalDispatch = Agent.prototype.dispatch;
  let forwarding = false;
  const dispatch = vi.spyOn(Agent.prototype, "dispatch").mockImplementation(function (this: any, options: any, handler: any) {
    if (forwarding) return originalDispatch.call(this, options, handler);
    forwarding = true;
    try { return transport.dispatch(options, handler); }
    finally { forwarding = false; }
  });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url) === pageUrl) {
      pageRequests.push(init);
      return new Response("<html><body>developer-web-marker</body></html>", { headers: { "Content-Type": "text/html" } });
    }
    const request = JSON.parse(String(init?.body)); requests.push(request);
    const call = request.tools && request.messages.at(-1)?.role !== "tool";
    const target = JSON.stringify(request.messages).includes("Fetch private") ? "http://127.0.0.1/private" : pageUrl;
    const delta = call ? { tool_calls: [{ index: 0, id: "developer-web", function: { name: "web_fetch", arguments: JSON.stringify({ url: target }) } }] } : { content: "completed" };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  const tokens = new SetupTokenStore();
  const app = await buildServer({ setupTokens: tokens, pluginCombination: "full", env: { DATA_DIR: root, BOOTSTRAP_API_KEY: "developer-web-key", JWT_SECRET: "web-secret" } });
  const headers = { "X-API-Key": "developer-web-key" };
  try {
    expect((await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: tokens.issue().token, username: "web-owner", password: "web-owner-password" } })).statusCode).toBe(201);
    new AgentSettingsStore(root).write(findUserByName("web-owner")!.id, { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://model.test/v1", model: "developer-model", apiKey: "private-model-key" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    const project = await app.inject({ method: "POST", url: "/api/development/projects", headers, payload: { name: "web-app" } });
    expect(project.statusCode, project.body).toBe(201);
    const id = project.json().data.id;
    for (const mode of ["enabled", "private", "disabled"]) {
      expect((await app.inject({ method: "PUT", url: `/api/development/projects/${id}/agent/settings`, headers, payload: { enabledCapabilities: mode === "disabled" ? [] : ["web"], disabledTools: [] } })).statusCode).toBe(200);
      requests.length = 0;
      const run = await app.inject({ method: "POST", url: `/api/development/projects/${id}/agent/run`, headers, payload: { sessionId: "developer-web-" + mode, prompt: mode === "private" ? "Fetch private" : "Fetch public" } });
      expect(run.statusCode, run.body).toBe(200);
      const tools = requests.find(request => request.tools)?.tools ?? [];
      expect(tools.some((tool: any) => tool.function.name === "web_fetch")).toBe(mode !== "disabled");
      const results = JSON.stringify(requests.flatMap(request => request.messages.filter((message: any) => message.role === "tool")));
      if (mode === "enabled") expect(dispatch.mock.calls.map(([options]) => options), results).not.toEqual([]);
      if (mode === "enabled") expect(results).toContain("developer-web-marker");
      else expect(results).toMatch(mode === "private" ? /blocked|non-public|private/i : /unknown|not found|disabled/i);
      expect(pageRequests).toHaveLength(1);
      const native = async (method: string, args: any) => {
        const response = await app.inject({ method: "POST", url: `/api/development/projects/${id}/native/own/api/session/${method}`, headers, payload: { type: "client-request", rpcId: method, method: "session/" + method, payload: { args } } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().result.ok, response.body).toBe(true);
        return response.json().result.value;
      };
      const sessionId = "developer-web-" + mode;
      const projection = await native("projections", { request: { sessionId } });
      const page = await native("page", { request: { address: { kind: "session", sessionId }, throughSeq: projection.asOfSeq } });
      expect(page.records.some((record: any) => record.type === "event" && record.event.type === "tool/call" && record.event.data.name === "web_fetch")).toBe(true);
      if (mode === "enabled") expect(JSON.stringify(page.records)).toContain("developer-web-marker");
    }
    expect(JSON.stringify(pageRequests)).not.toContain("private-model-key");
  } finally { await app.close(); closeMetaDb(); dispatch.mockRestore(); await transport.close(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 20000);
