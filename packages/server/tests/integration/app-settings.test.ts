import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAndLogin } from "../helpers/createUser.js";
import { createTestPage, createTestServer, getAppUrl } from "./helpers.js";

describe("application owner settings API", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let dataDir: string;
  let stop: () => Promise<void>;
  let ownerCookie: string;
  let otherCookie: string;
  const owner = "settingsowner";
  const pageName = "settings-app";

  beforeAll(async () => {
    const server = await createTestServer();
    app = server.app;
    baseUrl = getAppUrl(app);
    dataDir = server.dataDir;
    stop = server.stop;
    ownerCookie = await registerAndLogin(baseUrl, owner);
    otherCookie = await registerAndLogin(baseUrl, "settingsother");
    await createTestPage(app, owner, pageName);
    const pageDir = path.join(dataDir, owner, pageName);
    fs.writeFileSync(path.join(pageDir, "manifest.json"), JSON.stringify({
      name: pageName,
      description: "source description",
      shell: { navbar: true },
      db: { mode: "crud", defaultAccess: { read: "public" } },
    }));
  });

  afterAll(async () => {
    await stop();
  });

  it("returns metadata and all manifest views to the owner", async () => {
    const response = await fetch(`${baseUrl}/api/me/pages/${pageName}/settings`, {
      headers: { Cookie: ownerCookie },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        app: { name: pageName, userId: owner, currentVersion: 1 },
        sourceKind: "uploaded",
        sourceManifest: { description: "source description" },
        platformManifest: {},
        effectiveManifest: { description: "source description" },
        platformEditableKeys: ["description", "pageAccess", "shell", "db", "notify", "lifecycle"],
      },
    });
  });

  it("rejects unauthenticated and non-owner access without leaking settings", async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/me/pages/${pageName}/settings`);
    expect(unauthenticated.status).toBe(401);

    const forbidden = await fetch(`${baseUrl}/api/me/pages/${pageName}/settings`, {
      headers: { Cookie: otherCookie },
    });
    expect(forbidden.status).toBe(404);
    await expect(forbidden.json()).resolves.toMatchObject({
      success: false,
      code: "APP_NOT_FOUND",
    });
  });

  it("saves a validated platform manifest and materializes effective metadata", async () => {
    const response = await fetch(`${baseUrl}/api/me/pages/${pageName}/settings/manifest-platform`, {
      method: "PUT",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "platform description",
        pageAccess: { level: "owner" },
        shell: { navbar: false },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        platformManifest: { description: "platform description" },
        effectiveManifest: {
          description: "platform description",
          shell: { navbar: false },
          db: { mode: "crud" },
        },
      },
    });

    const pageDir = path.join(dataDir, owner, pageName);
    expect(JSON.parse(fs.readFileSync(path.join(pageDir, "manifest.platform.json"), "utf8"))).toMatchObject({
      description: "platform description",
      pageAccess: { level: "owner" },
    });
    expect(JSON.parse(fs.readFileSync(path.join(pageDir, "meta.json"), "utf8"))).toMatchObject({
      description: "platform description",
      pageAccess: { level: "owner" },
      shell: { navbar: false },
    });
  });

  it("round-trips the Agent conversation switch through settings and public page metadata", async () => {
    const current = await (await fetch(`${baseUrl}/api/me/pages/${pageName}/settings`, { headers: { Cookie: ownerCookie } })).json();
    for (const enabled of [false, true]) {
      const response = await fetch(`${baseUrl}/api/me/pages/${pageName}/settings/manifest-platform`, {
        method: "PUT", headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ ...current.data.platformManifest, shell: { navbar: false, agentConversation: enabled } }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: {
        platformManifest: { shell: { agentConversation: enabled } },
        effectiveManifest: { shell: { agentConversation: enabled } },
      } });
      const settings = await fetch(`${baseUrl}/api/me/pages/${pageName}/settings`, { headers: { Cookie: ownerCookie } });
      expect(await settings.json()).toMatchObject({ data: { platformManifest: { shell: { agentConversation: enabled } } } });
      const metadata = await fetch(`${baseUrl}/api/pages/${owner}/${pageName}/meta`, { headers: { Cookie: ownerCookie } });
      expect(await metadata.json()).toMatchObject({ data: { shell: { agentConversation: enabled } } });
    }
    const response = await fetch(`${baseUrl}/api/me/pages/${pageName}/settings/manifest-platform`, {
      method: "PUT", headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ shell: { agentConversation: "false" } }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects unsafe platform fields without changing the persisted manifest", async () => {
    const pageDir = path.join(dataDir, owner, pageName);
    const before = fs.readFileSync(path.join(pageDir, "manifest.platform.json"), "utf8");
    const response = await fetch(`${baseUrl}/api/me/pages/${pageName}/settings/manifest-platform`, {
      method: "PUT",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ backend: { root: "backend" } }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "PLATFORM_MANIFEST_FIELD_FORBIDDEN",
      field: "backend",
    });
    expect(fs.readFileSync(path.join(pageDir, "manifest.platform.json"), "utf8")).toBe(before);
  });

  it("lets only the owner take an app offline and bring it online without replacing other platform settings", async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/me/pages/${pageName}/lifecycle`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "offline" }),
    });
    expect(unauthenticated.status).toBe(401);

    const forbidden = await fetch(`${baseUrl}/api/me/pages/${pageName}/lifecycle`, {
      method: "PUT",
      headers: { Cookie: otherCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "offline" }),
    });
    expect(forbidden.status).toBe(404);

    const offline = await fetch(`${baseUrl}/api/me/pages/${pageName}/lifecycle`, {
      method: "PUT",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "offline" }),
    });
    expect(offline.status).toBe(200);
    await expect(offline.json()).resolves.toMatchObject({
      success: true,
      data: {
        app: { lifecycleStatus: "offline" },
        platformManifest: {
          description: "platform description",
          lifecycle: { status: "offline" },
        },
      },
    });

    const settingsWhileOffline = await fetch(`${baseUrl}/api/me/pages/${pageName}/settings`, {
      headers: { Cookie: ownerCookie },
    });
    expect(settingsWhileOffline.status).toBe(200);
    await expect(settingsWhileOffline.json()).resolves.toMatchObject({
      data: { app: { lifecycleStatus: "offline" } },
    });

    const invalid = await fetch(`${baseUrl}/api/me/pages/${pageName}/lifecycle`, {
      method: "PUT",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: "APP_LIFECYCLE_STATUS_INVALID" });

    const pageDir = path.join(dataDir, owner, pageName);
    expect(JSON.parse(fs.readFileSync(path.join(pageDir, "manifest.platform.json"), "utf8"))).toMatchObject({
      lifecycle: { status: "offline" },
    });

    const online = await fetch(`${baseUrl}/api/me/pages/${pageName}/lifecycle`, {
      method: "PUT",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "online" }),
    });
    expect(online.status).toBe(200);
    await expect(online.json()).resolves.toMatchObject({
      data: { app: { lifecycleStatus: "online" } },
    });
  });
});
