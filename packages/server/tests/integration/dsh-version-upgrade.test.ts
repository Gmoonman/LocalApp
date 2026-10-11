import initSqlJs from "sql.js";
import { writeAppPackage } from "../../src/lib/app-package.js";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import WebSocket from "ws";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { buildServer } from "../../src/server.js";
import { PeerStore } from "../../src/lib/peer-store.js";
import { SecretBox } from "../../src/lib/secret-box.js";
import { closeMetaDb } from "../../src/lib/meta-sqlite.js";

it.runIf(process.env.LOCALAPP_UPGRADE_VERIFY === "1")("preserves released 0.4.0 accounts, encrypted settings, application content and data through upgrade and rollback", async () => {
  const root = path.resolve(__dirname, "../../../../tmp/dsh-upgrade-0.4.0");
  const directory = await fs.mkdtemp(path.join(root, "data-"));
  const key = "upgrade-fixture-api-key";
  const requests: any[] = [];
  const model = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ ...JSON.parse(raw), authorization: request.headers.authorization });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "upgrade-model-reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const modelUrl = `http://127.0.0.1:${(model.address() as any).port}/v1`;
  const env = { DATA_DIR: directory, BOOTSTRAP_API_KEY: key, LLM_API_KEY: "upgrade-model-secret", LLM_BASE_URL: modelUrl, LLM_MODEL: "upgrade-model" };
  let child: ChildProcess | undefined;
  let current: Awaited<ReturnType<typeof buildServer>> | undefined;
  const launch = async () => {
    child = spawn(process.execPath, [path.join(root, "package/runtime/server/bin/server.mjs"), "start", "--data-dir", directory, "--port", "0"], { env: { ...process.env, ...env, LOCALAPP_WORKER_PATH: path.join(root, "package/runtime/server/bin/worker.cjs"), LOCALAPP_SERVER_ENTRY: path.join(root, "package/runtime/server/bin/server.mjs") }, stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    child.stdout!.on("data", chunk => { errors += chunk; });
    child.stderr!.on("data", chunk => { errors += chunk; });
    return await new Promise<{ url: string; setupUrl?: string }>((resolve, reject) => {
      const lines = createInterface({ input: child!.stdout! });
      const timer = setTimeout(() => { lines.close(); reject(new Error("Legacy Server readiness timed out: " + errors)); }, 15000);
      child!.once("exit", code => { clearTimeout(timer); lines.close(); reject(new Error(`Legacy Server exited ${code}: ${errors}`)); });
      lines.on("line", line => {
        try { const result = JSON.parse(line); if (result.type === "ready") { clearTimeout(timer); lines.close(); resolve(result); } } catch { /* diagnostic output */ }
      });
    });
  };
  const stopOld = async () => {
    if (!child || child.exitCode !== null) return;
    const stopped = new Promise<void>(resolve => child!.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await stopped;
    child = undefined;
  };
  const api = async (url: string, endpoint: string, method = "GET", body?: unknown) => {
    console.info("Upgrade request", method, endpoint);
    const response = await fetch(url + endpoint, { signal: AbortSignal.timeout(10000), method, headers: { "X-API-Key": key, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response;
  };
  const applicationPackage = async (version: string, marker: string, name = "upgrade-app") => {
    const outputPath = path.join(directory, `application-${name}-${version}.localapp`);
    await writeAppPackage({ outputPath, metadata: { schemaVersion: 1, appId: name, version, platformVersion: "^1.0" }, files: [
      { path: "manifest.json", content: Buffer.from(JSON.stringify({ name, distDir: "dist", platformVersion: "^1.0" })) },
      { path: "dist/index.html", content: Buffer.from(`<html><body><div id="root"></div><script type="module" src="./app.js"></script></body></html>`) },
      { path: "dist/app.js", content: Buffer.from(`const root = document.getElementById("root"); const heading = document.createElement("h1"); heading.textContent = ${JSON.stringify(marker)}; root.replaceChildren(heading);`) },
      { path: "migrations/001_init.sql", content: Buffer.from("CREATE TABLE upgrade_records (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO upgrade_records VALUES (1, 'old-application-data');") },
    ] });
    return await fs.readFile(outputPath);
  };
  const install = async (url: string, bytes: Buffer) => {
    const form = new FormData();
    form.append("package", new Blob([bytes]), "upgrade.localapp");
    const response = await fetch(url + "/api/me/apps/install", { method: "POST", headers: { "X-API-Key": key }, body: form });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()).data;
  };
  const verifyApplication = async (url: string, applicationUrl: string, marker: string, phase: string) => {
    expect(await (await api(url, applicationUrl)).text()).toContain("data-localapp-app-resource-base");
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ extraHTTPHeaders: { "X-API-Key": key } });
      await page.goto(url + applicationUrl);
      await page.getByRole("heading", { name: marker, exact: true }).waitFor({ timeout: 10000 });
      await fs.mkdir(path.join(root, "browser-evidence"), { recursive: true });
      await page.screenshot({ path: path.join(root, "browser-evidence", phase + ".png"), fullPage: true });
    } finally { await browser.close(); }
  };
  const databaseValue = async (ownerId: string, name = "upgrade-app") => {
    const SQL = await initSqlJs();
    const db = new SQL.Database(await fs.readFile(path.join(directory, ownerId, name, "app.db")));
    try { return db.exec("SELECT value FROM upgrade_records WHERE id = 1")[0].values[0][0]; }
    finally { db.close(); }
  };
  try {
    console.info("Upgrade phase: released start");
    const old = await launch();
    expect(old.setupUrl).toBeDefined();
    const token = new URL(old.setupUrl!).searchParams.get("token");
    await api(old.url, "/api/setup/initialize", "POST", { token, username: "upgrade-owner", password: "upgrade-test-password" });
    await api(old.url, "/api/agent/settings", "PUT", { providers: [{ id: "upgrade-provider", name: "Upgrade provider", protocol: "openai-completions", baseUrl: modelUrl, model: "upgrade-model", apiKey: "upgrade-model-secret" }], defaultProviderId: "upgrade-provider", grants: {}, mcpServers: [] });
    const oldPeer = (await (await api(old.url, "/api/peers", "POST", { name: "upgrade-peer", baseUrl: old.url, apiKey: "upgrade-peer-secret", acceptInsecureHttp: true })).json()).data;
    const installed = await install(old.url, await applicationPackage("1.0.0", "old-application-content"));
    const applicationUrl = `/${installed.ownerId}/upgrade-app/`;
    const sourceFree = await install(old.url, await applicationPackage("1.0.0", "source-free-legacy-content", "source-free-app"));
    const sourceFreeUrl = `/${sourceFree.ownerId}/source-free-app/`;
    const verifySourceFree = async (serverUrl: string, phase: string) => {
      const projects = (await (await api(serverUrl, "/api/development/projects")).json()).data;
      expect(projects.some((project: { name: string }) => project.name === "source-free-app")).toBe(false);
      await verifyApplication(serverUrl, sourceFreeUrl, "source-free-legacy-content", "source-free-" + phase);
      const after = (await (await api(serverUrl, "/api/development/projects")).json()).data;
      expect(after.some((project: { name: string }) => project.name === "source-free-app")).toBe(false);
      expect(await databaseValue(sourceFree.ownerId, "source-free-app")).toBe("old-application-data");
    };
    await verifySourceFree(old.url, "old");
    await verifyApplication(old.url, applicationUrl, "old-application-content", "old");
    expect(await databaseValue(installed.ownerId)).toBe("old-application-data");
    const input = { sessionId: "upgrade-session", providerId: "upgrade-provider", prompt: "old-version-message", systemPrompt: "", tools: [] };
    // The released artifact cannot initialize its Harness on this runtime.
    // Keep this failure explicit rather than inventing a legacy conversation.
    const legacyRun = await fetch(old.url + "/api/agent/run", { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(legacyRun.status).toBe(400);
    expect(await legacyRun.text()).toContain("invalid plugin");
    const account = (await (await api(old.url, "/api/me")).json()).data;
    const oldProject = (await (await api(old.url, "/api/development/projects", "POST", { name: "upgrade-app" })).json()).data;
    for (const applicationId of ["platform", "upgrade-owner/upgrade-app", "developer"]) {
      const historyRoot = applicationId === "developer" ? path.join(directory, "development", "projects", oldProject.id, "agent", account.id) : path.join(directory, "agent", createHash("sha256").update(JSON.stringify([account.id, applicationId, "upgrade-provider"])).digest("hex"));
      const sessionCwd = applicationId === "developer"
        ? path.join(directory, "development", "projects", oldProject.id, "workspace")
        : historyRoot;
      if (applicationId === "developer") expect((await fs.stat(sessionCwd)).isDirectory()).toBe(true);
      // Write with the released persistence library at the released route's exact root.
      await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
        import { Context } from "@deepseek-ai/cordis";
        import Sessions from "@deepseek-ai/dsh-session";
        import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
        import { createUserMessage } from "@deepseek-ai/dsh-llm";
        const ctx = new Context();
        try {
          await ctx.plugin(Sessions);
          await ctx.plugin(Persistence, { root: process.argv[1] + "/sessions", compression: "none" });
          const session = ctx.sessions.create("old-associated-session", { meta: { cwd: process.argv[3] } });
          const event = session.append("user/message", createUserMessage({ content: [{ type: "text", text: process.argv[2] }], source: { kind: "user" } }), { surfaceOp: "append" });
          const handle = await ctx.sessionPersistence.create(session.header);
          try { await handle.append([event]); await handle.flush(); } finally { await handle.close(); }
        } finally { await ctx.fiber.dispose(); }
      `, historyRoot, "Old associated private message " + applicationId, sessionCwd], { cwd: path.join(root, "package/runtime/server"), env: { ...process.env, NODE_PATH: "" }, timeout: 10000 });
    }
    console.info("Upgrade phase: stop released");
    await stopOld();
    console.info("Upgrade phase: current start");
    current = await buildServer({ env, webRoot: path.resolve(__dirname, "../../../web/out") });
    await current.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${current.addresses()[0].port}`;
    await verifyApplication(url, applicationUrl, "old-application-content", "upgraded");
    await verifySourceFree(url, "upgraded");
    const recovered = await (await api(url, "/api/agent/sessions?providerId=upgrade-provider")).text();
    expect(recovered).toContain("old-associated-session");
    const platformHistory = await (await api(url, "/api/agent/sessions/old-associated-session?providerId=upgrade-provider")).text();
    expect(platformHistory).toContain("Old associated private message platform");
    expect(platformHistory).not.toContain("Old associated private message upgrade-owner/upgrade-app");
    const applicationQuery = "providerId=upgrade-provider&appId=" + encodeURIComponent("upgrade-owner/upgrade-app");
    expect(await (await api(url, "/api/agent/sessions?" + applicationQuery)).text()).toContain("old-associated-session");
    const applicationHistory = await (await api(url, "/api/agent/sessions/old-associated-session?" + applicationQuery)).text();
    expect(applicationHistory).toContain("Old associated private message upgrade-owner/upgrade-app");
    expect(applicationHistory).not.toContain("Old associated private message platform");
    expect(await (await api(url, `/api/development/projects/${oldProject.id}/agent/sessions`)).text()).toContain("old-associated-session");
    const developerHistory = await (await api(url, `/api/development/projects/${oldProject.id}/agent/history?sessionId=old-associated-session`)).text();
    expect(developerHistory).toContain("Old associated private message developer");
    expect(developerHistory).not.toContain("Old associated private message platform");
    expect(developerHistory).not.toContain("Old associated private message upgrade-owner/upgrade-app");
    for (const scope of ["platform", "upgrade-owner/upgrade-app", "developer"]) {
      const prefix = scope === "developer" ? `/api/development/projects/${oldProject.id}/native/upgrade-provider/api/session/` : "/api/agent/native/" + Buffer.from(JSON.stringify({ appId: scope, providerId: "upgrade-provider" })).toString("base64url") + "/api/session/";
      const nativePage = await (await api(url, prefix + "page", "POST", { type: "client-request", rpcId: "upgrade-page", method: "session/page", payload: { args: { request: { address: { kind: "session", sessionId: "old-associated-session" }, throughSeq: 0 } } } })).json();
      expect(nativePage.result.ok, JSON.stringify(nativePage)).toBe(true);
      expect(JSON.stringify(nativePage)).toContain("Old associated private message " + scope);
      for (const foreign of ["platform", "upgrade-owner/upgrade-app", "developer"].filter(value => value !== scope)) expect(JSON.stringify(nativePage)).not.toContain("Old associated private message " + foreign);
      const marker = "Continue old associated session " + scope;
      const accepted = await (await api(url, prefix + "prompt", "POST", {
        type: "client-request", rpcId: "upgrade-prompt", method: "session/prompt",
        payload: { args: { request: { sessionId: "old-associated-session", requestId: "upgrade-continuation-" + scope,
          mode: "queue", content: [{ type: "text", text: marker }] } } },
      })).json();
      expect(accepted.result.value, JSON.stringify(accepted)).toEqual({ accepted: true });
      const socket = new WebSocket(url.replace("http:", "ws:") + prefix.replace(/session\/$/, "remote.mux"), { headers: { "X-API-Key": key } });
      try {
        const trajectory = await new Promise<string>((resolve, reject) => {
          let records = "";
          const timer = setTimeout(() => reject(new Error("Old session continuation trajectory timed out: " + records)), 5000);
          socket.once("error", error => { clearTimeout(timer); reject(error); });
          socket.on("message", frame => {
            records += frame.toString();
            if (records.includes("upgrade-model-reply")) { clearTimeout(timer); resolve(records); }
          });
          socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "upgrade-follow", endpoint: "session/follow",
            payload: { args: { request: { address: { kind: "session", sessionId: "old-associated-session" } } } } })));
        });
        expect(trajectory).toContain(marker);
        expect(trajectory).toContain("Old associated private message " + scope);
      } finally { socket.terminate(); }
      const continued = requests.find(request => JSON.stringify(request.messages).includes(marker));
      expect(continued?.authorization).toBe("Bearer upgrade-model-secret");
      expect(JSON.stringify(continued.messages)).toContain("Old associated private message " + scope);
      for (const foreign of ["platform", "upgrade-owner/upgrade-app", "developer"].filter(value => value !== scope)) {
        expect(JSON.stringify(continued.messages)).not.toContain("Old associated private message " + foreign);
      }
    }
    expect(await databaseValue(installed.ownerId)).toBe("old-application-data");
    await install(url, await applicationPackage("2.0.0", "plugin-application-content"));
    await verifyApplication(url, applicationUrl, "plugin-application-content", "plugin-install");
    expect(await databaseValue(installed.ownerId)).toBe("old-application-data");
    const settings = await (await api(url, "/api/agent/settings")).json();
    expect(settings.data.defaultProviderId).toBe("upgrade-provider");
    const peers = (await (await api(url, "/api/peers")).json()).data;
    expect(peers).toEqual([expect.objectContaining({ id: oldPeer.id, name: "upgrade-peer" })]);
    expect(new PeerStore(new SecretBox(path.join(directory, "master.key"))).loadCredential(oldPeer.id)).toBe("upgrade-peer-secret");

    expect(JSON.stringify(settings)).not.toContain("upgrade-model-secret");
    expect(await (await api(url, "/api/agent/run", "POST", { ...input, prompt: "plugin-version-message" })).text()).toContain("upgrade-model-reply");
    expect(requests.at(-1).authorization).toBe("Bearer upgrade-model-secret");
    expect(JSON.stringify(requests.at(-1).messages)).toContain("plugin-version-message");
    console.info("Upgrade phase: current close");
    await current.close(); current = undefined; closeMetaDb();
    console.info("Upgrade phase: rollback start");
    const rollback = await launch();
    await verifyApplication(rollback.url, applicationUrl, "plugin-application-content", "rollback");
    await verifySourceFree(rollback.url, "rollback");
    expect(await databaseValue(installed.ownerId)).toBe("old-application-data");
    const restored = await (await api(rollback.url, "/api/agent/settings")).json();
    expect(restored.data.defaultProviderId).toBe("upgrade-provider");
    expect(JSON.stringify(restored)).not.toContain("upgrade-model-secret");
    expect((await (await api(rollback.url, "/api/peers")).json()).data).toEqual([expect.objectContaining({ id: oldPeer.id, name: "upgrade-peer" })]);

  } finally {
    await current?.close(); closeMetaDb();
    await stopOld();
    await new Promise<void>(resolve => model.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60000);
