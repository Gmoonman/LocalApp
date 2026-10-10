import http from "node:http";
import WebSocket from "ws";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import { closeMetaDb, createApiKey, createUser, findUserByName } from "../../src/lib/meta-sqlite.js";
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../tmp/deepseek-test-harness-http-e2e", String(process.pid));
const adminKey = "test-harness-e2e-admin-key";
describe("unified Server DeepSeek Harness HTTP", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let model: http.Server;
  let baseUrl: string;
  let outsiderKey: string;
  const modelRequests: any[] = [];
  beforeAll(async () => {
    model = http.createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      modelRequests.push({ ...request, authorization: req.headers.authorization });
      const hasResult = request.messages.at(-1)?.role === "tool";
      const native = request.messages.some((message: any) => message.content === "native HTTP hello");
      const completed = hasResult || native;
      const delta = completed ? { content: native ? "native HTTP finished" : "工具已完成" } : { tool_calls: [{ index: 0, id: "http-call", function: { name: "echo", arguments: '{"text":"hello"}' } }] };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: completed ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const tokens = new SetupTokenStore();
    const { buildNativeClient } = await import("../../scripts/build-native-client.mjs");
    const nativeClientRoot = path.join(dataDir, "native-client");
    await buildNativeClient(nativeClientRoot);
    app = await buildServer({ nativeClientRoot, setupTokens: tokens, env: { DATA_DIR: dataDir, JWT_SECRET: "test-harness-http-e2e", BOOTSTRAP_API_KEY: adminKey, LLM_API_KEY: "mock-key", LLM_BASE_URL: `http://127.0.0.1:${(model.address() as any).port}/v1`, LLM_MODEL: "mock-model" } });
    const token = tokens.issue();
    expect((await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: token.token, username: "harness-http-admin", password: "harness-test-password" } })).statusCode).toBe(201);
    createUser("harness-outsider", "harness-outsider", "not-used");
    outsiderKey = createApiKey("harness-outsider").key;
    expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": adminKey }, payload: { providers: [{ id: "mock", name: "Mock", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, model: "mock-model", apiKey: "mock-key" }], defaultProviderId: "mock", grants: {}, mcpServers: [] } })).statusCode).toBe(200);
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${app.addresses()[0].port}`;
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => model?.close(() => resolve()));
    closeMetaDb();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  it("requires authentication and validates input", async () => {
    const send = (key?: string) => fetch(`${baseUrl}/api/agent/run`, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "X-API-Key": key } : {}) }, body: "{}" });
    expect((await send()).status).toBe(401);
    expect((await send(adminKey)).status).toBe(400);
  });
  it("streams a harness turn and accepts tool results only from the owning user", async () => {
    const response = await fetch(`${baseUrl}/api/agent/run`, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "http-e2e-session", prompt: "echo hello", systemPrompt: "Use echo", tools: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }) });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: any[] = [];
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const event = JSON.parse(line.slice(5)); events.push(event);
        if (event.type !== "tool_call") continue;
        const submit = (key: string) => fetch(`${baseUrl}/api/agent/tool-result`, { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ token: event.token, result: { echo: event.args.text } }) });
        expect((await submit(outsiderKey)).status).toBe(404);
        expect((await submit(adminKey)).status).toBe(200);
        expect((await submit(adminKey)).status).toBe(404);
      }
    }
    expect(events.some((e) => e.type === "text_delta" && e.text === "工具已完成")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1).type).toBe("done");
  });
  it("serves native session history with Server authentication and application access", async () => {
    const send = (key?: string, appId = "platform", origin?: string) => fetch(
      baseUrl + "/api/agent/native/api/session/list?appId=" + encodeURIComponent(appId), {
        method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "X-API-Key": key } : {}), ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ type: "client-request", rpcId: "native-list", method: "session/list", payload: { args: { _request: {} } } }),
      });
    expect((await send()).status).toBe(401);
    const own = await send(adminKey); expect(own.status).toBe(200);
    expect(await own.text()).toContain("http-e2e-session");
    const page = await fetch(baseUrl + "/api/agent/native/api/session/page", {
      method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "native-page", method: "session/page", payload: { args: { request: { address: { kind: "session", sessionId: "http-e2e-session" }, throughSeq: 0 } } } }),
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("echo hello");
    const workspace = await fetch(baseUrl + "/api/agent/native/api/workspace/initializeDefault", {
      method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "native-workspace", method: "workspace/initializeDefault", payload: { args: {} } }),
    });
    expect(workspace.status).toBe(200);
    expect((await workspace.json()).result.value.workspace.path.startsWith(path.join(dataDir, "agent"))).toBe(true);
    expect((await send(adminKey, "missing/application")).status).toBe(400);
    expect((await send(adminKey, "platform", "https://untrusted.test")).status).toBe(403);
    expect((await send(outsiderKey)).status).toBe(400);
  });
  it("exposes the configured model through native session RPC", async () => {
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const send = (method: string, args: unknown, key = adminKey) => fetch(`${baseUrl}/api/agent/native/${scope}/api/session/${method}`, {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: `native-${method}`, method: `session/${method}`, payload: { args } }),
    });
    const catalog = await send("modelCatalog", {});
    expect(catalog.status).toBe(200);
    const value = (await catalog.json()).result.value;
    expect(value.groups).toEqual([{ id: "localapp", name: "localapp", models: [{ id: "mock-model", name: "mock-model" }] }]);
    expect(value.failures).toEqual([]);
    const selection = await send("selectModel", { request: { sessionId: "http-e2e-session", provider: "localapp", model: "mock-model" } });
    expect(selection.status).toBe(200);
    expect((await selection.json()).result.value.selected).toMatchObject({ provider: "localapp", model: "mock-model" });
    const foreign = await send("selectModel", { request: { sessionId: "http-e2e-session", provider: "other", model: "mock-model" } });
    expect(await foreign.text()).toContain("session/model-unavailable");
    expect((await send("modelCatalog", {}, outsiderKey)).status).toBe(400);
  });
  it("creates native sessions over authenticated scoped HTTP", async () => {
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const send = (request: unknown, key = adminKey) => fetch(`${baseUrl}/api/agent/native/${scope}/api/session/create`, {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "native-create", method: "session/create", payload: { args: { request } } }),
    });
    const created = await send({});
    expect(created.status).toBe(200);
    expect((await created.json()).result.value.sessionId).toMatch(/^session-/);
    expect(await (await send({ sessionId: "../escape" })).text()).toContain("Invalid session ID");
    expect(await (await send({ cwd: dataDir })).text()).toContain("outside the application workspace");
    expect((await send({}, outsiderKey)).status).toBe(400);
  });
  it("executes native HTTP prompts and keeps their original trajectory", async () => {
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const send = (method: string, args: unknown, key = adminKey) => fetch(`${baseUrl}/api/agent/native/${scope}/api/session/${method}`, {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: `native-${method}`, method: `session/${method}`, payload: { args } }),
    });
    const { sessionId } = (await (await send("create", { request: {} })).json()).result.value;
    const request = { sessionId, requestId: "native-http-request", mode: "queue", content: [{ type: "text", text: "native HTTP hello" }] };
    const promptRequests = () => modelRequests.filter(item => item.messages.some((message: any) => message.content === "native HTTP hello"));
    const response = await send("prompt", { request });
    expect(response.status).toBe(200);
    expect((await response.json()).result.value).toEqual({ accepted: true });
    const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/agent/native/${scope}/api/remote.mux`, { headers: { "X-API-Key": adminKey } });
    try {
      const trajectory = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native prompt trajectory timed out")), 5000);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
        socket.on("message", frame => {
          const text = frame.toString();
          if (text.includes("native HTTP finished")) { clearTimeout(timer); resolve(text); }
        });
        socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "prompt-trajectory", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId } } } } })));
      });
      expect(trajectory).toContain("native HTTP finished");
    } finally { socket.terminate(); }
    expect(promptRequests()).toHaveLength(1);
    expect(promptRequests()[0]).toMatchObject({ model: "mock-model", authorization: "Bearer mock-key" });
    expect((await send("prompt", { request })).status).toBe(200);
    expect(promptRequests()).toHaveLength(1);
    expect((await send("prompt", { request }, outsiderKey)).status).toBe(400);
  });
  it("pins native client transport paths to the selected provider and application", async () => {
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const send = (key: string, token = scope) => fetch(baseUrl + "/api/agent/native/" + token + "/api/session/list?appId=missing/application&providerId=missing", {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "scoped-list", method: "session/list", payload: { args: { _request: {} } } }),
    });
    const response = await send(adminKey); expect(response.status).toBe(200);
    expect(await response.text()).toContain("http-e2e-session");
    expect((await send(adminKey, "invalid")).status).toBe(400);
    expect((await send(outsiderKey)).status).toBe(400);
  });
  it("serves the original native boot page and scoped plugin bundles", async () => {
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const url = baseUrl + "/api/agent/native/" + scope + "/";
    expect((await fetch(url)).status).toBe(401);
    const page = await fetch(url, { headers: { "X-API-Key": adminKey } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("__DSH_BOOT__");
    expect(html).toContain("__ModuleLoader__");
    expect(html).toContain("dsh-client-ui-trajectory");
    expect(html).toContain(url.replace(baseUrl, ""));
    const entry = await fetch(url + "client/entry.js", { headers: { "X-API-Key": adminKey } });
    expect(entry.status).toBe(200);
    expect(await entry.text()).toContain("Native client mount point is missing");
    const resource = html.match(/"id":"@deepseek-ai\/dsh-client-ui-trajectory"[^}]*"url":"([^"]+)"/)?.[1];
    expect(resource).toBeDefined();
    const plugin = await fetch(url + resource, { headers: { "X-API-Key": adminKey } });
    expect(plugin.status).toBe(200);
    expect((await plugin.text()).length).toBeGreaterThan(100);
  });
  it("rejects unauthenticated, inaccessible and foreign-origin native sockets", async () => {
    const status = (headers: Record<string, string>, query = "") => new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/api/agent/native/api/remote.mux" + query, { headers });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("Socket rejection timed out")); }, 5000);
      socket.once("unexpected-response", (_request, response) => { clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode!); });
      socket.once("error", () => {});
      socket.once("open", () => { clearTimeout(timer); socket.terminate(); reject(new Error("Unauthorized socket opened")); });
    });
    expect(await status({})).toBe(401);
    expect(await status({ "X-API-Key": adminKey }, "?appId=missing/application")).toBe(400);
    expect(await status({ "X-API-Key": adminKey, Origin: "https://untrusted.test" })).toBe(403);
  });
  it("establishes the native client forwarded-event stream", async () => {
    const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/api/agent/native/api/remote.mux", { headers: { "X-API-Key": adminKey } });
    try {
      const frame = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native client readiness timed out")), 5000);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
        socket.once("message", value => { clearTimeout(timer); resolve(JSON.parse(value.toString())); });
        socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "client-events", endpoint: "$events", payload: { args: {} } })));
      });
      expect(frame.type).toBe("item");
      expect(frame.value.type).toBe("ready");
      expect(frame.value.clientId).toEqual(expect.any(String));
    } finally { socket.terminate(); }
  });
  it("follows native trajectory through the unified Server WebSocket", async () => {
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/api/agent/native/" + scope + "/api/remote.mux", { headers: { "X-API-Key": adminKey } });
    try {
      const frame = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native trajectory socket timed out")), 5000);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
        socket.on("message", value => { clearTimeout(timer); resolve(JSON.parse(value.toString())); });
        socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "history", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId: "http-e2e-session" } } } } })));
      });
      expect(JSON.stringify(frame)).toContain("echo hello");
      expect(JSON.stringify(frame)).toContain("request/header");
      const update = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Live trajectory update timed out")), 5000);
        socket.on("message", value => { const text = value.toString(); if (text.includes("live trajectory update")) { clearTimeout(timer); resolve(text); } });
      });
      const turn = await fetch(baseUrl + "/api/agent/run", { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "http-e2e-session", prompt: "live trajectory update", systemPrompt: "", tools: [] }) });
      expect(turn.status).toBe(200); await turn.text();
      expect(await update).toContain("agent/inbox/spliced");
      socket.send(JSON.stringify({ type: "cancel", streamId: "history" }));
    } finally { socket.terminate(); }
  });
  it("keeps provider credentials and settings separate for each user", async () => {
    const get = (key: string) => app.inject({ method: "GET", url: "/api/agent/settings", headers: { "X-API-Key": key } });
    const own = (await get(adminKey)).json();
    expect(own.data.providers[0].hasApiKey).toBe(true);
    expect(JSON.stringify(own)).not.toContain("mock-key");
    expect((await get(outsiderKey)).json().data.providers).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/agent/run", headers: { "X-API-Key": outsiderKey }, payload: { sessionId: "not-configured", prompt: "hi", systemPrompt: "", tools: [] } })).statusCode).toBe(400);
    const saved = await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": outsiderKey }, payload: { ...own.data, providers: [{ ...own.data.providers[0], model: "outsider-model", apiKey: "test-outsider-model-key" }] } });
    expect(saved.statusCode).toBe(200);
    const response = await fetch(`${baseUrl}/api/agent/run`, { method: "POST", headers: { "X-API-Key": outsiderKey, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "http-e2e-session", prompt: "hello", systemPrompt: "", tools: [] }) });
    expect(response.status).toBe(200);
    // With no echo tool registered the loop records its unknown-tool error;
    // the provider still completes the next model step and the turn settles.
    await response.text();
    expect(modelRequests.at(-1).model).toBe("outsider-model");
    expect(modelRequests.at(-1).authorization).toBe("Bearer test-outsider-model-key");
    expect((await get(adminKey)).json().data.providers[0].model).toBe("mock-model");
    expect((await app.inject({ method: "GET", url: "/api/agent/sessions", headers: { "X-API-Key": adminKey } })).json().data.map((s: any) => s.id)).toContain("http-e2e-session");
  });
  it("requires both application declarations and user grants before exposing extra tools", async () => {
    const owner = findUserByName("harness-http-admin")!;
    const directory = path.join(dataDir, owner.id, "agent-app");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "meta.json"), JSON.stringify({ name: "agent-app", userId: owner.id, currentVersion: 1, versions: [], metadata: {}, pageAccess: { level: "owner" } }));
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ name: "agent-app", agent: { capabilities: ["files", "subagents"] } }));
    const own = (await app.inject({ method: "GET", url: "/api/agent/settings", headers: { "X-API-Key": adminKey } })).json().data;
    expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": adminKey }, payload: { ...own, grants: { "harness-http-admin/agent-app": ["files", "terminal"] } } })).statusCode).toBe(200);
    const input = { appId: "harness-http-admin/agent-app", sessionId: "declared-capabilities", prompt: "hello", systemPrompt: "Application prompt", tools: [] };
    const response = await fetch(`${baseUrl}/api/agent/run`, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    await response.text();
    const names = modelRequests.at(-1).tools.map((t: any) => t.function.name);
    expect(names).toContain("read");
    expect(names).not.toContain("subagent");
    expect(names).not.toContain("bash");
    expect(modelRequests.at(-1).authorization).toBe("Bearer mock-key");
    expect((await app.inject({ method: "POST", url: "/api/agent/run", headers: { "X-API-Key": outsiderKey }, payload: input })).statusCode).toBe(400);
  });

});
