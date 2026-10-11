import { expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { buildServer } from "../../src/server.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import { getDb, closeMetaDb, createApiKey } from "../../src/lib/meta-sqlite.js";
import { AgentSettingsStore } from "../../src/lib/agent-settings.js";

it.each(["platform", "multiuser"] as const)("boots the unified Server without development contributions in %s mode", async combination => {
  const parent = path.resolve(__dirname, "../../../../tmp/plugin-combination-server");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "platform-"));
  const app = await buildServer({ env: { DATA_DIR: root, LISTEN_PORT: "0", JWT_SECRET: "plugin-combination-test-secret", LOCALAPP_PLUGIN_COMBINATION: combination } });
  try {
    await app.ready();
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/system/plugins" })).json().data).toEqual({ combination, multiuser: true, applications: combination === "platform", development: false });
    for (const url of ["/api/config", "/api/development/creations", "/api/workspaces", "/api/tasks", "/api/system/development-environment"]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
    const tablesForCombination = getDb().exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0].values.flat();
    for (const table of ["workspaces", "tasks", "development_projects"]) expect(tablesForCombination).not.toContain(table);
    if (combination === "multiuser") {
      const tables = getDb().exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0].values.flat();
      expect(tables).toEqual(expect.arrayContaining(["users", "groups", "api_keys", "auth_sessions"]));
      for (const table of ["peers", "favorites", "notifications", "workspaces", "tasks"]) expect(tables).not.toContain(table);
      expect((await app.inject({ url: "/api/admin/apps" })).statusCode).toBe(404);
      expect((await app.inject({ url: "/api/pages" })).statusCode).toBe(404);
      expect((await app.inject({ url: "/owner/application/" })).statusCode).toBe(404);
    }
    expect((await app.inject({ url: "/api/keys" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/agent/settings" })).statusCode).toBe(401);
    await expect(fs.stat(path.join(root, "development"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await app.close(); closeMetaDb(); await fs.rm(root, { recursive: true, force: true }); }
});

it("installs and updates applications with business data while development is disabled", async () => {
  const parent = path.resolve(__dirname, "../../../../tmp/plugin-combination-server");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "application-"));
  const key = "platform-only-test-key";
  const tokens = new SetupTokenStore();
  const app = await buildServer({ setupTokens: tokens, env: { DATA_DIR: root, BOOTSTRAP_API_KEY: key, JWT_SECRET: "platform-test-secret", LOCALAPP_PLUGIN_COMBINATION: "platform" } });
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${app.addresses()[0].port}`;
    const setup = tokens.issue().token;
    const initialized = await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: setup, username: "platform-owner", password: "platform-only-password" } });
    expect(initialized.statusCode, initialized.body).toBe(201);
    const { writeAppPackage } = await import("../../src/lib/app-package.js");
    const template = path.resolve(__dirname, "../../../../init-repo");
    const files = await Promise.all(["migrations/001_work_items.sql", "backend/resources/work_items/schema.json", "backend/resources/work_items/queries.json", "backend/resources/work_items/mutations.json"].map(async file => ({ path: file, content: await fs.readFile(path.join(template, file)) })));
    for (const version of ["1.0.0", "2.0.0"]) {
      const archive = path.join(root, version + ".localapp");
      await writeAppPackage({ outputPath: archive, metadata: { schemaVersion: 1, appId: "platform-app", version, platformVersion: "^1.2" }, files: [
        ...files,
        { path: "manifest.json", content: Buffer.from(JSON.stringify({ name: "platform-app", distDir: "dist", platformVersion: "^1.2", db: { mode: "crud", sqlAccess: "authenticated" }, backend: { root: "backend" }, requires: { backend: "named-sql", identity: ["currentUser", "pageOwner"], primitives: [] } })) },
        { path: "dist/index.html", content: Buffer.from(`<div id="root"></div><script type="module" src="./assets/main.js"></script>`) },
        { path: "dist/assets/main.js", content: Buffer.from(`document.getElementById('root').textContent='Platform application ${version}';`) },
      ] });
      const form = new FormData(); form.append("package", new Blob([await fs.readFile(archive)]), "app.localapp");
      const installed = await fetch(url + "/api/me/apps/install", { method: "POST", headers: { "X-API-Key": key }, body: form });
      expect(installed.status, await installed.clone().text()).toBe(201);
      const entry = await app.inject({ url: "/platform-owner/platform-app/", headers: { "X-API-Key": key } });
      expect(entry.statusCode).toBe(200);
      expect(entry.body).toContain("data-localapp-app-resource-base");
      if (process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1") {
        const { chromium } = await import("@playwright/test");
        const browser = await chromium.launch({ channel: "chrome", headless: true });
        try {
          const page = await browser.newPage();
          const developmentRequests: string[] = [];
          page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/development/")) developmentRequests.push(request.url()); });
          expect((await page.request.post(url + "/api/auth/login", { data: { username: "platform-owner", password: "platform-only-password" } })).status()).toBe(200);
          const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
          await page.goto(url + "/platform-owner/platform-app/");
          await page.getByText("Platform application " + version, { exact: true }).waitFor({ timeout: 10000 });
          await page.getByRole("button", { name: "展开应用对话", exact: true }).waitFor({ timeout: 10000 });
          expect(await page.getByRole("button", { name: "展开开发对话", exact: true }).count()).toBe(0);
          await page.getByRole("button", { name: "切换历史对话", exact: true }).click();
          await page.getByRole("menu", { name: "应用历史对话" }).waitFor();
          expect(await page.getByRole("button", { name: "切换对话身份", exact: true }).count()).toBe(0);
          await page.keyboard.press("Escape");
          expect(developmentRequests).toEqual([]);
          expect(await page.getByText("Not Found", { exact: true }).count()).toBe(0);
          const evidence = path.join(parent, "browser-evidence"); await fs.mkdir(evidence, { recursive: true });
          await page.screenshot({ path: path.join(evidence, "platform-only-" + version + ".png"), fullPage: true });
          expect(errors).toEqual([]);
        } finally { await browser.close(); }
      }
      const query = await app.inject({ method: "POST", url: "/serve/platform-owner/platform-app/api/queries/$work_items.count", headers: { "X-API-Key": key }, payload: { params: {} } });
      expect(query.statusCode, query.body).toBe(200);
      expect(query.json().data.rows[0].count).toBe(version === "1.0.0" ? 0 : 1);
      if (version === "1.0.0") {
        const write = await app.inject({ method: "POST", url: "/serve/platform-owner/platform-app/api/mutations/$work_items.create", headers: { "X-API-Key": key }, payload: { params: { title: "Preserved after update", status: "todo" } } });
        expect(write.statusCode, write.body).toBe(200);
      }
    }
    expect((await app.inject("/api/development/creations")).statusCode).toBe(404);
    await expect(fs.stat(path.join(root, "development"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await app.close(); closeMetaDb(); await fs.rm(root, { recursive: true, force: true }); }
}, 30000);

it("preserves account and application records across plugin combination restarts", async () => {
  const parent = path.resolve(__dirname, "../../../../tmp/plugin-combination-server");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "restart-"));
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  let projectId = "", apiKey = "";
  try {
    for (const combination of ["full", "platform", "multiuser", "full"] as const) {
      server = await buildServer({ env: { DATA_DIR: root, LISTEN_PORT: "0", JWT_SECRET: "combination-restart-secret", LOCALAPP_PLUGIN_COMBINATION: combination } });
      await server.ready();
      if (getDb().exec("SELECT id FROM users WHERE id = 'preserved-owner'").length === 0) {
        getDb().run("INSERT INTO users (id, name, password, auth_generation) VALUES ('preserved-owner', 'preserved-owner', 'test-only', 'original-generation')");
        getDb().run("INSERT INTO favorites (user_id, page_path, page_name) VALUES ('preserved-owner', '/preserved-owner/application/', 'Original application')");
        apiKey = createApiKey("preserved-owner").key;
        const created = await server.inject({ method: "POST", url: "/api/development/projects", headers: { "X-API-Key": apiKey }, payload: { name: "preserved-source-app" } });
        expect(created.statusCode, created.body).toBe(201);
        projectId = created.json().data.id;
        const saved = await server.inject({ method: "PUT", url: `/api/development/projects/${projectId}/file`, headers: { "X-API-Key": apiKey }, payload: { path: "src/preserved.txt", content: "source survives plugin changes", hash: null } });
        expect(saved.statusCode, saved.body).toBe(200);
        new AgentSettingsStore(root).write("preserved-owner", { providers: [], defaultProviderId: "", grants: { ["development:" + projectId]: ["files"] }, mcpServers: [], applications: { ["development:" + projectId]: { skills: [], disabledTools: ["write"], tools: [] } } });
      }
      expect(getDb().exec("SELECT auth_generation FROM users WHERE id = 'preserved-owner'")[0].values).toEqual([["original-generation"]]);
      expect(getDb().exec("SELECT page_path, page_name FROM favorites WHERE user_id = 'preserved-owner'")[0].values).toEqual([["/preserved-owner/application/", "Original application"]]);
      const settings = new AgentSettingsStore(root).read("preserved-owner");
      expect(settings.grants["development:" + projectId]).toEqual(["files"]);
      expect(settings.applications["development:" + projectId].disabledTools).toEqual(["write"]);
      const source = await server.inject({ url: `/api/development/projects/${projectId}/file?path=src%2Fpreserved.txt`, headers: { "X-API-Key": apiKey } });
      const configuration = await server.inject({url:"/api/config",headers:{"X-API-Key":apiKey}});
      expect(configuration.statusCode).toBe(combination === "full" ? 200 : 404);
      if(combination === "full") {
        expect(configuration.json()).toEqual({templateRepoUrl:server.config.templateRepoUrl,gitDownloadUrl:server.config.gitDownloadUrl || null});
      }
      expect(source.statusCode).toBe(combination === "full" ? 200 : 404);
      if (combination === "full") expect(source.json().data.content).toBe("source survives plugin changes");
      expect(await fs.readFile(path.join(root, "development", "projects", projectId, "workspace", "src", "preserved.txt"), "utf8")).toBe("source survives plugin changes");
      expect((await server.inject("/api/system/plugins")).json().data.applications).toBe(combination !== "multiuser");
      await server.close(); server = undefined;
      closeMetaDb();
    }
  } finally { await server?.close(); closeMetaDb(); await fs.rm(root, { recursive: true, force: true }); }
});

it("serves unavailable document skill settings when the document extension is omitted", async () => {
  const parent = path.resolve(__dirname, "../../../../tmp/plugin-combination-server");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "no-documents-"));
  const tokens = new SetupTokenStore();
  const app = await buildServer({ setupTokens: tokens, documents: false, pluginCombination: "multiuser", env: { DATA_DIR: root, BOOTSTRAP_API_KEY: "no-documents-test-key", JWT_SECRET: "no-documents-test-secret" } });
  try {
    await app.ready();
    const initialized = await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: tokens.issue().token, username: "documents-owner", password: "documents-test-password" } });
    expect(initialized.statusCode, initialized.body).toBe(201);
    const response = await app.inject({ url: "/api/agent/app-settings?appId=platform", headers: { "X-API-Key": "no-documents-test-key" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.skills).toHaveLength(4);
    expect(response.json().data.skills.every((skill: { available: boolean; unavailableReason?: string }) => !skill.available && skill.unavailableReason === "公共文档扩展尚未启用。")).toBe(true);
    expect(response.json().data.enabledSkills).toEqual([]);
  } finally { await app.close(); closeMetaDb(); await fs.rm(root, { recursive: true, force: true }); }
});
