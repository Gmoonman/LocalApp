import type { FastifyInstance } from "fastify";
import { closeMetaDb } from "../../src/lib/meta-sqlite.js";
import { buildServer } from "../../src/server.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_API_KEY = "test-api-key-1234567890abcdef";

export function getTestApiKey() {
  return TEST_API_KEY;
}

export interface CreateTestServerOptions {
  configToml?: string;
  env?: Record<string, string | undefined>;
  websocket?: boolean;
  cleanSetup?: boolean;
  webRoot?: string;
  dataRoot?: string;
}

export async function createTestServer(
  options?: CreateTestServerOptions,
): Promise<{ app: FastifyInstance; baseUrl: string; dataDir: string; setupTokens: SetupTokenStore; stop: () => Promise<void> }> {
  closeMetaDb();
  const dataRoot = options?.dataRoot ?? path.resolve(__dirname,"../../../../tmp/server-integration-tests");
  await fs.promises.mkdir(dataRoot, { recursive: true });
  const dataDir = await fs.promises.mkdtemp(path.join(dataRoot, "localapp-test-"));

  if (options?.configToml) {
    fs.writeFileSync(path.join(dataDir, "config.toml"), options.configToml, "utf-8");
  }

  // Default env vars
  const env = {
    DATA_DIR: dataDir,
    BOOTSTRAP_API_KEY: TEST_API_KEY,
    TEMPLATE_REPO_URL: "https://github.com/example/template.git",
    GIT_DOWNLOAD_URL: "https://example.com/git-install.exe" as string | undefined,
    JWT_SECRET: "test-jwt-secret-key",
    ADMIN_STATIC_DIR: path.resolve(__dirname, "../../static/admin"),
    ...options?.env,
  };

  const setupTokens = new SetupTokenStore();
  const app = await buildServer({ env, setupTokens, webRoot: options?.webRoot });

  if (!options?.cleanSetup) {
    const issued = setupTokens.issue();
    const initialized = await app.inject({
      method: "POST",
      url: "/api/setup/initialize",
      payload: { token: issued.token, username: "localadmin", password: "localadmin" },
    });
    if (initialized.statusCode !== 201) throw new Error(`Test setup failed: ${initialized.body}`);
  }

  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = getAppUrl(app);

  return {
    app,
    baseUrl,
    dataDir,
    setupTokens,
    stop: async () => {
      await app.close();
      closeMetaDb();
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function getAppUrl(app: FastifyInstance): string {
  const addresses = app.addresses();
  const addr = addresses[0];
  if (!addr || typeof addr === "string") throw new Error("Server not listening");
  return `http://127.0.0.1:${addr.port}`;
}

export function crudUrl(baseUrl: string, userId: string, pageName: string, resource: string, suffix?: string): string {
  const base = `${baseUrl}/serve/${userId}/${pageName}/api/${resource}`;
  return suffix ? `${base}/${suffix}` : base;
}

/**
 * Create a test user via admin API and set the requested password via force-change.
 * Browser registration is disabled — tests must use this helper instead.
 */
export async function registerUser(baseUrl: string, username: string, password = "test123456"): Promise<void> {
  const apiKey = getTestApiKey();
  const createRes = await fetch(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!createRes.ok) throw new Error(`Admin create user failed: ${await createRes.text()}`);
  const createBody = await createRes.json();
  const temporaryPassword = createBody.data.credentials.temporaryPassword as string;

  const forceRes = await fetch(`${baseUrl}/api/auth/force-change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: username, oldPassword: temporaryPassword, newPassword: password }),
  });
  if (!forceRes.ok) throw new Error(`Force change password failed: ${await forceRes.text()}`);
}

export async function createTestPage(
  app: FastifyInstance,
  userId: string,
  pageName: string,
  options?: { pageAccess?: Record<string, unknown> },
): Promise<void> {
  const dataDir = app.config.dataDir;
  const pageDir = path.join(dataDir, userId, pageName);
  fs.mkdirSync(pageDir, { recursive: true });

  const now = new Date().toISOString();
  const meta = {
    name: pageName,
    userId,
    description: "",
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
    versions: [{ version: 1, createdAt: now, fileCount: 1, totalSize: 100 }],
    metadata: {},
    ...(options?.pageAccess ? { pageAccess: options.pageAccess } : {}),
  };
  fs.writeFileSync(path.join(pageDir, "meta.json"), JSON.stringify(meta, null, 2));
}
