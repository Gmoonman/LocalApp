import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSyncSource, SyncSourceError } from "../src/lib/app-sync-source.js";
import { AppSyncTarget } from "../src/lib/app-sync-target.js";
import { installAppPackage, type InstallOutcome } from "../src/lib/app-installer.js";
import { writeAppPackage } from "../src/lib/app-package.js";
import { closeMetaDb, initMetaDb } from "../src/lib/meta-sqlite.js";
import type { PeerStore } from "../src/lib/peer-store.js";
import { SyncJobStore, type SyncJobStatus } from "../src/lib/sync-job-store.js";
import { SyncSessionStore } from "../src/lib/sync-session-store.js";
import { initContentStorage } from "../src/lib/s3-client.js";
import type { ServerConfig } from "../src/lib/config.js";

describe("peer synchronization concurrency, deadlines, and cancellation", () => {
  const roots: string[] = [];
  const sources: AppSyncSource[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const source of sources.splice(0)) await source.shutdown();
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    closeMetaDb();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["package", "data"] as const)("cancels a stalled %s upload and removes partial files before stopping", async kind => {
    const dataDir = tempRoot();
    const bytes = Buffer.from("upload payload");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const sessions = new SyncSessionStore({ dataDir });
    const id = crypto.randomUUID();
    sessions.create({ id, ownerId: "owner", mode: "app-and-data", appName: "sync-app", appVersion: "1.0.0",
      packageDigest: digest, packageSize: bytes.length, dataDigest: digest, dataSize: bytes.length });
    const target = new AppSyncTarget(dataDir, sessions);
    if (kind === "data") await target.receivePackage({ id, ownerId: "owner", stream: Readable.from(bytes), contentLength: bytes.length });
    const stream = new PassThrough();
    const input = { id, ownerId: "owner", stream, contentLength: bytes.length };
    const upload = kind === "package" ? target.receivePackage(input) : target.receiveData(input);
    const rejected = expect(upload).rejects.toMatchObject({ code: "SYNC_TARGET_STOPPED" });
    stream.write(bytes.subarray(0, 2));
    const directory = path.dirname(sessions.packagePath(id));
    await waitFor(() => fs.readdirSync(directory).some(file => file.endsWith(".partial")), 1000);
    await target.shutdown();
    await rejected;
    expect(stream.destroyed).toBe(true);
    expect(fs.readdirSync(directory).some(file => file.endsWith(".partial"))).toBe(false);
    await expect(target.receivePackage({ ...input, stream: Readable.from(bytes) })).rejects.toMatchObject({ code: "SYNC_TARGET_STOPPED" });
    const restored = new AppSyncTarget(dataDir, new SyncSessionStore({ dataDir }));
    const retry = { ...input, stream: Readable.from(bytes) };
    const result = kind === "package" ? await restored.receivePackage(retry) : await restored.receiveData(retry);
    expect(result.status).toBe("uploaded");
    await restored.shutdown();
  });

  it.each([false, true])("serializes commits and drains pending installation when stopping=%s", async (stop) => {
    const dataDir = tempRoot();
    const packagePath = await packageFixture(dataDir);
    const bytes = fs.readFileSync(packagePath);
    const digest = (await import("../src/lib/app-package.js")).inspectAppPackage(packagePath).then((value) => value.digest);
    const sessions = new SyncSessionStore({ dataDir });
    const id = crypto.randomUUID();
    sessions.create({
      id, ownerId: "owner", mode: "app-only", appName: "sync-app", appVersion: "1.0.0",
      packageDigest: await digest, packageSize: bytes.length,
    });
    await sessions.receivePackage({ id, ownerId: "owner", stream: Readable.from(bytes), contentLength: bytes.length });
    let installCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const outcome: InstallOutcome = {
      name: "sync-app", ownerId: "owner", localVersion: 1, appVersion: "1.0.0",
      digest: await digest, created: true, upgraded: false, idempotent: false,
    };
    const target = new AppSyncTarget(dataDir, sessions, {
      install: async () => { installCalls += 1; await gate; return outcome; },
    });

    const first = target.commit(id, "owner");
    const second = target.commit(id, "owner");
    try {
      await waitFor(() => installCalls === 1 && sessions.getOwned(id, "owner")?.status === "committing", 500);
      expect(installCalls).toBe(1);
      expect(sessions.getOwned(id, "owner")?.status).toBe("committing");
      let drained = false;
      const shutdown = stop ? target.shutdown().then(() => { drained = true; }) : undefined;
      if (stop) {
        await Promise.resolve();
        expect(drained).toBe(false);
        expect(target.active).toBe(false);
        await expect(target.commit(id, "owner")).rejects.toMatchObject({ code: "SYNC_TARGET_STOPPED" });
        expect(() => target.create(sessionInput())).toThrow(expect.objectContaining({ code: "SYNC_TARGET_STOPPED" }));
      }
      release();
      expect(await first).toEqual(await second);
      await shutdown;
      if (stop) {
        expect(drained).toBe(true);
        expect(sessions.getOwned(id, "owner")?.status).toBe("completed");
      } else {
        expect((await target.commit(id, "owner")).outcome).toEqual(outcome);
      }
      expect(installCalls).toBe(1);
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
  });

  it("rejects incomplete existing session metadata instead of adopting it", () => {
    const dataDir = tempRoot();
    const store = new SyncSessionStore({ dataDir });
    const input = sessionInput();
    store.create(input);
    const metadataPath = path.join(store.sessionDir(input.id), "session.json");
    const incomplete = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    delete incomplete.status;
    fs.writeFileSync(metadataPath, JSON.stringify(incomplete));

    expect(() => store.create(input)).toThrow(expect.objectContaining({ code: "SYNC_SESSION_CORRUPT" }));
  });

  it("fsyncs rootDir before returning an existing-id adoption and propagates fsync failure", () => {
    const dataDir = tempRoot();
    const store = new SyncSessionStore({ dataDir });
    const input = sessionInput();
    store.create(input);
    const restore = failRootDirectoryFsync(store.rootDir, "existing adoption fsync failed");
    try {
      expect(() => store.create(input)).toThrow("existing adoption fsync failed");
      expect(restore.calls()).toBe(1);
    } finally { restore.restore(); }
  });

  it("validates and fsyncs a complete rename-race winner before adoption", () => {
    const dataDir = tempRoot();
    const store = new SyncSessionStore({ dataDir });
    const input = sessionInput();
    const now = new Date().toISOString();
    const winner = { ...input, status: "created", outcome: null, error: null, createdAt: now, updatedAt: now };
    const originalRename = fs.renameSync;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (path.resolve(String(target)) === store.sessionDir(input.id) && path.basename(String(source)).endsWith(".partial")) {
        fs.mkdirSync(String(target));
        fs.writeFileSync(path.join(String(target), "session.json"), `${JSON.stringify(winner)}\n`);
        throw Object.assign(new Error("race winner published"), { code: "EEXIST" });
      }
      return originalRename(source, target);
    });
    const restore = failRootDirectoryFsync(store.rootDir, "race adoption fsync failed");
    try {
      expect(() => store.create(input)).toThrow("race adoption fsync failed");
      expect(restore.calls()).toBe(1);
    } finally {
      restore.restore();
      rename.mockRestore();
    }
  });

  it("drains a prepared source job before its deferred upload starts and rejects new jobs", async () => {
    let uploads = 0;
    const harness = await sourceHarness((request, response) => {
      if (request.method === "POST") return json(response, 201, {});
      if (request.method === "PUT") { uploads += 1; request.resume(); return; }
      response.writeHead(404).end();
    }, { uploadTimeoutMs: 500, commitTimeoutMs: 100 });
    const job = await harness.source.start(harness.input);
    await harness.source.shutdown();
    expect(harness.source.active).toBe(false);
    expect(harness.jobs.get(job.id)?.status).toBe("failed");
    expect(uploads).toBe(0);
    await expect(harness.source.start(harness.input)).rejects.toMatchObject({ code: "SYNC_SOURCE_STOPPED", statusCode: 503 });
  });

  it("fails a never-resolving upload within its hard deadline and leaves no live run", async () => {
    const harness = await sourceHarness((request, response) => {
      if (request.method === "POST" && request.url === "/api/peer/sync-sessions") return json(response, 201, {});
      if (request.method === "PUT") { request.resume(); return; }
      response.writeHead(404).end();
    }, { uploadTimeoutMs: 40, commitTimeoutMs: 100 });
    const job = await harness.source.start(harness.input);
    const terminal = await waitForStatus(harness.jobs, job.id, new Set(["failed", "recovery-required"]), 500);
    expect(terminal.status).toBe("failed");
    await expect(Promise.race([
      harness.source.shutdown().then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ])).resolves.toBe("done");
  });

  it("retries commit after response loss and polls the persisted target outcome", async () => {
    let commitCalls = 0;
    let createdSession: Record<string, unknown> = {};
    const harness = await sourceHarness((request, response) => {
      if (request.method === "POST" && request.url === "/api/peer/sync-sessions") {
        void readJsonRequest(request).then((body) => { createdSession = body; json(response, 201, {}); }); return;
      }
      if (request.method === "PUT") { request.resume(); request.on("end", () => json(response, 200, {})); return; }
      if (request.method === "POST" && request.url?.endsWith("/commit")) {
        commitCalls += 1;
        if (commitCalls === 1) { request.socket.destroy(); return; }
        return json(response, 200, successfulCommit(createdSession));
      }
      response.writeHead(404).end();
    }, { uploadTimeoutMs: 200, commitTimeoutMs: 800, commitRetryDelayMs: 10 });
    const job = await harness.source.start(harness.input);
    expect((await waitForStatus(harness.jobs, job.id, new Set(["completed", "failed", "recovery-required"]), 1_500)).status).toBe("completed");
    expect(commitCalls).toBe(2);
  });

  it("bounds a never-resolving commit and persists an unknown target outcome as recovery-required", async () => {
    const harness = await sourceHarness((request, response) => {
      if (request.method === "POST" && request.url === "/api/peer/sync-sessions") return json(response, 201, {});
      if (request.method === "PUT") { request.resume(); request.on("end", () => json(response, 200, {})); return; }
      if (request.method === "POST" && request.url?.endsWith("/commit")) return;
      response.writeHead(404).end();
    }, { uploadTimeoutMs: 200, commitTimeoutMs: 40, commitRetryDelayMs: 5 });
    const job = await harness.source.start(harness.input);
    const terminal = await waitForStatus(harness.jobs, job.id, new Set(["recovery-required"]), 500);
    expect(terminal.error).toContain("outcome could not be verified");
    await expect(Promise.race([
      harness.source.shutdown().then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ])).resolves.toBe("done");
  });

  it("maps a trusted target installer recovery error to a redacted source recovery-required state", async () => {
    const reflectedCredential = "Bearer secret";
    const harness = await sourceHarness((request, response) => {
      if (request.method === "POST" && request.url === "/api/peer/sync-sessions") return json(response, 201, {});
      if (request.method === "PUT") { request.resume(); request.on("end", () => json(response, 200, {})); return; }
      if (request.method === "POST" && request.url?.endsWith("/commit")) {
        return json(response, 503, {
          success: false,
          code: "APP_INSTALL_RECOVERY_REQUIRED",
          error: `operator detail ${request.headers.authorization}`,
        });
      }
      response.writeHead(404).end();
    }, { uploadTimeoutMs: 200, commitTimeoutMs: 400, commitRetryDelayMs: 5 });
    const job = await harness.source.start(harness.input);
    const terminal = await waitForStatus(harness.jobs, job.id, new Set(["failed", "recovery-required"]), 500);
    expect(terminal).toMatchObject({
      status: "recovery-required",
      error: "Peer synchronization failed (503)",
    });
    expect(JSON.stringify(terminal)).not.toContain(reflectedCredential);
  });

  it("lets the target arbitrate cancellation at the activating boundary", async () => {
    let deleteCalls = 0;
    let createdSession: Record<string, unknown> = {};
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const harness = await sourceHarness((request, response) => {
      if (request.method === "POST" && request.url === "/api/peer/sync-sessions") {
        void readJsonRequest(request).then((body) => { createdSession = body; json(response, 201, {}); }); return;
      }
      if (request.method === "PUT") { request.resume(); request.on("end", () => json(response, 200, {})); return; }
      if (request.method === "POST" && request.url?.endsWith("/commit")) {
        void commitGate.then(() => json(response, 200, successfulCommit(createdSession))); return;
      }
      if (request.method === "DELETE") { deleteCalls += 1; return json(response, 409, { code: "SYNC_CANNOT_CANCEL" }); }
      response.writeHead(404).end();
    }, { uploadTimeoutMs: 200, commitTimeoutMs: 800, commitRetryDelayMs: 10 });
    const job = await harness.source.start(harness.input);
    await waitForStatus(harness.jobs, job.id, new Set(["activating"]), 500);
    await expect(harness.source.cancel(job.id, "owner")).rejects.toMatchObject<Partial<SyncSourceError>>({
      statusCode: 409, code: "SYNC_CANNOT_CANCEL",
    });
    expect(deleteCalls).toBe(1);
    releaseCommit();
    expect((await waitForStatus(harness.jobs, job.id, new Set(["completed"]), 500)).status).toBe("completed");
  });

  it("cancels locally only after the target confirms commit has not begun", async () => {
    let deleteCalls = 0;
    const harness = await sourceHarness((request, response) => {
      if (request.method === "POST" && request.url === "/api/peer/sync-sessions") return json(response, 201, {});
      if (request.method === "PUT") { request.resume(); request.on("end", () => json(response, 200, {})); return; }
      if (request.method === "POST" && request.url?.endsWith("/commit")) return;
      if (request.method === "DELETE") { deleteCalls += 1; response.writeHead(204).end(); return; }
      response.writeHead(404).end();
    }, { uploadTimeoutMs: 200, commitTimeoutMs: 800, commitRetryDelayMs: 10 });
    const job = await harness.source.start(harness.input);
    await waitForStatus(harness.jobs, job.id, new Set(["activating"]), 500);
    const cancelled = await harness.source.cancel(job.id, "owner");
    expect(cancelled).toMatchObject({ status: "failed", error: "Cancelled" });
    expect(deleteCalls).toBe(1);
  });

  it("marks a successful HTTP status with an invalid commit envelope as recovery-required", async () => {
    const harness = await sourceHarness((request, response) => {
      if (request.method === "POST" && request.url === "/api/peer/sync-sessions") return json(response, 201, {});
      if (request.method === "PUT") { request.resume(); request.on("end", () => json(response, 200, {})); return; }
      if (request.method === "POST" && request.url?.endsWith("/commit")) return json(response, 200, { success: true });
      response.writeHead(404).end();
    }, { uploadTimeoutMs: 200, commitTimeoutMs: 400, commitRetryDelayMs: 5 });
    const job = await harness.source.start(harness.input);
    const terminal = await waitForStatus(harness.jobs, job.id, new Set(["recovery-required"]), 500);
    expect(terminal.error).toContain("commit response is invalid");
  });

  it("rejects a non-v4 target backup ID as an unverifiable commit outcome", async () => {
    // Break caught: accepting UUID versions that the backup API cannot read records an unusable recovery handle.
    let createdSession: Record<string, unknown> = {};
    const harness = await sourceHarness((request, response) => {
      if (request.method === "POST" && request.url === "/api/peer/sync-sessions") {
        void readJsonRequest(request).then((body) => { createdSession = body; json(response, 201, {}); }); return;
      }
      if (request.method === "PUT") { request.resume(); request.on("end", () => json(response, 200, {})); return; }
      if (request.method === "POST" && request.url?.endsWith("/commit")) {
        const committed = successfulCommit(createdSession);
        committed.data.backupId = "123e4567-e89b-12d3-a456-426614174000";
        return json(response, 200, committed);
      }
      response.writeHead(404).end();
    }, { uploadTimeoutMs: 200, commitTimeoutMs: 400, commitRetryDelayMs: 5 });
    const job = await harness.source.start({
      ...harness.input,
      withData: true,
      confirmation: "sync-app",
    });
    const terminal = await waitForStatus(harness.jobs, job.id, new Set(["recovery-required"]), 500);
    expect(terminal.error).toContain("valid safety backup ID");
  });

  it("rejects peer protocol 1 before starting an application data transfer", async () => {
    let requests = 0;
    const harness = await sourceHarness((_request, response) => {
      requests += 1;
      response.writeHead(500).end();
    }, { uploadTimeoutMs: 200, commitTimeoutMs: 400 }, { protocolVersion: 1, verifiedUserId: "target-owner" });
    await expect(harness.source.start({
      ...harness.input,
      withData: true,
      confirmation: "sync-app",
    })).rejects.toMatchObject({ code: "PEER_PROTOCOL_UNSUPPORTED", statusCode: 409 });
    expect(requests).toBe(0);
  });

  function tempRoot(): string {
    const parent = path.resolve(__dirname,"../../../tmp/sync-hardening-tests");
    fs.mkdirSync(parent,{recursive:true});
    const root = fs.mkdtempSync(path.join(parent, "data-"));
    roots.push(root);
    return root;
  }

  function sessionInput() {
    return {
      id: crypto.randomUUID(), ownerId: "owner", mode: "app-only" as const, appName: "sync-app",
      appVersion: "1.0.0", packageDigest: "a".repeat(64), packageSize: 1,
    };
  }

  async function sourceHarness(
    handler: http.RequestListener,
    options: { uploadTimeoutMs: number; commitTimeoutMs: number; commitRetryDelayMs?: number },
    peerOverrides: { protocolVersion?: number; verifiedUserId?: string | null } = {},
  ) {
    const dataDir = tempRoot();
    await initMetaDb(dataDir);
    await initContentStorage({
      dataDir,
      minioEndpoint: "127.0.0.1:1",
      minioAccessKey: "none",
      minioSecretKey: "none",
      minioBucket: "test",
    } as ServerConfig);
    const packagePath = await packageFixture(dataDir);
    await installAppPackage({ dataDir, ownerId: "owner", packagePath });
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const peers = { loadForCheck: () => ({
      id: "peer", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "secret", connectionVersion: 1,
      protocolVersion: peerOverrides.protocolVersion ?? 2,
      verifiedUserId: peerOverrides.verifiedUserId ?? "target-owner",
    }) } as PeerStore;
    const jobs = new SyncJobStore();
    const source = new AppSyncSource(dataDir, jobs, peers, options);
    sources.push(source);
    return { source, jobs, input: { ownerId: "owner", appName: "sync-app", peerId: "peer", withData: false as const } };
  }
});

