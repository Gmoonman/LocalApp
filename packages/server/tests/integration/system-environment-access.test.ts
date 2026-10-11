import { it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestServer, getAppUrl, getTestApiKey } from "./helpers.js";
import { createTestUser } from "../helpers/createUser.js";

it("allows only administrators to read or change the system Python environment", async () => {
  const dataRoot = path.resolve(process.cwd(), "../../tmp/system-environment-access");
  await fs.mkdir(dataRoot, { recursive: true });
  const server = await createTestServer({ dataRoot });
  try {
    const base = getAppUrl(server.app);
    const ordinary = await createTestUser(base, "environment-user", "password123");
    for (const [method, endpoint] of [
      ["GET", "agent-environment"], ["GET", "python-environment"],
      ["PUT", "python-environment"], ["POST", "python-environment/create"],
      ["POST", "python-environment/install-document-dependencies"],
    ]) {
      for (const [apiKey, status] of [[undefined, 401], [ordinary.apiKey, 403]] as const) {
        const result = await fetch(`${base}/api/system/${endpoint}`, {
          method, headers: { ...(apiKey ? { "X-API-Key": apiKey } : {}), ...(method !== "GET" ? { "Content-Type": "application/json" } : {}) },
          ...(method !== "GET" ? { body: "{}" } : {}),
        });
        expect(result.status, `${method} ${endpoint}`).toBe(status);
      }
    }
    const result = await fetch(`${base}/api/system/python-environment`, { headers: { "X-API-Key": getTestApiKey() } });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ success: true, data: { environment: null } });
  } finally { await server.stop(); await fs.rm(dataRoot, { recursive: true, force: true }); }
});
