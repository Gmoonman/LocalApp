// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
// @ts-ignore - .mjs file has no type declarations
import { localapp } from "@localapp/app-kit/vite";

describe("credential-injecting Vite proxy security", () => {
  let backend: http.Server | undefined;
  let vite: ViteDevServer | undefined;
  let projectDir = "";

  afterEach(async () => {
    await vite?.close();
    await new Promise<void>((resolve) => backend?.close(() => resolve()) ?? resolve());
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("blocks hostile unsafe requests and permits a browser-bound same-origin request", async () => {
    const backendRequests: Array<{ path: string; apiKey?: string }> = [];
    backend = http.createServer((req, res) => {
      backendRequests.push({
        path: req.url ?? "",
        apiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise<void>((resolve, reject) => {
      backend!.once("error", reject);
      backend!.listen(Number(process.env.LOCALAPP_TEST_BACKEND_PORT || 0), "127.0.0.1", resolve);
    });
    const backendAddress = backend.address();
    if (!backendAddress || typeof backendAddress === "string") throw new Error("backend did not listen on TCP");

    const tmpRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(tmpRoot, { recursive: true });
    projectDir = fs.mkdtempSync(path.join(tmpRoot, "vite-proxy-security-"));
    fs.mkdirSync(path.join(projectDir, "src"));
    fs.writeFileSync(path.join(projectDir, "index.html"), '<main>security fixture</main>');
    fs.writeFileSync(path.join(projectDir, "src/App.tsx"), "export default function App(){ return null; }");

    const appPort = await freeLoopbackPort();
    const origin = `http://127.0.0.1:${appPort}`;
    const devConfig = {
      serverUrl: `http://127.0.0.1:${backendAddress.port}`,
      userId: "dev-user",
      pageName: "demo-app",
      appServerPort: appPort,
    };
    vite = await createViteServer({
      root: projectDir,
      configFile: false,
      logLevel: "silent",
      // @ts-ignore - LocalApp plugin accepts deterministic security material for tests.
      plugins: localapp({ command: "serve", devConfig, devApiKey: "proxy-admin-key", devCsrfToken: "a".repeat(64) }),
    });
    await vite.listen();

    const landing = await fetch(origin);
    expect(landing.status).toBe(200);
    const setCookie = landing.headers.get("set-cookie");
    expect(setCookie).toMatch(/localapp_dev_csrf=[a-f0-9]{64}/);
    const cookie = setCookie!.split(";", 1)[0];

    const hostile = await fetch(`${origin}/api/dev/data/reset`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(hostile.status).toBe(403);
    expect(backendRequests).toHaveLength(0);

    const missingOrigin = await fetch(`${origin}/api/dev/data/reset`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(missingOrigin.status).toBe(403);
    expect(backendRequests).toHaveLength(0);

    const allowed = await fetch(`${origin}/api/dev/data/reset`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin },
    });
    expect(allowed.status).toBe(200);
    expect(backendRequests).toEqual([
      { path: "/api/dev/data/reset", apiKey: "proxy-admin-key" },
    ]);
  }, 20_000);

  it("routes an overlapping application API through the scoped fallback", async () => {
    const backendRequests: Array<{ path: string; apiKey?: string }> = [];
    backend = http.createServer((req, res) => {
      backendRequests.push({
        path: req.url ?? "",
        apiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise<void>((resolve, reject) => {
      backend!.once("error", reject);
      backend!.listen(Number(process.env.LOCALAPP_TEST_BACKEND_PORT || 0), "127.0.0.1", resolve);
    });
    const backendAddress = backend.address();
    if (!backendAddress || typeof backendAddress === "string") throw new Error("backend did not listen on TCP");

    const tmpRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(tmpRoot, { recursive: true });
    projectDir = fs.mkdtempSync(path.join(tmpRoot, "vite-proxy-overlap-"));
    fs.mkdirSync(path.join(projectDir, "src"));
    fs.writeFileSync(path.join(projectDir, "index.html"), '<main>routing fixture</main>');
    fs.writeFileSync(path.join(projectDir, "src/App.tsx"), "export default function App(){ return null; }");

    const appPort = await freeLoopbackPort();
    const devConfig = {
      serverUrl: `http://127.0.0.1:${backendAddress.port}`,
      userId: "dev-user",
      pageName: "demo-app",
      appServerPort: appPort,
    };
    vite = await createViteServer({
      root: projectDir,
      configFile: false,
      logLevel: "silent",
      // @ts-ignore - LocalApp plugin accepts deterministic security material for tests.
      plugins: localapp({ command: "serve", devConfig, devApiKey: "proxy-admin-key", devCsrfToken: "b".repeat(64) }),
    });
    await vite.listen();

    const response = await fetch(`http://127.0.0.1:${appPort}/api/messages?limit=1`);
    expect(response.status).toBe(200);
    const globalWithQuery = await fetch(
      `http://127.0.0.1:${appPort}/api/issues?pagePath=${encodeURIComponent("dev-user/demo-app")}`,
    );
    expect(globalWithQuery.status).toBe(200);
    expect(backendRequests).toEqual([
      {
        path: "/serve/dev-user/demo-app/api/messages?limit=1",
        apiKey: "proxy-admin-key",
      },
      {
        path: "/api/issues?pagePath=dev-user%2Fdemo-app",
        apiKey: "proxy-admin-key",
      },
    ]);
  }, 20_000);
});

async function freeLoopbackPort(): Promise<number> {
  if (process.env.LOCALAPP_TEST_APP_PORT) return Number(process.env.LOCALAPP_TEST_APP_PORT);
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port probe did not listen on TCP");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
