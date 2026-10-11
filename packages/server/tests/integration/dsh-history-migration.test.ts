import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import { findUserByName, closeMetaDb } from "../../src/lib/meta-sqlite.js";
import { AgentSettingsStore } from "../../src/lib/agent-settings.js";
import { DeepSeekHarness } from "../../src/lib/deepseek-harness.mjs";
import { userWorkspaceRoot } from "@localapp/dsh-multiuser/workspace-root";
import { createTestPage } from "./helpers.js";

it("automatically imports provider histories through the Server and restores native trajectories after restart", async () => {
  const parent = path.resolve(__dirname, "../../../../tmp/history-migration-server");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('data: {"choices":[{"delta":{"content":"migration reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  }));
  const tokens = new SetupTokenStore();
  const options = { setupTokens: tokens, pluginCombination: "full" as const, env: { DATA_DIR: root, BOOTSTRAP_API_KEY: "migration-key", JWT_SECRET: "migration-secret" } };
  let app = await buildServer(options);
  try {
    expect((await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: tokens.issue().token, username: "migration-owner", password: "migration-owner-password" } })).statusCode).toBe(201);
    const owner = findUserByName("migration-owner")!;
    const appId = "migration-owner/history-app";
    await createTestPage(app, "migration-owner", "history-app");
    const version = path.join(root, appId, "versions", "v1");
    await fs.mkdir(path.join(version, "assets"), { recursive: true });
    await fs.writeFile(path.join(version, "index.html"), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>');
    await fs.writeFile(path.join(version, "assets", "main.js"), 'document.getElementById("root").innerHTML="<h1>Legacy application ready</h1>";globalThis.__localapp_platform_tool_registry__.registerTools([],{},"Migration browser application");');
    await fs.writeFile(path.join(root, appId, "manifest.json"), JSON.stringify({ name: "history-app", agent: { capabilities: ["schedule"] } }));
    for (const provider of ["first", "second"]) {
      const oldRoot = path.join(root, "agent", createHash("sha256").update(JSON.stringify([owner.id, appId, provider])).digest("hex"));
      const harness = new DeepSeekHarness({ ownerId: owner.id, root: oldRoot, capabilities: [], autoSessionTitles: false, llmApiKey: "old-key", llmBaseUrl: "http://model.test/v1", llmModel: provider });
      try { await harness.run(owner.id, { sessionId: "same-id", prompt: "old " + provider, systemPrompt: "", tools: [] }, () => {}, new AbortController().signal); }
      finally { await harness.close(); }
      if (provider === "first") {
        await fs.mkdir(path.join(oldRoot, "storage"), { recursive: true });
        await fs.writeFile(path.join(oldRoot, "storage", "schedule.json"), JSON.stringify({ unit: { name: "schedule", version: 1 }, global: null, tables: { tasks: { "old-reminder": { sessionId: "same-id", status: "active", record: { id: "old-reminder", kind: "at", title: "Migrated reminder", prompt: "execute migrated reminder", scheduledAt: new Date(Date.now() - 1000).toISOString() } } } } }));
      }
    }
    new AgentSettingsStore(root).write(owner.id, { providers: ["first", "second"].map(id => ({ id, name: id, protocol: "openai-completions" as const, baseUrl: "http://model.test/v1", model: "new-" + id, apiKey: "new-key" })), defaultProviderId: "first", grants: { [appId]: ["schedule"] }, mcpServers: [] });
    const native = async (method: string, args: unknown, providerId = "first") => {
      const scope = Buffer.from(JSON.stringify({ appId, providerId })).toString("base64url");
      const response = await app.inject({ method: "POST", url: `/api/agent/native/${scope}/api/session/${method}`, headers: { "X-API-Key": "migration-key" }, payload: { type: "client-request", rpcId: "migration-" + method, method: "session/" + method, payload: { args } } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().result.ok, response.body).toBe(true);
      return response.json().result.value;
    };
    const list = await native("list", { _request: {} });
    const migratedRoot = userWorkspaceRoot(root, owner.id, appId, "first", ["first", "second"]);
    try { await expect.poll(() => requests.some(request => JSON.stringify(request.messages).includes("execute migrated reminder")), { timeout: 5000 }).toBe(true); }
    catch (error) { throw new Error(await fs.readFile(path.join(migratedRoot, "storage", "schedule.json"), "utf8"), { cause: error }); }
    expect(requests.filter(request => JSON.stringify(request.messages).includes("execute migrated reminder")).every(request => request.model === "new-first")).toBe(true);
    await expect.poll(async () => JSON.parse(await fs.readFile(path.join(migratedRoot, "storage", "schedule.json"), "utf8")).tables.tasks["old-reminder"].status).toBe("inactive");
    const deliveredTask = JSON.parse(await fs.readFile(path.join(migratedRoot, "storage", "schedule.json"), "utf8")).tables.tasks["old-reminder"];
    expect(deliveredTask.lastDelivery.messageId).toBeTruthy();
    expect(deliveredTask.deliveryHistory.records).toHaveLength(1);
    const manifest = JSON.parse(await fs.readFile(path.join(migratedRoot, "legacy-import.json"), "utf8"));
    expect(manifest.sessions).toHaveLength(2);
    for (const entry of manifest.sessions) expect(JSON.stringify(list)).toContain(entry.targetSessionId);
    await app.close(); closeMetaDb(); app = await buildServer(options);
    expect(JSON.parse(await fs.readFile(path.join(migratedRoot, "storage", "schedule.json"), "utf8")).tables.tasks["old-reminder"]).toEqual(deliveredTask);
    for (const entry of manifest.sessions) {
      const projections = await native("projections", { request: { sessionId: entry.targetSessionId } }, entry.providerId);
      const page = await native("page", { request: { address: { kind: "session", sessionId: entry.targetSessionId }, throughSeq: projections.asOfSeq } }, entry.providerId);
      expect(JSON.stringify(page)).toContain("old " + entry.providerId);
      expect(JSON.stringify(page)).not.toContain("old " + (entry.providerId === "first" ? "second" : "first"));
      requests.length = 0;
      const run = await app.inject({ method: "POST", url: "/api/agent/run", headers: { "X-API-Key": "migration-key" }, payload: { appId, providerId: entry.providerId, sessionId: entry.targetSessionId, prompt: "continue migrated " + entry.providerId, systemPrompt: "", tools: [] } });
      expect(run.statusCode, run.body).toBe(200);
      expect(run.body).toContain('"type":"done"');
      expect(requests.some(request => JSON.stringify(request.messages).includes("old " + entry.providerId))).toBe(true);
      expect(requests.every(request => request.model === "new-" + entry.providerId)).toBe(true);
    }
    await app.close(); closeMetaDb(); app = await buildServer(options);
    for (const entry of manifest.sessions) {
      const projections = await native("projections", { request: { sessionId: entry.targetSessionId } }, entry.providerId);
      const page = await native("page", { request: { address: { kind: "session", sessionId: entry.targetSessionId }, throughSeq: projections.asOfSeq } }, entry.providerId);
      expect(JSON.stringify(page)).toContain("continue migrated " + entry.providerId);
    }
    if (process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1") {
      for (const entry of manifest.sessions) await native("rename", { request: { sessionId: entry.targetSessionId, title: "Migrated " + entry.providerId + " history" } });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      const page = await browser.newPage();
      const errors: string[] = [];
      const transport: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") transport.push(message.text()); });
      page.on("response", response => { if (response.status() >= 400) transport.push(`${response.status()} ${response.url()}`); });
      page.on("websocket", socket => {
        socket.on("framesent", frame => { if (String(frame.payload).includes("prompt")) transport.push("sent " + frame.payload); });
        socket.on("framereceived", frame => { if (String(frame.payload).includes('"ok":false')) transport.push("received " + frame.payload); });
      });
      page.setDefaultTimeout(5000);
      await page.addInitScript(() => { (window as any).migrationMessages = []; window.addEventListener("message", event => { if (event.data?.type?.startsWith("localapp:native-prepar")) (window as any).migrationMessages.push(event.data); }); });
      try {
        expect((await page.request.post(baseUrl + "/api/auth/login", { data: { username: "migration-owner", password: "migration-owner-password" } })).status()).toBe(200);
        await page.goto(baseUrl + "/" + appId + "/");
        await page.getByText("Legacy application ready", { exact: true }).waitFor();
        await page.getByRole("button", { name: "切换历史对话", exact: true }).click();
        await page.getByLabel("切换对话身份", { exact: true }).click();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "展开应用对话", exact: true }).click();
        const frame = page.frameLocator('iframe[title="原生应用用户对话"]');
        for (const entry of manifest.sessions) {
          await page.getByRole("button", { name: "切换历史对话", exact: true }).click();
          await page.getByRole("menuitemradio").filter({ hasText: "Migrated " + entry.providerId + " history" }).click();
          await frame.getByText("old " + entry.providerId, { exact: true }).first().waitFor();
          await frame.getByText("continue migrated " + entry.providerId, { exact: true }).first().waitFor();
          expect(await frame.getByText("old " + (entry.providerId === "first" ? "second" : "first"), { exact: true }).count()).toBe(0);
          await frame.getByText("轨迹", { exact: true }).click();
          await frame.getByText("continue migrated " + entry.providerId, { exact: true }).first().waitFor();
          if (entry.providerId === "first") {
            await frame.getByText("对话", { exact: true }).click();
            const repliesBefore = await frame.getByText("migration reply", { exact: true }).count();
            const input = frame.locator("textarea, [contenteditable=true]").first();
            await input.fill("browser continues migrated first");
            await frame.getByRole("button", { name: "发送消息", exact: true }).click();
            await expect.poll(() => requests.some(request => request.model === "new-first" && JSON.stringify(request.messages).includes("browser continues migrated first") && JSON.stringify(request.messages).includes("old first") && !JSON.stringify(request.messages).includes("old second")), { timeout: 5000 }).toBe(true);
            await expect.poll(() => frame.getByText("migration reply", { exact: true }).count(), { timeout: 5000 }).toBe(repliesBefore + 1);
          }
        }
        expect(errors).toEqual([]);
        const artifacts = path.join(parent, "browser-evidence");
        await fs.mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, "migrated-formal-application.png"), fullPage: true });
      } finally {
        const artifacts = path.join(parent, "browser-evidence");
        await fs.mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, "migrated-formal-debug.png"), fullPage: true });
        await fs.writeFile(path.join(artifacts, "migrated-formal-debug.json"), JSON.stringify({ errors, transport, url: page.url(), text: await page.locator("body").innerText(), frames: await Promise.all(page.frames().map(async frame => ({ url: frame.url(), text: await frame.locator("body").innerText().catch(() => ""), messages: await frame.evaluate(() => (window as any).migrationMessages) }))), requests: requests.map(request => ({ model: request.model, messages: request.messages })) }, null, 2));
        await browser.close();
      }
    }
  } finally { await app.close(); closeMetaDb(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 40000);
