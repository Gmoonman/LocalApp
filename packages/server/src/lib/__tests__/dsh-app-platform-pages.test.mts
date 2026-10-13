import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { registerApplicationPages } from "@localapp/dsh-app-platform/pages-routes";
import { registerApplicationInstall } from "@localapp/dsh-app-platform/install-routes";
import { registerApplicationShell } from "@localapp/dsh-app-platform/shell-routes";
import { registerApplicationResources } from "@localapp/dsh-app-platform/resource-routes";
import { handleApplicationNotification, type ApplicationNotificationRecord } from "@localapp/dsh-device-services/notify-handler";
import { expect, it } from "vitest";

it("hosts pages with injected identity and object storage", async () => {
  const dataDir = fs.mkdtempSync(path.resolve("../../tmp/platform-pages-"));
  const app = Fastify();
  const deleted: string[] = [];
  let userId = "owner";
  await registerApplicationPages(app, {
    dataDir, userId: () => userId,
    deleteAppObjects: async (owner, name) => { deleted.push(`${owner}/${name}`); },
  });
  await registerApplicationInstall(app, { dataDir, userId: () => userId, user: () => undefined });
  try {
    const created = await app.inject({ method: "POST", url: "/api/pages", payload: { name: "demo" } });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.url).toBe("/owner/demo/");
    expect((await app.inject({ method: "GET", url: "/api/me/apps/demo/versions" })).json().data.versions).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/me/apps/demo/versions/0/activate" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/pages", payload: { name: "demo" } })).statusCode).toBe(409);
    userId = "other";
    expect((await app.inject({ method: "GET", url: "/api/me/apps/demo/versions" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/pages" })).json().data).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: "/api/pages/demo" })).statusCode).toBe(404);
    expect(deleted).toEqual([]);
    userId = "owner";
    expect((await app.inject({ method: "DELETE", url: "/api/pages/demo" })).statusCode).toBe(200);
    expect(deleted).toEqual(["owner/demo"]);
    expect((await app.inject({ method: "GET", url: "/api/pages/demo" })).statusCode).toBe(404);
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

it("validates notifications before sending them to injected persistence", async () => {
  const app = Fastify();
  let visitor: string | undefined = "notification-owner";
  const records: ApplicationNotificationRecord[] = [];
  app.post("/notify", (request, reply) => handleApplicationNotification(request, reply, {
    name: "demo", userId: "notification-owner", description: "", currentVersion: 0,
    createdAt: "", updatedAt: "", versions: [], metadata: {},
  }, "notification-owner", "demo", {
    dataDir: () => path.resolve("../../tmp"), visitorId: () => visitor,
    resolveRecipients: () => ["subscriber"],
    persistNotifications: batch => { records.push(...batch); return [{ id: "notification-id" }]; },
  }));
  try {
    const headers = { host: "localhost", referer: "http://localhost/notification-owner/demo/" };
    const response = await app.inject({ method: "POST", url: "/notify", headers, payload: { title: "Update" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().ids).toEqual(["notification-id"]);
    expect(records[0].userId).toBe("subscriber");
    visitor = undefined;
    expect((await app.inject({ method: "POST", url: "/notify", headers, payload: { title: "Update" } })).statusCode).toBe(401);
    expect(records).toHaveLength(1);
  } finally { await app.close(); }
});

it("serves the formal application shell with access checks outside LocalApp Server", async () => {
  const dataDir = fs.mkdtempSync(path.resolve("../../tmp/platform-shell-"));
  const app = Fastify();
  let visitor: string | undefined = "owner";
  const views: unknown[] = [];
  await registerApplicationPages(app, { dataDir, userId: () => "owner", deleteAppObjects: async () => {} });
  const shellDir = path.join(dataDir, "web/platform-shell");
  fs.mkdirSync(shellDir, { recursive: true });
  fs.mkdirSync(path.join(shellDir, "placeholder"), { recursive: true });
  fs.writeFileSync(path.join(shellDir, "placeholder/placeholder.html"), "<html><body>application shell</body></html>");
  await registerApplicationShell(app, {
    webRoot: path.join(dataDir, "web"), dataDir: () => dataDir,
    visitorId: () => visitor, userId: () => visitor,
    verification: () => null, pushPageView: view => { views.push(view); },
  });
  await registerApplicationResources(app, {
    dataDir: () => dataDir, visitorId: () => visitor,
    validateApiKey: () => null, verification: () => null,
    handleApi: () => ({ success: true, from: "application-api" }),
  });
  try {
    await app.inject({ method: "POST", url: "/api/pages", payload: { name: "demo" } });
    await app.inject({ method: "PUT", url: "/api/pages/demo", payload: { pageAccess: { level: "owner" } } });
    const versionDir = path.join(dataDir, "owner/demo/versions/v0");
    fs.mkdirSync(path.join(versionDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(versionDir, ".localapp"), { recursive: true });
    fs.writeFileSync(path.join(versionDir, "index.html"), "application index");
    fs.writeFileSync(path.join(versionDir, "assets/app-12345678.js"), "application script");
    fs.writeFileSync(path.join(versionDir, ".localapp/secret.json"), "internal metadata");
    const response = await app.inject("/owner/demo");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-localapp-app-resource-base="/serve/owner/demo/"');
    expect((await app.inject("/serve/owner/demo/route")).body).toBe("application index");
    const asset = await app.inject("/serve/owner/demo/assets/app-12345678.js");
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect((await app.inject({ url: "/serve/owner/demo/assets/app-12345678.js", headers: { "if-none-match": String(asset.headers.etag) } })).statusCode).toBe(304);
    expect((await app.inject("/serve/owner/demo/.localapp/secret.json")).statusCode).toBe(404);
    expect((await app.inject("/serve/owner/demo/api/test")).json().from).toBe("application-api");
    visitor = undefined;
    expect((await app.inject("/owner/demo")).statusCode).toBe(401);
    expect((await app.inject("/serve/owner/demo/assets/app-12345678.js")).statusCode).toBe(401);
    visitor = "other";
    expect((await app.inject("/owner/demo")).statusCode).toBe(403);
    expect(views).toHaveLength(1);
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
