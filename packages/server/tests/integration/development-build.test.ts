import fs from "node:fs";
import path from "node:path";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { createTestServer } from "./helpers.js";
import { registerAndLogin } from "../helpers/createUser.js";
import { templateSource } from "../../src/lib/development/template.js";
import { ProjectStore } from "../../src/lib/development/projects.js";
let server: Awaited<ReturnType<typeof createTestServer>>, cookie: string;
beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "production");
  server = await createTestServer({
    dataRoot: path.resolve(
      __dirname,
      "../../../../tmp/platform-development/build-integration",
    ),
  });
  cookie = await registerAndLogin(server.baseUrl, "builder");
}, 30000);
afterAll(async () => { await server?.stop(); vi.unstubAllEnvs(); });
it("runs real isolated build scripts and produces a portable package", async () => {
  const store = new ProjectStore(server.dataDir);
  const p = store.create("builder", "built-app", {
    ...templateSource("built-app"),
    "manifest.json": JSON.stringify({
      name: "built-app",
      distDir: "dist",
      platformVersion: "^1.2",
      db: { mode: "crud", sqlAccess: "authenticated" },
      backend: { root: "backend" },
      requires: {
        backend: "named-sql",
        identity: ["currentUser", "pageOwner"],
        primitives: [],
      },
    }),
    "package.json": JSON.stringify({
      name: "built-app",
      version: "0.0.1",
      scripts: {
        test: "node -e \"if(process.env.NODE_ENV!=='test')throw Error('tests require NODE_ENV=test');if(require('fs').existsSync('../executor/application-prompt.json'))process.exit(9)\"",
        build:
          "node -e \"if(process.env.NODE_ENV!=='production')throw Error('build requires NODE_ENV=production');require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','<h1>Development preview marker</h1>')\"",
      },
    }),
  });
  const api = (url: string, body?: unknown) =>
    fetch(server.baseUrl + `/api/development/projects/${p.id}` + url, {
      method: body ? "POST" : "GET",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const started = await api("/builds", {});
  expect(started.status).toBe(200);
  const id = (await started.json()).data.id;
  let b: any;
  for (let i = 0; i < 100; i++) {
    b = (await (await api(`/builds/${id}`)).json()).data;
    if (!["queued", "running"].includes(b.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(b.status, b.log).toBe("succeeded");
  expect(b.sha256).toMatch(/^[a-f0-9]{64}$/);
  const preview = await api("/previews", { buildId: id });
  expect(preview.status).toBe(200);
  const previewUrl = new URL((await preview.json()).data.url);
  const open = await server.app.inject({
    url: previewUrl.pathname + previewUrl.search,
    headers: { host: previewUrl.host },
  });
  expect(open.statusCode).toBe(302);
  expect(String(open.headers["set-cookie"])).toContain("SameSite=None");
  expect(String(open.headers["set-cookie"])).toContain("Secure");
  expect(String(open.headers["set-cookie"])).toContain("Partitioned");
  const unknownHost = await server.app.inject({
    url: "/api/me",
    headers: { host: "preview00000000000000000000000000000000.localhost" },
  });
  expect(unknownHost.statusCode).toBe(404);
  const previewCookie = String(open.headers["set-cookie"]).split(";")[0];
  const denied = await server.app.inject({
    url: "/api/development/projects",
    headers: { host: previewUrl.host, cookie: previewCookie },
  });
  expect(denied.statusCode).toBe(403);
  const replay = await server.app.inject({
    url: previewUrl.pathname + previewUrl.search,
    headers: { host: previewUrl.host },
  });
  expect(replay.statusCode).toBe(401);
  const meta = await server.app.inject({
    url: `/api/pages/${open.headers.location!.split("/")[1]}/built-app/meta`,
    headers: { host: previewUrl.host, cookie: previewCookie },
  });
  expect(meta.json().data.lifecycleStatus).toBe("online");
  expect(meta.json().data.developmentPreview).toBe(true);
  const raw = open.headers.location!.replace(/^\//, "/serve/");
  const resource = await server.app.inject({
    url: raw,
    headers: { host: previewUrl.host, cookie: previewCookie },
  });
  expect(resource.statusCode, resource.body).toBe(200);
  expect(resource.body).toContain("Development preview marker");
  const previewApi = (operation: string, params: unknown) =>
    server.app.inject({
      method: "POST",
      url: raw.replace(/\/$/, "") + "/api/" + operation,
      headers: { host: previewUrl.host, cookie: previewCookie },
      payload: { params },
    });
  const initial = await previewApi("queries/$work_items.count", {});
  expect(initial.json().data.rows[0].count).toBe(0);
  const created = await previewApi("mutations/$work_items.create", {
    title: "Only in preview",
    status: "todo",
  });
  expect(created.statusCode, created.body).toBe(200);
  expect(
    (await previewApi("queries/$work_items.count", {})).json().data.rows[0]
      .count,
  ).toBe(1);
  const release = await api("/releases", {
    buildId: id,
    expectedVersion: 0,
    idempotencyKey: id,
  });
  expect(release.status).toBe(200);
  const published = (await release.json()).data;
  expect(published.url).toBe("/builder/built-app/");
  const formalCount = await server.app.inject({
    method: "POST",
    url: "/serve/builder/built-app/api/queries/$work_items.count",
    headers: { cookie },
    payload: { params: {} },
  });
  expect(formalCount.json().data.rows[0].count).toBe(0);
  const repeat = await api("/releases", {
    buildId: id,
    expectedVersion: 0,
    idempotencyKey: id,
  });
  expect(repeat.status).toBe(200);
  const conflict = await api("/releases", {
    buildId: id,
    expectedVersion: 0,
    idempotencyKey: "another",
  });
  expect(conflict.status).toBe(409);
}, 60000);
it("allows compile-only previews but refuses publication and retains full test failures", async () => {
 const p = new ProjectStore(server.dataDir).create("builder", "preview-only", {
  ...templateSource("preview-only"),
  "package.json": JSON.stringify({name: "preview-only", version: "0.0.1", scripts: {test: "node -e \"process.exit(17)\"", build: "node -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','<h1>Preview</h1>')\""}}),
 });
 const api = (url: string, body?: unknown) => fetch(server.baseUrl + `/api/development/projects/${p.id}${url}`, {method: body ? "POST" : "GET", headers: {Cookie: cookie, "Content-Type": "application/json"}, ...(body ? {body: JSON.stringify(body)} : {})});
 const build = async (purpose: string) => {
  const response = await api("/builds", {purpose}); expect(response.status).toBe(200); const id = (await response.json()).data.id;
  for (let i = 0; i < 200; i++) {const b = (await (await api(`/builds/${id}`)).json()).data; if (!["queued", "running"].includes(b.status)) return b; await new Promise(r => setTimeout(r, 100));}
  throw new Error("build timed out");
 };
 const preview = await build("preview"); expect(preview.status, preview.log).toBe("succeeded"); expect(preview.purpose).toBe("preview");
 expect((await api("/previews", {buildId: preview.id})).status).toBe(200);
 expect((await api("/releases", {buildId: preview.id, expectedVersion: 0, idempotencyKey: preview.id})).status).toBe(400);
 const release = await build("release"); expect(release.status).toBe("failed");
 expect(release.log).toContain("npm run test");
 expect(JSON.parse(new ProjectStore(server.dataDir).read(p.id, "builder", "package.json").content).scripts.test).toContain("17");
}, 60000);
