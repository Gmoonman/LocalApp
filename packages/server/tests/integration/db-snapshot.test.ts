import { afterAll, beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createTestServer, getAppUrl, getTestApiKey } from "./helpers.js";
import { BOOTSTRAP_USER_ID } from "../../src/lib/meta-sqlite.js";

let app: FastifyInstance;
let baseUrl: string;
let stop: () => Promise<void>;
const headers = { "X-API-Key": getTestApiKey(), "Content-Type": "application/json" };
beforeAll(async () => {
  const server = await createTestServer();
  app = server.app; baseUrl = getAppUrl(app); stop = server.stop;
  const response = await fetch(baseUrl + "/api/pages", { method: "POST", headers, body: JSON.stringify({ name: "snapshot-app" }) });
  expect((await response.json()).success).toBe(true);
});
afterAll(async () => { await stop?.(); });

it("returns exact database bytes and restores only a named existing backup", async () => {
  const directory = path.join(app.config.dataDir, BOOTSTRAP_USER_ID, "snapshot-app");
  const original = Buffer.from([0, 255, 1, 128, 17]);
  const backup = Buffer.from([255, 0, 99, 128]);
  fs.writeFileSync(path.join(directory, "app.db"), original);
  fs.writeFileSync(path.join(directory, "app.db.backup.v1"), backup);
  const snapshot = await fetch(baseUrl + "/api/db/snapshot?name=snapshot-app", { headers });
  expect(snapshot.status).toBe(200);
  expect(Buffer.from(await snapshot.arrayBuffer())).toEqual(original);
  const restore = (value: string) => fetch(baseUrl + "/api/db/restore", { method: "POST", headers, body: JSON.stringify({ name: "snapshot-app", backup: value }) });
  expect((await restore("../../other")).status).toBe(400);
  expect((await restore("v2")).status).toBe(404);
  expect(fs.readFileSync(path.join(directory, "app.db"))).toEqual(original);
  expect((await restore("v1")).status).toBe(200);
  expect(fs.readFileSync(path.join(directory, "app.db"))).toEqual(backup);
});

it("requires authentication and an existing owned application", async () => {
  expect((await fetch(baseUrl + "/api/db/snapshot?name=snapshot-app")).status).toBe(401);
  expect((await fetch(baseUrl + "/api/db/snapshot?name=missing", { headers })).status).toBe(404);
});
