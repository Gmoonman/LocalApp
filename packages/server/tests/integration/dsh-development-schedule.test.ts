import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import { findUserByName, closeMetaDb } from "../../src/lib/meta-sqlite.js";
import { AgentSettingsStore } from "../../src/lib/agent-settings.js";

it("executes a developer reminder with the user model and exposes it in native trajectory", async () => {
  const parent = path.resolve(__dirname, "../../../../tmp/developer-schedule");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const requests: any[] = [];
  let createdTask = false;
  let marker = "developer-scheduled-marker";
  let delay = 1;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    const call = !createdTask && request.tools?.some((tool: any) => tool.function.name === "schedule_create");
    if (call) createdTask = true;
    const delta = call ? { tool_calls: [{ index: 0, id: "developer-reminder", function: { name: "schedule_create", arguments: JSON.stringify({ title: "Development reminder", prompt: marker, after_seconds: delay }) } }] } : { content: "completed" };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  const tokens = new SetupTokenStore();
  const options = { setupTokens: tokens, pluginCombination: "full" as const, env: { DATA_DIR: root, BOOTSTRAP_API_KEY: "developer-schedule-key", JWT_SECRET: "schedule-secret" } };
  let app = await buildServer(options);
  const headers = { "X-API-Key": "developer-schedule-key" };
  try {
    expect((await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: tokens.issue().token, username: "schedule-owner", password: "schedule-owner-password" } })).statusCode).toBe(201);
    const owner = findUserByName("schedule-owner")!;
    new AgentSettingsStore(root).write(owner.id, { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://model.test/v1", model: "developer-model", apiKey: "own" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    const project = await app.inject({ method: "POST", url: "/api/development/projects", headers, payload: { name: "scheduled-app" } });
    expect(project.statusCode, project.body).toBe(201);
    const id = project.json().data.id;
    expect((await app.inject({ method: "PUT", url: `/api/development/projects/${id}/agent/settings`, headers, payload: { enabledCapabilities: ["schedule"], disabledTools: [] } })).statusCode).toBe(200);
    const run = await app.inject({ method: "POST", url: `/api/development/projects/${id}/agent/run`, headers, payload: { sessionId: "developer-reminder-session", prompt: "Create a reminder" } });
    expect(run.statusCode, run.body).toBe(200);
    await expect.poll(() => requests.some(request => request.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("developer-scheduled-marker"))), { timeout: 5000 }).toBe(true);
    expect(requests.every(request => request.model === "developer-model")).toBe(true);
    const native = async (method: string, args: unknown) => {
      const response = await app.inject({ method: "POST", url: `/api/development/projects/${id}/native/own/api/session/${method}`, headers, payload: { type: "client-request", rpcId: method, method: "session/" + method, payload: { args } } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().result.ok, response.body).toBe(true);
      return response.json().result.value;
    };
    const read = async () => {
      const projections = await native("projections", { request: { sessionId: "developer-reminder-session" } });
      return native("page", { request: { address: { kind: "session", sessionId: "developer-reminder-session" }, throughSeq: projections.asOfSeq } });
    };
    const before = await read();
    expect(before.records.filter((record: any) => record.type === "event" && record.event.type === "user/message" && record.event.data.source.kind === "schedule")).toHaveLength(1);
    expect(before.records.some((record: any) => record.type === "event" && record.event.type === "tool/call" && record.event.data.name === "schedule_create")).toBe(true);
    await app.close(); closeMetaDb(); app = await buildServer(options);
    const after = await read();
    expect(JSON.stringify(after)).toContain("developer-scheduled-marker");
    expect(after.records.filter((record: any) => record.type === "event" && record.event.type === "user/message" && record.event.data.source.kind === "schedule")).toHaveLength(1);
    // Shut down before delivery, then reopen the developer runtime with its saved capability.
    createdTask = false; marker = "developer-after-restart-marker"; delay = 2;
    expect((await app.inject({ method: "POST", url: `/api/development/projects/${id}/agent/run`, headers, payload: { sessionId: "developer-reminder-session", prompt: "Create another reminder" } })).statusCode).toBe(200);
    await app.close(); closeMetaDb(); app = await buildServer(options);
    await read();
    await expect.poll(() => requests.some(request => request.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("developer-after-restart-marker"))), { timeout: 5000 }).toBe(true);
    await expect.poll(async () => (await read()).records.filter((record: any) => record.type === "event" && record.event.type === "user/message" && record.event.data.source.kind === "schedule").length, { timeout: 5000 }).toBe(2);
    createdTask = false; marker = "developer-revoked-marker";
    expect((await app.inject({ method: "POST", url: `/api/development/projects/${id}/agent/run`, headers, payload: { sessionId: "developer-reminder-session", prompt: "Create a reminder before disabling schedules" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/api/development/projects/${id}/agent/settings`, headers, payload: { enabledCapabilities: [], disabledTools: [] } })).statusCode).toBe(200);
    await app.close(); closeMetaDb(); app = await buildServer(options);
    await read();
    // Observe beyond the persisted deadline with the runtime reopened without schedule permission.
    await new Promise(resolve => setTimeout(resolve, 2300));
    expect(requests.some(request => request.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("developer-revoked-marker")))).toBe(false);
    expect((await read()).records.filter((record: any) => record.type === "event" && record.event.type === "user/message" && record.event.data.source.kind === "schedule")).toHaveLength(2);
    expect((await app.inject({ method: "PUT", url: `/api/development/projects/${id}/agent/settings`, headers, payload: { enabledCapabilities: ["schedule"], disabledTools: [] } })).statusCode).toBe(200);
    await read();
    await expect.poll(() => requests.some(request => request.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("developer-revoked-marker"))), { timeout: 5000 }).toBe(true);
    await expect.poll(async () => (await read()).records.filter((record: any) => record.type === "event" && record.event.type === "user/message" && record.event.data.source.kind === "schedule").length, { timeout: 5000 }).toBe(3);
    expect(requests.every(request => request.model === "developer-model")).toBe(true);
  } finally { await app.close(); closeMetaDb(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 20000);
