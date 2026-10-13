import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { execRawSql, getConnection } from "@localapp/server-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installAppPackage } from "../../src/lib/app-installer.js";
import { MAX_APP_PACKAGE_BYTES, writeAppPackage } from "../../src/lib/app-package.js";
import { SyncJobStore } from "../../src/lib/sync-job-store.js";
import { SyncSessionStore } from "../../src/lib/sync-session-store.js";
import { AppSyncTarget } from "../../src/lib/app-sync-target.js";
import { writePlatformManifest } from "../../src/lib/app-manifest.js";
import { readPageMeta } from "../../src/plugins/storage.js";
import { createTestServer, registerUser } from "./helpers.js";

const REDACTED_KEY = "target-peer-key-must-never-leak";

describe("application-only peer synchronization", () => {
  let baseUrl: string;
  let dataDir: string;
  let stop: () => Promise<void>;
  let adminCookie: string;
  let targetCookie: string;
  let targetApiKey: string;
  let otherApiKey: string;
  let peerId: string;

  beforeAll(async () => {
    const server = await createTestServer();
    ({ baseUrl, dataDir, stop } = server);
    await registerUser(baseUrl, "target-owner", "target-password");
    await registerUser(baseUrl, "other-owner", "other-password");
    adminCookie = await login("localadmin", "localadmin");
    targetCookie = await login("target-owner", "target-password");
    const otherCookie = await login("other-owner", "other-password");
    targetApiKey = await createKey(targetCookie);
    otherApiKey = await createKey(otherCookie);

    const peer = await fetchJson(`${baseUrl}/api/peers`, {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "self-as-independent-peer",
        baseUrl,
        apiKey: targetApiKey,
        acceptInsecureHttp: true,
      }),
    });
    expect(peer.response.status).toBe(201);
    peerId = String(peer.body.data.id);
  });

  afterAll(async () => {
    await stop();
  });

  it("pushes the active portable package to the API-key owner while preserving target rows and uploads", async () => {
    const v1 = await fixturePackage("notes", "1.0.0", "target-v1", [
      ["001_init.sql", "CREATE TABLE notes (id TEXT PRIMARY KEY, value TEXT); INSERT INTO notes VALUES ('keep-me', 'target');"],
    ]);
    const v2 = await fixturePackage("notes", "2.0.0", "source-v2", [
      ["001_init.sql", "CREATE TABLE notes (id TEXT PRIMARY KEY, value TEXT); INSERT INTO notes VALUES ('keep-me', 'target');"],
      ["002_upgrade.sql", "ALTER TABLE notes ADD COLUMN upgraded INTEGER NOT NULL DEFAULT 1;"],
    ]);
    await install(v1, "target-owner");
    await install(v2, "localadmin");
    writePlatformManifest(path.join(dataDir, "target-owner", "notes"), { pageAccess: { level: "acl", acl: ["target-only-user"] } });
    const upload = path.join(dataDir, "target-owner", "notes", "uploads", "keep.txt");
    fs.mkdirSync(path.dirname(upload), { recursive: true });
    fs.writeFileSync(upload, "target-upload");

    const started = await startSync("notes");
    expect(started.response.status).toBe(202);
    const completed = await waitForJob(String(started.body.data.id));
    expect(completed.status).toBe("completed");
    expect(completed.history.map((entry: { status: string }) => entry.status)).toEqual([
      "queued", "staging", "validating", "backing-up", "installing", "activating", "completed",
    ]);
    const hiddenJob = await fetchJson(`${baseUrl}/api/sync-jobs/${completed.id}`, { headers: { Cookie: targetCookie } });
    expect(hiddenJob.response.status).toBe(404);

    const meta = readPageMeta(dataDir, "target-owner", "notes");
    expect(meta).toMatchObject({ currentAppVersion: "2.0.0", userId: "target-owner" });
    expect(meta!.pageAccess).toEqual({ level: "acl", acl: ["target-only-user"] });
    const active = meta!.versions.find((entry) => entry.version === meta!.currentVersion)!;
    expect(active.packagePath).toMatch(/^\.packages\/v2-[a-f0-9]{64}\.localapp$/);
    expect(fs.readFileSync(path.join(dataDir, "target-owner", "notes", active.packagePath!))).toEqual(v2);
    expect((await sqlRows("SELECT id, value, upgraded FROM notes")))
      .toEqual([{ id: "keep-me", value: "target", upgraded: 1 }]);
    expect(fs.readFileSync(upload, "utf8")).toBe("target-upload");
    expect(readPageMeta(dataDir, "other-owner", "notes")).toBeNull();
  });

  it("makes identical repeats idempotent and rejects an installed appVersion with another digest", async () => {
    const before = readPageMeta(dataDir, "target-owner", "notes")!;
    const repeated = await startSync("notes");
    expect(repeated.response.status).toBe(202);
    expect((await waitForJob(String(repeated.body.data.id))).status).toBe("completed");
    expect(readPageMeta(dataDir, "target-owner", "notes")!.versions).toHaveLength(before.versions.length);

    const conflict = await targetRequest("/api/peer/sync-sessions", targetApiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: crypto.randomUUID(), protocolVersion: 2, mode: "app-only", appName: "notes", appVersion: "2.0.0",
        packageDigest: "f".repeat(64), packageSize: 1,
      }),
    });
    expect(conflict.response.status).toBe(409);
    expect(readPageMeta(dataDir, "target-owner", "notes")!.currentAppVersion).toBe("2.0.0");
  });

  it("enforces upload limits, digest verification, path validation, owner scoping, and safe cancellation", async () => {
    const id = crypto.randomUUID();
    const packageBytes = Buffer.from("not-a-package");
    const digest = crypto.createHash("sha256").update(packageBytes).digest("hex");
    const created = await createTargetSession(id, digest, packageBytes.length);
    expect(created.response.status).toBe(201);

    const hidden = await targetRequest(`/api/peer/sync-sessions/${id}/package`, otherApiKey, {
      method: "PUT", headers: binaryHeaders(packageBytes.length), body: packageBytes,
    });
    expect(hidden.response.status, JSON.stringify(hidden.body)).toBe(404);

    const mismatch = await targetRequest(`/api/peer/sync-sessions/${id}/package`, targetApiKey, {
      method: "PUT", headers: binaryHeaders(packageBytes.length), body: Buffer.from("wrong-package"),
    });
    expect(mismatch.response.status).toBe(400);
    expect(fs.existsSync(path.join(dataDir, ".staging", "sync", id, "package.localapp"))).toBe(false);

    const traversal = await targetRequest("/api/peer/sync-sessions/%2e%2e%2fescape/package", targetApiKey, {
      method: "PUT", headers: binaryHeaders(0), body: Buffer.alloc(0),
    });
    expect([400, 404]).toContain(traversal.response.status);
    expect(fs.existsSync(path.join(dataDir, ".staging", "escape"))).toBe(false);

    const oversized = await targetRequest("/api/peer/sync-sessions", targetApiKey, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: crypto.randomUUID(), protocolVersion: 2, mode: "app-only", appName: "notes-big", appVersion: "1.0.0",
        packageDigest: "a".repeat(64), packageSize: MAX_APP_PACKAGE_BYTES + 1,
      }),
    });
    expect(oversized.response.status).toBe(413);

    const cancelled = await targetRequest(`/api/peer/sync-sessions/${id}`, targetApiKey, { method: "DELETE" });
    expect(cancelled.response.status).toBe(204);
    expect(fs.existsSync(path.join(dataDir, ".staging", "sync", id))).toBe(false);
  });

  it("rejects legacy peers before accepting a synchronization session", async () => {
    const response = await targetRequest("/api/peer/sync-sessions", targetApiKey, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: crypto.randomUUID(), protocolVersion: 1, mode: "app-and-data", appName: "legacy-data",
        appVersion: "1.0.0", packageDigest: "a".repeat(64), packageSize: 1,
        dataDigest: "b".repeat(64), dataSize: 1,
      }),
    });
    expect(response.response.status).toBe(409);
    expect(response.body.code).toBe("SYNC_PROTOCOL_UNSUPPORTED");
  });

  it("prunes only expired uncommitted staging and retains completed sessions", async () => {
    const root = path.join(dataDir, ".staging", "sync-prune-test");
    const store = new SyncSessionStore({ dataDir, rootDir: root, retentionMs: 10 });
    const old = store.create({
      id: crypto.randomUUID(), ownerId: "target-owner", mode: "app-only", appName: "old-app",
      appVersion: "1.0.0", packageDigest: "a".repeat(64), packageSize: 1,
    });
    const completed = store.create({
      id: crypto.randomUUID(), ownerId: "target-owner", mode: "app-only", appName: "done-app",
      appVersion: "1.0.0", packageDigest: "b".repeat(64), packageSize: 1,
    });
    store.transition(completed.id, completed.ownerId, "completed");
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(store.sessionDir(old.id), oldTime, oldTime);
    fs.utimesSync(store.sessionDir(completed.id), oldTime, oldTime);

    expect(store.prune()).toBe(1);
    expect(fs.existsSync(store.sessionDir(old.id))).toBe(false);
    expect(fs.existsSync(store.sessionDir(completed.id))).toBe(true);
    const interrupted = store.create({
      id: crypto.randomUUID(), ownerId: "target-owner", mode: "app-only", appName: "interrupted-app",
      appVersion: "1.0.0", packageDigest: "c".repeat(64), packageSize: 1,
    });
    store.transition(interrupted.id, interrupted.ownerId, "committing");
    const target = new AppSyncTarget(dataDir, store);
    expect(await target.reconcileInterrupted()).toBe(1);
    expect(store.getOwned(interrupted.id, interrupted.ownerId)!.status).toBe("recovery-required");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("publishes a complete session atomically and recovers an empty crash residue idempotently", () => {
    const root = path.join(dataDir, ".staging", `sync-publish-${crypto.randomUUID()}`);
    const store = new SyncSessionStore({ dataDir, rootDir: root });
    const id = crypto.randomUUID();
    const input = {
      id, ownerId: "target-owner", mode: "app-only" as const, appName: "atomic-session",
      appVersion: "1.0.0", packageDigest: "d".repeat(64), packageSize: 12,
    };
    const originalRename = fs.renameSync;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (path.basename(String(target)) === "session.json") throw new Error("injected session metadata publication failure");
      return originalRename(source, target);
    });
    try {
      expect(() => store.create(input)).toThrow("injected session metadata publication failure");
      expect(fs.existsSync(store.sessionDir(id))).toBe(false);
    } finally {
      rename.mockRestore();
    }

    expect(store.create(input)).toMatchObject({ id, status: "created" });
    expect(store.create(input)).toMatchObject({ id, status: "created" });

    const residueId = crypto.randomUUID();
    fs.mkdirSync(store.sessionDir(residueId), { recursive: true });
    expect(store.create({ ...input, id: residueId })).toMatchObject({ id: residueId, status: "created" });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prunes expired orphan and corrupt uncommitted residues without deleting completed sessions", () => {
    const root = path.join(dataDir, ".staging", `sync-residue-${crypto.randomUUID()}`);
    const store = new SyncSessionStore({ dataDir, rootDir: root, retentionMs: 10 });
    const expired = store.create({
      id: crypto.randomUUID(), ownerId: "target-owner", mode: "app-only", appName: "expired",
      appVersion: "1.0.0", packageDigest: "a".repeat(64), packageSize: 1,
    });
    const completed = store.create({
      id: crypto.randomUUID(), ownerId: "target-owner", mode: "app-only", appName: "completed",
      appVersion: "1.0.0", packageDigest: "b".repeat(64), packageSize: 1,
    });
    store.transition(completed.id, completed.ownerId, "completed");
    const orphanId = crypto.randomUUID();
    const corruptId = crypto.randomUUID();
    fs.mkdirSync(store.sessionDir(orphanId));
    fs.mkdirSync(store.sessionDir(corruptId));
    fs.writeFileSync(path.join(store.sessionDir(corruptId), "session.json"), "{broken");
    const oldTime = new Date(Date.now() - 60_000);
    for (const id of [expired.id, completed.id, orphanId, corruptId]) {
      fs.utimesSync(store.sessionDir(id), oldTime, oldTime);
    }

    expect(store.prune()).toBe(3);
    expect(fs.existsSync(store.sessionDir(completed.id))).toBe(true);
    expect(fs.existsSync(store.sessionDir(expired.id))).toBe(false);
    expect(fs.existsSync(store.sessionDir(orphanId))).toBe(false);
    expect(fs.existsSync(store.sessionDir(corruptId))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rolls back a failed migration without replacing the active version or business data", async () => {
    const broken = await fixturePackage("notes", "3.0.0", "broken-v3", [
      ["001_init.sql", "CREATE TABLE notes (id TEXT PRIMARY KEY, value TEXT); INSERT INTO notes VALUES ('keep-me', 'target');"],
      ["002_upgrade.sql", "ALTER TABLE notes ADD COLUMN upgraded INTEGER NOT NULL DEFAULT 1;"],
      ["003_broken.sql", "THIS IS NOT SQL"],
    ]);
    const digest = crypto.createHash("sha256").update(broken).digest("hex");
    const id = crypto.randomUUID();
    expect((await createTargetSession(id, digest, broken.length, "3.0.0")).response.status).toBe(201);
    expect((await targetRequest(`/api/peer/sync-sessions/${id}/package`, targetApiKey, {
      method: "PUT", headers: binaryHeaders(broken.length), body: broken,
    })).response.status).toBe(200);
    const commit = await targetRequest(`/api/peer/sync-sessions/${id}/commit`, targetApiKey, { method: "POST" });
    expect(commit.response.status).toBe(422);
    expect(readPageMeta(dataDir, "target-owner", "notes")!.currentAppVersion).toBe("2.0.0");
    expect((await sqlRows("SELECT value FROM notes WHERE id = 'keep-me'")))
      .toEqual([{ value: "target" }]);
  });

  it("reconciles interrupted source jobs and persists no credentials in jobs, sessions, logs, or public JSON", async () => {
    const store = new SyncJobStore();
    const early = store.create({ ownerId: "localadmin", appName: "notes", peerId, syncId: crypto.randomUUID(), withData: false });
    const late = store.create({ ownerId: "localadmin", appName: "notes", peerId, syncId: crypto.randomUUID(), withData: false });
    store.transition(early.id, "staging");
    store.transition(late.id, "activating");
    store.reconcileInterrupted();
    expect(store.getOwned(early.id, "localadmin")!.status).toBe("failed");
    expect(store.getOwned(late.id, "localadmin")!.status).toBe("recovery-required");

    const jobs = await fetchJson(`${baseUrl}/api/sync-jobs`, { headers: { Cookie: adminCookie } });
    expect(JSON.stringify(jobs.body)).not.toContain(targetApiKey);
    const staging = path.join(dataDir, ".staging", "sync");
    for (const entry of fs.existsSync(staging) ? fs.readdirSync(staging) : []) {
      const metadata = path.join(staging, entry, "session.json");
      if (fs.existsSync(metadata)) expect(fs.readFileSync(metadata, "utf8")).not.toContain(targetApiKey);
    }
    expect(REDACTED_KEY).not.toBe(targetApiKey);
  });

  it("does not persist a malicious peer response that reflects the saved bearer credential", async () => {
    await install(await fixturePackage("malicious-source", "1.0.0", "malicious-source"), "localadmin");
    const malicious = http.createServer((request, response) => {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, code: "REFLECTED_SECRET", error: request.headers.authorization }));
    });
    await new Promise<void>((resolve) => malicious.listen(0, "127.0.0.1", resolve));
    try {
      const address = malicious.address();
      if (!address || typeof address === "string") throw new Error("malicious peer did not listen");
      const created = await fetchJson(`${baseUrl}/api/peers`, {
        method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "malicious-peer", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: targetApiKey, acceptInsecureHttp: true }),
      });
      const result = await fetchJson(`${baseUrl}/api/me/apps/malicious-source/sync`, {
        method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: created.body.data.id, withData: false }),
      });
      expect(result.response.status).toBe(400);
      const jobs = await fetchJson(`${baseUrl}/api/sync-jobs`, { headers: { Cookie: adminCookie } });
      expect(JSON.stringify(jobs.body)).not.toContain(targetApiKey);
    } finally {
      await new Promise<void>((resolve, reject) => malicious.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("synchronizes between independently initialized Server processes and preserves target data", async () => {
    const target = await startIndependentTarget();
    try {
      const v1 = await fixturePackage("independent-notes", "1.0.0", "target-v1", [
        ["001_init.sql", "CREATE TABLE notes (id TEXT PRIMARY KEY, value TEXT); INSERT INTO notes VALUES ('keep-independent', 'target');"],
      ]);
      const v2 = await fixturePackage("independent-notes", "2.0.0", "source-v2", [
        ["001_init.sql", "CREATE TABLE notes (id TEXT PRIMARY KEY, value TEXT); INSERT INTO notes VALUES ('keep-independent', 'target');"],
        ["002_upgrade.sql", "ALTER TABLE notes ADD COLUMN upgraded INTEGER NOT NULL DEFAULT 1;"],
      ]);
      await remoteInstall(target.baseUrl, target.apiKey, v1);
      await install(v2, "localadmin");
      const upload = path.join(target.dataDir, "target-owner", "independent-notes", "uploads", "keep.txt");
      fs.mkdirSync(path.dirname(upload), { recursive: true });
      fs.writeFileSync(upload, "target-only");

      const peer = await fetchJson(`${baseUrl}/api/peers`, {
        method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: `independent-${crypto.randomUUID()}`, baseUrl: target.baseUrl, apiKey: target.apiKey, acceptInsecureHttp: true }),
      });
      const first = await fetchJson(`${baseUrl}/api/me/apps/independent-notes/sync`, {
        method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: peer.body.data.id, withData: false }),
      });
      expect((await waitForJob(String(first.body.data.id))).status).toBe("completed");

      const meta = readPageMeta(target.dataDir, "target-owner", "independent-notes")!;
      expect(meta.currentAppVersion).toBe("2.0.0");
      expect(fs.readFileSync(upload, "utf8")).toBe("target-only");
      const targetDbPath = path.join(target.dataDir, "target-owner", "independent-notes", "app.db");
      await getConnection(targetDbPath);
      expect(execRawSql(targetDbPath, "SELECT id, value, upgraded FROM notes").rows).toEqual([
        { id: "keep-independent", value: "target", upgraded: 1 },
      ]);
      const active = meta.versions.find((entry) => entry.version === meta.currentVersion)!;
      expect(fs.readFileSync(path.join(target.dataDir, "target-owner", "independent-notes", active.packagePath!))).toEqual(v2);

      const repeated = await fetchJson(`${baseUrl}/api/me/apps/independent-notes/sync`, {
        method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: peer.body.data.id, withData: false }),
      });
      expect((await waitForJob(String(repeated.body.data.id))).status).toBe("completed");
      expect(readPageMeta(target.dataDir, "target-owner", "independent-notes")!.versions).toHaveLength(meta.versions.length);
    } finally {
      await target.stop();
    }
  });

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
    });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  async function createKey(cookie: string): Promise<string> {
    const result = await fetchJson(`${baseUrl}/api/keys`, { method: "POST", headers: { Cookie: cookie } });
    expect(result.response.status).toBe(200);
    return String(result.body.data.key);
  }

  async function fixturePackage(
    name: string,
    version: string,
    html: string,
    migrations: Array<[string, string]> = [],
  ): Promise<Buffer> {
    const directory = path.join(dataDir, ".staging", "sync-test-fixtures");
    fs.mkdirSync(directory, { recursive: true });
    const outputPath = path.join(directory, `${name}-${version}-${crypto.randomUUID()}.localapp`);
    await writeAppPackage({
      outputPath,
      metadata: { schemaVersion: 1, appId: name, version, platformVersion: "^1.0" },
      files: [
        { path: "manifest.json", content: Buffer.from(JSON.stringify({ name, platformVersion: "^1.0", pageAccess: { level: "acl", acl: ["source-only-user"] } })) },
        { path: "dist/index.html", content: Buffer.from(html) },
        ...migrations.map(([filename, sql]) => ({ path: `migrations/${filename}`, content: Buffer.from(sql) })),
      ],
    });
    const bytes = fs.readFileSync(outputPath);
    fs.rmSync(outputPath, { force: true });
    return bytes;
  }

  async function install(bytes: Buffer, ownerId: string): Promise<void> {
    const packagePath = path.join(dataDir, ".staging", `install-${crypto.randomUUID()}.localapp`);
    fs.mkdirSync(path.dirname(packagePath), { recursive: true });
    fs.writeFileSync(packagePath, bytes);
    try {
      await installAppPackage({ dataDir, ownerId, packagePath });
    } finally {
      fs.rmSync(packagePath, { force: true });
    }
  }

  async function remoteInstall(targetBaseUrl: string, apiKey: string, bytes: Buffer): Promise<void> {
    const form = new FormData();
    form.append("package", new Blob([bytes]), "application.localapp");
    const response = await fetch(`${targetBaseUrl}/api/me/apps/install`, { method: "POST", headers: { "X-API-Key": apiKey }, body: form });
    expect(response.status).toBe(201);
  }

  async function sqlRows(sql: string): Promise<Record<string, unknown>[]> {
    const dbPath = path.join(dataDir, "target-owner", "notes", "app.db");
    await getConnection(dbPath);
    return execRawSql(dbPath, sql).rows ?? [];
  }

  async function startSync(name: string) {
    return fetchJson(`${baseUrl}/api/me/apps/${name}/sync`, {
      method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ peerName: "self-as-independent-peer", withData: false }),
    });
  }

  async function waitForJob(id: string): Promise<any> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await fetchJson(`${baseUrl}/api/sync-jobs/${id}`, { headers: { Cookie: adminCookie } });
      const job = result.body.data;
      if (["completed", "rolled-back", "failed", "recovery-required"].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for sync job ${id}`);
  }

  function createTargetSession(id: string, digest: string, size: number, appVersion = "9.0.0") {
    return targetRequest("/api/peer/sync-sessions", targetApiKey, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, protocolVersion: 2, mode: "app-only", appName: "notes", appVersion, packageDigest: digest, packageSize: size }),
    });
  }

  function targetRequest(route: string, apiKey: string, init: RequestInit) {
    return fetchJson(`${baseUrl}${route}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${apiKey}` },
    });
  }

  function binaryHeaders(size: number): Record<string, string> {
    return { "Content-Type": "application/octet-stream", "Content-Length": String(size) };
  }
});

async function startIndependentTarget(): Promise<{ baseUrl: string; dataDir: string; apiKey: string; stop: () => Promise<void> }> {
  const targetDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-sync-target-"));
  const apiKey = `independent-target-${crypto.randomUUID()}`;
  const tsx = path.resolve(__dirname, "../../node_modules/tsx/dist/cli.mjs");
  const worker = path.resolve(__dirname, "../../src/worker.ts");
  const child = spawn(process.execPath, [tsx, worker], {
    env: {
      ...process.env,
      DATA_DIR: targetDataDir,
      LISTEN_PORT: "0",
      BOOTSTRAP_API_KEY: apiKey,
      JWT_SECRET: `independent-jwt-${crypto.randomUUID()}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const ready = await waitForWorkerReady(child);
    const setupUrl = new URL(ready.setupUrl);
    const initialized = await fetch(`${ready.baseUrl}/api/setup/initialize`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: setupUrl.searchParams.get("token"), username: "target-owner", password: "target-password" }),
    });
    if (initialized.status !== 201) throw new Error(`Independent target setup failed: ${await initialized.text()}`);
    return {
      baseUrl: ready.baseUrl,
      dataDir: targetDataDir,
      apiKey,
      stop: async () => {
        await stopChild(child);
        fs.rmSync(targetDataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stopChild(child);
    fs.rmSync(targetDataDir, { recursive: true, force: true });
    throw error;
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  if (child.exitCode === null) await exited;
}

async function waitForWorkerReady(child: ChildProcess): Promise<{ baseUrl: string; setupUrl: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Independent target timed out: ${stderr}`)), 15_000);
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Independent target exited ${code}: ${stderr}`)); });
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          const message = JSON.parse(line) as { type?: string; url?: string; setupUrl?: string };
          if (message.type === "ready" && message.url && message.setupUrl) {
            clearTimeout(timeout);
            resolve({ baseUrl: message.url, setupUrl: message.setupUrl });
          }
        } catch { /* non-JSON startup diagnostics */ }
      }
    });
  });
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, init);
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, body };
}
