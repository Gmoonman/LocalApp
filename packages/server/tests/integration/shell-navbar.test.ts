import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, getAppUrl, getTestApiKey, createTestPage } from "./helpers.js";
import { BOOTSTRAP_USER_ID } from "../../src/lib/meta-sqlite.js";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";

describe("shell navbar config", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let dataDir: string;
  let stop: () => Promise<void>;
  const pageOwner = BOOTSTRAP_USER_ID;
  const pageWithNavbar = "with-navbar";
  const pageWithoutNavbar = "no-navbar";

  beforeAll(async () => {
    const server = await createTestServer();
    app = server.app;
    baseUrl = getAppUrl(app);
    dataDir = server.dataDir;
    stop = server.stop;

    await createTestPage(app, pageOwner, pageWithNavbar);
    await createTestPage(app, pageOwner, pageWithoutNavbar);

    const metaPath = path.join(dataDir, pageOwner, pageWithoutNavbar, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    meta.shell = { navbar: false };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  });

  afterAll(async () => { await stop(); });

  it("upload stores shellConfig={navbar:false} in meta.json", async () => {
    const uploadPage = "shell-upload-test";
    await createTestPage(app, pageOwner, uploadPage);

    const boundary = "----TestBoundary";
    const fileContent = "<html><body>test</body></html>";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="name"\r\n\r\n${uploadPage}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="shellConfig"\r\n\r\n{"navbar":false}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="filepath_0"\r\n\r\nindex.html\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="index.html"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${fileContent}\r\n` +
      `--${boundary}--\r\n`;

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: {
        "X-API-Key": getTestApiKey(),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    const metaPath = path.join(dataDir, pageOwner, uploadPage, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.shell).toEqual({ navbar: false });
  });

  it("returns native shell for navbar=false pages instead of redirecting to shell-less iframe page", async () => {
    const res = await fetch(`${baseUrl}/${pageOwner}/${pageWithoutNavbar}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("data-localapp-native-shell");
    expect(html).not.toContain("<iframe");
  });

  it("returns native shell HTML for pages without shell config", async () => {
    const res = await fetch(`${baseUrl}/${pageOwner}/${pageWithNavbar}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("_next/static/chunks");
    expect(html).toContain(pageWithNavbar);
    expect(html).toContain("data-localapp-native-shell");
    expect(html).not.toContain("<iframe");
  });
});
