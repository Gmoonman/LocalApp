import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, getAppUrl } from "./helpers.js";
import { registerAndLogin } from "../helpers/createUser.js";
import type { FastifyInstance } from "fastify";

describe("admin serve routes (deprecated)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const server = await createTestServer();
    app = server.app;
    baseUrl = getAppUrl(app);
    stop = server.stop;
  });

  afterAll(async () => {
    await stop();
  });

  it("/admin returns 404 after the route was removed", async () => {
    const res = await fetch(`${baseUrl}/admin`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });

  it("/admin/assets/* returns 404 after admin static assets were removed", async () => {
    const res = await fetch(`${baseUrl}/assets/nonexistent.js`);
    expect(res.status).toBe(404);
  });

  it("ordinary users cannot fetch admin /my RSC payloads", async () => {
    const cookie = await registerAndLogin(baseUrl, "testuser");

    const res = await fetch(`${baseUrl}/my/settings.txt?_rsc=1`, {
      headers: { cookie },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("rejects encoded personal page paths before reading static files", async () => {
    const cookie = await registerAndLogin(baseUrl, "encodedpageuser");
    for (const pathname of [
      "/my/%73ettings.txt",
      "/my/apps%2fplaceholder%2fsettings.txt",
      "/my/apps%5cplaceholder%5csettings.txt",
    ]) {
      const response = await fetch(`${baseUrl}${pathname}?_rsc=1`, {
        headers: { cookie }, redirect: "manual",
      });
      expect(response.status, pathname).toBe(404);
    }
  });
});