function successfulCommit(sessionInput: Record<string, unknown>) {
  const syncId = String(sessionInput.id ?? "");
  const appName = String(sessionInput.appName ?? "");
  const appVersion = String(sessionInput.appVersion ?? "");
  const packageDigest = String(sessionInput.packageDigest ?? "");
  return {
    success: true,
    data: {
      session: {
        id: syncId,
        status: "completed",
        appName,
        appVersion,
        packageDigest,
      },
      outcome: { name: appName, appVersion, digest: packageDigest },
      backupId: null,
    },
  };
}

async function readJsonRequest(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function failRootDirectoryFsync(rootDir: string, message: string): { calls: () => number; restore: () => void } {
  const descriptors = new Map<number, string>();
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  let calls = 0;
  const open = vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
    const descriptor = originalOpen(target, flags, mode);
    descriptors.set(descriptor, path.resolve(String(target)));
    return descriptor;
  });
  const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    if (descriptors.get(descriptor) === path.resolve(rootDir)) {
      calls += 1;
      throw Object.assign(new Error(message), { code: "EIO" });
    }
    return originalFsync(descriptor);
  });
  return { calls: () => calls, restore: () => { fsync.mockRestore(); open.mockRestore(); } };
}

async function packageFixture(dataDir: string): Promise<string> {
  const outputPath = path.join(dataDir, `${crypto.randomUUID()}.localapp`);
  await writeAppPackage({
    outputPath,
    metadata: { schemaVersion: 1, appId: "sync-app", version: "1.0.0", platformVersion: "^1.0" },
    files: [
      { path: "manifest.json", content: Buffer.from(JSON.stringify({ name: "sync-app", platformVersion: "^1.0" })) },
      { path: "dist/index.html", content: Buffer.from("sync") },
      { path: "migrations/001_init.sql", content: Buffer.from("CREATE TABLE records (id TEXT PRIMARY KEY);") },
    ],
  });
  return outputPath;
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function waitForStatus(
  jobs: SyncJobStore,
  id: string,
  statuses: Set<SyncJobStatus>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = jobs.get(id)!;
    if (statuses.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${[...statuses].join(", ")}; current=${jobs.get(id)?.status}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
