import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, getAppUrl, getTestApiKey, createTestPage } from "./helpers.js";
import { BOOTSTRAP_USER_ID } from "../../src/lib/meta-sqlite.js";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";

/**
 * Tests the server-side API sequence that the `localapp init` command performs:
 * 1. GET /api/config → get templateRepoUrl
 * 2. POST /api/pages → register page
 * 3. POST /api/upload → upload built files
 *
 * This validates the full init flow's server interactions without needing
 * git, npm, or the CLI binary.
 */
describe("init flow (server-side API sequence)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let dataDir: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const server = await createTestServer();
    app = server.app;
    baseUrl = getAppUrl(app);
    dataDir = server.dataDir;
    stop = server.stop;
  });

  afterAll(async () => { await stop(); });

  it("GET /api/config 返回 templateRepoUrl", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { "X-API-Key": getTestApiKey() },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.templateRepoUrl).toBeDefined();
    expect(typeof json.templateRepoUrl).toBe("string");
  });

  it("完整 init 流程：config → register → upload → verify", async () => {
    const pageName = "init-flow-test";

    // Step 1: GET /api/config (simulates init fetching template URL)
    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: { "X-API-Key": getTestApiKey() },
    });
    expect(configRes.status).toBe(200);

    // Step 2: POST /api/pages (simulates init registering the page)
    const pageRes = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers: {
        "X-API-Key": getTestApiKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: pageName }),
    });
    expect(pageRes.status).toBe(200);
    const pageJson = await pageRes.json();
    expect(pageJson.success).toBe(true);
    expect(pageJson.data.name).toBe(pageName);
    expect(pageJson.data.url).toBe(`/${BOOTSTRAP_USER_ID}/${pageName}/`);
    expect(pageJson.data.rawUrl).toBe(`/serve/${BOOTSTRAP_USER_ID}/${pageName}/`);

    // Step 3: POST /api/upload (simulates init uploading built files)
    const boundary = "----InitFlowTest";
    const fileContent = "<html><body>Init flow test</body></html>";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="name"\r\n\r\n${pageName}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="description"\r\n\r\nTest page from init flow\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="filepath_0"\r\n\r\nindex.html\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="index.html"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${fileContent}\r\n` +
      `--${boundary}--\r\n`;

    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: {
        "X-API-Key": getTestApiKey(),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    expect(uploadRes.status).toBe(200);
    const uploadJson = await uploadRes.json();
    expect(uploadJson.success).toBe(true);
    expect(uploadJson.data.name).toBe(pageName);
    expect(uploadJson.data.url).toBe(`${baseUrl}/${BOOTSTRAP_USER_ID}/${pageName}/`);
    expect(uploadJson.data.rawUrl).toBe(`${baseUrl}/serve/${BOOTSTRAP_USER_ID}/${pageName}/`);
    expect(uploadJson.data.version).toBe(1);

    // Step 4: Verify page is accessible
    const serveRes = await fetch(`${baseUrl}/serve/${BOOTSTRAP_USER_ID}/${pageName}/index.html`);
    expect(serveRes.status).toBe(200);
    const html = await serveRes.text();
    expect(html).toBe(fileContent);
  });

  it("页面注册重复名称返回 409", async () => {
    const pageName = "init-dup-test";
    await createTestPage(app, BOOTSTRAP_USER_ID, pageName);

    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers: {
        "X-API-Key": getTestApiKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: pageName }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("already exists");
  });

  it("上传到不存在的页面返回 404", async () => {
    const boundary = "----NotFoundTest";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="name"\r\n\r\nnonexistent-page\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="filepath_0"\r\n\r\nindex.html\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="index.html"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n<html></html>\r\n` +
      `--${boundary}--\r\n`;

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: {
        "X-API-Key": getTestApiKey(),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("not found");
  });

  it("init 流程带 dbConfig 和 shellConfig", async () => {
    const pageName = "init-config-test";

    // Register page
    await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers: {
        "X-API-Key": getTestApiKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: pageName }),
    });

    // Upload with dbConfig and shellConfig
    const boundary = "----ConfigTest";
    const fileContent = "<html><body>Config test</body></html>";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="name"\r\n\r\n${pageName}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="dbConfig"\r\n\r\n{"mode":"crud"}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="shellConfig"\r\n\r\n{"navbar":false}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="filepath_0"\r\n\r\nindex.html\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="index.html"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${fileContent}\r\n` +
      `--${boundary}--\r\n`;

    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: {
        "X-API-Key": getTestApiKey(),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    expect(uploadRes.status).toBe(200);
    const uploadJson = await uploadRes.json();
    expect(uploadJson.success).toBe(true);

    // Verify meta.json has db and shell config
    const metaPath = path.join(dataDir, BOOTSTRAP_USER_ID, pageName, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.db).toEqual({ mode: "crud" });
    expect(meta.shell).toEqual({ navbar: false });

    // Verify native shell behavior: navbar=false no longer redirects.
    const serveRes = await fetch(`${baseUrl}/${BOOTSTRAP_USER_ID}/${pageName}`, {
      redirect: "manual",
    });
    expect(serveRes.status).toBe(200);
    const html = await serveRes.text();
    expect(html).toContain("data-localapp-native-shell");
    expect(html).toContain("data-localapp-app-root");
    expect(html).not.toContain("<iframe");
  });
});
