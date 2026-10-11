import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import { findUserByName, getDb, flushMetaDb, closeMetaDb } from "../../src/lib/meta-sqlite.js";
import { AgentSettingsStore } from "../../src/lib/agent-settings.js";
import { userWorkspaceRoot } from "@localapp/dsh-multiuser/workspace-root";

it("runs a developer child Agent with its user's model inside the project", async () => {
  const parent = path.resolve(__dirname, "../../../../tmp/developer-subagent");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const requests: any[] = [];
  const outside = path.join(root, "outside-child.txt");
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const child = request.messages.some((m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("child project task"));
    const name = child ? "write" : "subagent";
    const calls = request.messages.filter((m: any) => m.role === "assistant" && m.tool_calls?.some((t: any) => t.function?.name === name)).length;
    const done = calls >= (child ? 2 : 1);
    const args = child ? { file_path: calls === 0 ? outside : "child.txt", content: "child project marker" } : { description: "Create project file", prompt: "child project task", run_in_background: false };
    const delta = done ? { content: "finished" } : { tool_calls: [{ index: 0, id: `child-${requests.length}`, function: { name, arguments: JSON.stringify(args) } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  const tokens = new SetupTokenStore();
  const serverOptions = { setupTokens: tokens, pluginCombination: "full" as const, env: { DATA_DIR: root, BOOTSTRAP_API_KEY: "child-key", JWT_SECRET: "child-secret" } };
  let app = await buildServer(serverOptions);
  try {
    expect((await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: tokens.issue().token, username: "child-owner", password: "child-owner-password" } })).statusCode).toBe(201);
    const owner = findUserByName("child-owner")!;
    new AgentSettingsStore(root).write(owner.id, { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://model.test/v1", model: "child-user-model", apiKey: "child-user-key" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    const created = await app.inject({ method: "POST", url: "/api/development/projects", headers: { "X-API-Key": "child-key" }, payload: { name: "child-app" } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().data.id;
    const result = await app.inject({ method: "POST", url: `/api/development/projects/${id}/agent/run`, headers: { "X-API-Key": "child-key" }, payload: { sessionId: "developer-child", prompt: "Delegate the project work" } });
    expect(result.statusCode, result.body).toBe(200);
    await expect.poll(() => fs.readFile(path.join(root, "development", "projects", id, "workspace", "child.txt"), "utf8").catch(() => undefined), { timeout: 5000 }).toBe("child project marker");
    expect(await fs.stat(outside).catch(() => undefined)).toBeUndefined();
    const childToolResults = requests.flatMap(request => request.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content));
    expect(JSON.stringify(childToolResults)).toMatch(/outside|denied|not allowed|permission/i);
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(requests.every(request => request.model === "child-user-model")).toBe(true);
    expect(requests.some(request => request.messages.some((m: any) => m.role === "tool" && m.content.includes("started subagent")))).toBe(true);
    const childId = JSON.stringify(childToolResults).match(/started subagent ([a-z0-9-]+)/)?.[1];
    expect(childId).toBeDefined();
    const native = async (method: string, args: unknown) => {
      const response = await app.inject({ method: "POST", url: `/api/development/projects/${id}/native/own/api/session/${method}`, headers: { "X-API-Key": "child-key" }, payload: { type: "client-request", rpcId: "child-" + method, method: "session/" + method, payload: { args } } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().result.ok, response.body).toBe(true);
      return response.json().result.value;
    };
    const projections = await native("projections", { request: { sessionId: childId } });
    expect(projections.asOfSeq).toBeGreaterThan(0);
    const page = await native("page", { request: { address: { kind: "subagent", parentSessionId: "developer-child", childSessionId: childId, mode: "unknown" }, throughSeq: projections.asOfSeq } });
    expect(JSON.stringify(page)).toContain("child.txt");
    expect(JSON.stringify(page)).toContain("child project marker");
    expect(page.records.some((record: any) => record.type === "event" && record.event.type === "tool/call" && record.event.data.name === "write")).toBe(true);
    expect(page.records.some((record: any) => record.type === "event" && record.event.type === "tool/result" && record.event.data.message.isError)).toBe(true);
    const foreignParent = await app.inject({ method: "POST", url: `/api/development/projects/${id}/native/own/api/session/page`, headers: { "X-API-Key": "child-key" }, payload: { type: "client-request", rpcId: "wrong-parent", method: "session/page", payload: { args: { request: { address: { kind: "subagent", parentSessionId: "another-parent", childSessionId: childId, mode: "unknown" }, throughSeq: projections.asOfSeq } } } } });
    expect(foreignParent.json().result).toMatchObject({ ok: false, error: { code: "subagent/unauthorized" } });
    await app.close(); closeMetaDb();
    app = await buildServer(serverOptions);
    const restoredProjections = await native("projections", { request: { sessionId: childId } });
    const restored = await native("page", { request: { address: { kind: "subagent", parentSessionId: "developer-child", childSessionId: childId, mode: "unknown" }, throughSeq: restoredProjections.asOfSeq } });
    expect(JSON.stringify(restored)).toContain("child.txt");
    expect(JSON.stringify(restored)).toContain("child project marker");
    expect(restored.records.some((record: any) => record.type === "event" && record.event.type === "tool/result" && record.event.data.message.isError)).toBe(true);
  } finally { await app.close(); closeMetaDb(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 20000);

it.each(["user", "developer", "developer-provider", "developer-credentials"] as const)("aborts the real Agent model request after account or provider changes: %s", async role => {
  const parent = path.resolve(__dirname, "../../../../tmp/account-runtime-stop");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  let opened = false, aborted = false;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    opened = true;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"working"},"finish_reason":null}]}\n\n'));
      init.signal.addEventListener("abort", () => { aborted = true; controller.error(new DOMException("Aborted", "AbortError")); }, { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
  }));
  const tokens = new SetupTokenStore();
  const app = await buildServer({ setupTokens: tokens, pluginCombination: role === "user" ? "multiuser" : "full", env: { DATA_DIR: root, BOOTSTRAP_API_KEY: "deleted-account-key", JWT_SECRET: "deleted-account-secret" } });
  let run: Promise<{ statusCode: number }> | undefined;
  try {
    const setup = await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: tokens.issue().token, username: "account-owner", password: "account-owner-password" } });
    expect(setup.statusCode, setup.body).toBe(201);
    const owner = findUserByName("account-owner")!;
    new AgentSettingsStore(root).write(owner.id, { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://model.test/v1", model: "own", apiKey: "own" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    let base = "/api/agent";
    if (role !== "user") {
      const created = await app.inject({ method: "POST", url: "/api/development/projects", headers: { "X-API-Key": "deleted-account-key" }, payload: { name: "account-stop-app" } });
      expect(created.statusCode, created.body).toBe(201);
      base = `/api/development/projects/${created.json().data.id}/agent`;
    }
    run = app.inject({ method: "POST", url: base + "/run", headers: { "X-API-Key": "deleted-account-key" }, payload: { sessionId: "deleted-account-session", prompt: "Account removal marker", systemPrompt: "", tools: [] } });
    await expect.poll(() => opened, { timeout: 5000 }).toBe(true);
    if (role === "developer-provider") {
      const settings = new AgentSettingsStore(root);
      settings.write(owner.id, { ...settings.read(owner.id), providers: [], defaultProviderId: "" });
    } else if (role === "developer-credentials") {
      const settings = new AgentSettingsStore(root), saved = settings.read(owner.id);
      settings.write(owner.id, { ...saved, providers: saved.providers.map(provider => ({ ...provider, apiKey: "replacement-key" })) });
    } else { getDb().run("DELETE FROM users WHERE id = ?", [owner.id]); flushMetaDb(); }
    await expect.poll(() => aborted, { timeout: 3000 }).toBe(true);
    expect((await run).statusCode).toBe(200);
    const denied = await app.inject({ url: base + "/sessions", headers: { "X-API-Key": "deleted-account-key" } });
    expect(denied.statusCode).toBe(role === "developer-provider" ? 400 : role === "developer-credentials" ? 200 : 401);
  } finally { await app.close(); await run; closeMetaDb(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 15000);

it.each(["user", "developer"].flatMap(role => ["delete", "logout", "password", "reset-password"].map(action => ({ role, action }))))("terminates a real $role background process after $action", async ({ role, action }) => {
  const parent = path.resolve(__dirname, "../../../../tmp/account-background-stop");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    const done = request.messages.some((message: any) => message.role === "tool");
    const delta = done ? { content: "Background started" } : { tool_calls: [{ index: 0, id: "account-background", function: { name: "bash", arguments: JSON.stringify({ description: "Account background process", command: `exec node -e 'require("fs").writeFileSync("job.pid", String(process.pid)); setInterval(() => {}, 1000)'`, run_in_background: true }) } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  const tokens = new SetupTokenStore();
  const app = await buildServer({ setupTokens: tokens, pluginCombination: role === "user" ? "multiuser" : "full", env: { DATA_DIR: root, BOOTSTRAP_API_KEY: "background-account-key", JWT_SECRET: "background-account-secret" } });
  try {
    const setup = await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: tokens.issue().token, username: "background-owner", password: "background-owner-password" } });
    expect(setup.statusCode, setup.body).toBe(201);
    const owner = findUserByName("background-owner")!;
    new AgentSettingsStore(root).write(owner.id, { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://model.test/v1", model: "own", apiKey: "own" }], defaultProviderId: "own", grants: { platform: ["terminal", "jobs"] }, mcpServers: [] });
    let base = "/api/agent";
    let workspace = path.join(userWorkspaceRoot(root, owner.id, "platform", "own", ["own"]), "workspace");
    if (role === "developer") {
      const created = await app.inject({ method: "POST", url: "/api/development/projects", headers: { "X-API-Key": "background-account-key" }, payload: { name: "background-stop-app" } });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().data.id;
      base = `/api/development/projects/${id}/agent`;
      workspace = path.join(root, "development", "projects", id, "workspace");
    }
    const run = await app.inject({ method: "POST", url: base + "/run", headers: { "X-API-Key": "background-account-key" }, payload: { sessionId: "account-background-session", prompt: "Start background process", systemPrompt: "", tools: [] } });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.body).toContain("Background started");
    let pid = 0;
    await expect.poll(async () => { try { pid = Number(await fs.readFile(path.join(workspace, "job.pid"), "utf8")); return pid > 0; } catch { return false; } }, { timeout: 5000 }).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
    let cookie = "";
    if (action === "delete") { getDb().run("DELETE FROM users WHERE id = ?", [owner.id]); flushMetaDb(); }
    else {
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "background-owner", password: "background-owner-password" } });
      expect(login.statusCode, login.body).toBe(200);
      cookie = "token=" + login.cookies.find(value => value.name === "token")!.value;
      const revoked = action === "logout"
        ? await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })
        : action === "password"
          ? await app.inject({ method: "PUT", url: "/api/me/password", headers: { cookie }, payload: { oldPassword: "background-owner-password", newPassword: "replacement-owner-password" } })
          : await app.inject({ method: "POST", url: "/api/admin/reset-password", headers: { "X-API-Key": "background-account-key" }, payload: { userId: owner.id } });
      expect(revoked.statusCode, revoked.body).toBe(200);
    }
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }, { timeout: 5000 }).toBe(true);
    if (action === "delete") expect((await app.inject({ url: base + "/sessions", headers: { "X-API-Key": "background-account-key" } })).statusCode).toBe(401);
    else {
      expect((await app.inject({ url: base + "/sessions", headers: { cookie } })).statusCode).toBe(401);
      const history = await app.inject({ url: role === "user" ? base + "/sessions/account-background-session" : base + "/history?sessionId=account-background-session", headers: { "X-API-Key": "background-account-key" } });
      expect(history.statusCode, history.body).toBe(200);
      expect(history.body).toContain("Account background process");
    }
  } finally { await app.close(); closeMetaDb(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 15000);
