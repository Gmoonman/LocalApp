import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inspectAppPackage } from "./app-package.cjs";
import { createAppDataExport, isAppBackupId } from "./app-data-service.cjs";
export interface SyncPeers {
  findIdByName(name: string): string | null;
  loadForCheck(id: string): { baseUrl: string; apiKey: string; verifiedUserId: string | null; protocolVersion: number | null } | null;
}
import { SyncJobStore, type SyncJobRecord, type SyncJobStatus } from "./sync-job-store.cjs";
import { getPageDir, readPageMeta } from "./page-storage.cjs";

const TERMINAL = new Set<SyncJobStatus>(["completed", "rolled-back", "failed", "recovery-required"]);
const CANCELLABLE = new Set<SyncJobStatus>(["queued", "staging", "validating", "backing-up", "installing", "activating"]);
const PEER_ERROR_CODES = new Set([
  "APP_VERSION_DIGEST_CONFLICT", "APP_MIGRATION_APPLY_FAILED", "APP_MIGRATION_CONFLICT", "APP_BACKEND_INVALID",
  "APP_INSTALL_RECOVERY_REQUIRED",
  "APP_MANIFEST_INVALID", "APP_HEALTH_CHECK_FAILED", "APP_PLATFORM_VERSION_MISMATCH",
  "SYNC_SESSION_CONFLICT", "SYNC_SESSION_NOT_FOUND", "SYNC_PACKAGE_TOO_LARGE", "SYNC_PACKAGE_SIZE_MISMATCH",
  "SYNC_PACKAGE_DIGEST_MISMATCH", "SYNC_PACKAGE_METADATA_MISMATCH", "SYNC_PACKAGE_REQUIRED", "SYNC_CANNOT_CANCEL",
  "SYNC_COMMIT_IN_PROGRESS", "SYNC_RECOVERY_REQUIRED", "SYNC_DATA_REQUIRED", "SYNC_DATA_NOT_EXPECTED",
  "SYNC_PROTOCOL_UNSUPPORTED",
  "SYNC_DATA_TOO_LARGE", "SYNC_DATA_SIZE_MISMATCH", "SYNC_DATA_DIGEST_MISMATCH", "SYNC_DATA_CONFLICT",
  "APP_ARCHIVE_LIMIT_EXCEEDED", "APP_ARCHIVE_IDENTITY_MISMATCH", "APP_ARCHIVE_VERSION_TOO_NEW",
  "APP_ARCHIVE_MANIFEST_INVALID", "APP_ARCHIVE_FORMAT_UNSUPPORTED", "APP_ARCHIVE_INVALID_PATH",
  "APP_ARCHIVE_HASH_MISMATCH", "APP_ARCHIVE_ENTRY_MISSING", "APP_DATABASE_SCHEMA_INCOMPATIBLE",
  "APP_DATA_ROLLBACK_FAILED", "APP_DATABASE_NOT_FOUND", "APP_DATA_OPERATION_BUSY",
]);

interface AppSyncSourceOptions {
  uploadTimeoutMs?: number;
  commitTimeoutMs?: number;
  commitRetryDelayMs?: number;
  cancelTimeoutMs?: number;
}

export class SyncSourceError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code = "SYNC_FAILED") {
    super(message);
    this.name = "SyncSourceError";
  }
}

export class AppSyncSource {
  private stopped = false;
  private readonly starts = new Set<Promise<SyncJobRecord>>();
  get active(): boolean { return !this.stopped; }

  private readonly emitters = new Map<string, EventEmitter>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly activePeers = new Map<string, { baseUrl: string; apiKey: string }>();
  private readonly runs = new Set<Promise<void>>();

  constructor(
    private readonly dataDir: string,
    readonly jobs: SyncJobStore,
    private readonly peers: SyncPeers,
    private readonly options: AppSyncSourceOptions = {},
  ) {}

  resolvePeerName(name: string): string | null {
    return this.peers.findIdByName(name);
  }

  start(input: {
    ownerId: string; appName: string; peerId: string; withData: false;
  } | {
    ownerId: string; appName: string; peerId: string; withData: true; confirmation: string;
  }): Promise<SyncJobRecord> {
    if (this.stopped) return Promise.reject(new SyncSourceError(503, "Synchronization source is stopped", "SYNC_SOURCE_STOPPED"));
    const pending = this.prepare(input);
    this.starts.add(pending);
    void pending.finally(() => this.starts.delete(pending)).catch(() => undefined);
    return pending;
  }

  private async prepare(input: {
    ownerId: string; appName: string; peerId: string; withData: false;
  } | {
    ownerId: string; appName: string; peerId: string; withData: true; confirmation: string;
  }): Promise<SyncJobRecord> {
    const syncId = randomUUID();
    const job = this.jobs.create({ ...input, syncId });
    let dataExport: { archivePath: string; cleanup: () => void } | undefined;
    try {
      this.change(job.id, "staging");
      const active = await activePackage(this.dataDir, input.ownerId, input.appName);
      this.jobs.setPackage(job.id, { appVersion: active.appVersion, packageDigest: active.digest, packageSize: active.size });
      this.change(job.id, "validating");
      const target = this.peers.loadForCheck(input.peerId);
      if (!target) throw new SyncSourceError(404, "Peer not found", "PEER_NOT_FOUND");
      if (input.withData && !target.verifiedUserId) {
        throw new SyncSourceError(409, "Peer must be checked before application data can be synchronized", "PEER_NOT_VERIFIED");
      }
      if (input.withData && (target.protocolVersion ?? 0) < 2) {
        throw new SyncSourceError(409, "Peer protocol 2 or newer is required for application data synchronization", "PEER_PROTOCOL_UNSUPPORTED");
      }
      let dataDigest: string | undefined;
      let dataSize: number | undefined;
      if (input.withData) {
        dataExport = await createAppDataExport({
          pageDir: getPageDir(this.dataDir, input.ownerId, input.appName),
          application: { owner: input.ownerId, name: input.appName, version: active.localVersion },
          archiveApplication: { owner: target.verifiedUserId!, name: input.appName, version: active.localVersion },
        });
        dataDigest = await sha256File(dataExport.archivePath);
        dataSize = fs.statSync(dataExport.archivePath).size;
        this.jobs.setData(job.id, { dataDigest, dataSize });
      }
      const response = await peerFetch(`${target.baseUrl}/api/peer/sync-sessions`, target.apiKey, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          id: syncId, protocolVersion: 2, mode: input.withData ? "app-and-data" : "app-only", appName: input.appName, appVersion: active.appVersion,
          packageDigest: active.digest, packageSize: active.size,
          ...(input.withData ? { dataDigest, dataSize } : {}),
        }),
      });
      if (!response.ok) throw await sourceResponseError(response);
      this.change(job.id, "backing-up");
      const controller = new AbortController();
      this.controllers.set(job.id, controller);
      this.activePeers.set(job.id, { baseUrl: target.baseUrl, apiKey: target.apiKey });
      const run = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
        this.run(job.id, active.path, dataExport?.archivePath, target.baseUrl, target.apiKey, controller, dataExport?.cleanup));
      this.runs.add(run);
      void run.finally(() => this.runs.delete(run)).catch(() => undefined);
      return this.jobs.get(job.id)!;
    } catch (error) {
      dataExport?.cleanup();
      this.fail(job.id, error);
      throw error;
    }
  }

  events(id: string): EventEmitter {
    let emitter = this.emitters.get(id);
    if (!emitter) { emitter = new EventEmitter(); this.emitters.set(id, emitter); }
    return emitter;
  }

  async cancel(id: string, ownerId: string): Promise<SyncJobRecord> {
    const job = this.jobs.getOwned(id, ownerId);
    if (!job) throw new SyncSourceError(404, "Synchronization job not found", "SYNC_JOB_NOT_FOUND");
    if (!CANCELLABLE.has(job.status)) throw new SyncSourceError(409, "Synchronization can no longer be cancelled", "SYNC_CANNOT_CANCEL");
    const target = this.activePeers.get(id) ?? this.peers.loadForCheck(job.peerId);
    if (!target) throw new SyncSourceError(409, "Peer is unavailable; cancellation cannot be verified", "SYNC_CANNOT_CANCEL");
    {
      const deadline = createDeadlineSignal(undefined, this.options.cancelTimeoutMs ?? 10_000);
      try {
        const response = await peerFetch(`${target.baseUrl}/api/peer/sync-sessions/${encodeURIComponent(job.syncId)}`, target.apiKey, {
          method: "DELETE", signal: deadline.signal,
        });
        if (!response.ok && response.status !== 404) throw await sourceResponseError(response);
      } catch (error) {
        if (deadline.timedOut()) throw new SyncSourceError(504, "Peer cancellation timed out", "SYNC_CANCEL_TIMEOUT");
        throw error;
      } finally { deadline.dispose(); }
    }
    this.controllers.get(id)?.abort();
    return this.change(id, "failed", "Cancelled");
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.starts);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.runs);
    this.controllers.clear();
    this.activePeers.clear();
    this.emitters.clear();
  }

  private async run(jobId: string, packagePath: string, dataPath: string | undefined, baseUrl: string, apiKey: string, controller: AbortController, cleanupData?: () => void): Promise<void> {
    try {
      const job = this.jobs.get(jobId);
      if (!job || TERMINAL.has(job.status)) return;
      this.change(jobId, "installing");
      const uploadDeadline = createDeadlineSignal(controller.signal, this.options.uploadTimeoutMs ?? 60_000);
      let upload: Response;
      try {
        upload = await peerFetch(`${baseUrl}/api/peer/sync-sessions/${encodeURIComponent(job.syncId)}/package`, apiKey, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream", "Content-Length": String(job.packageSize) },
          body: fs.createReadStream(packagePath),
          signal: uploadDeadline.signal,
          duplex: "half",
        });
      } catch (error) {
        if (uploadDeadline.timedOut()) throw new SyncSourceError(504, "Peer package upload timed out", "SYNC_UPLOAD_TIMEOUT");
        throw error;
      } finally { uploadDeadline.dispose(); }
      if (!upload.ok) throw await sourceResponseError(upload);
      const current = this.jobs.get(jobId);
      if (current?.withData) {
        if (!dataPath || current.dataSize === null) throw new SyncSourceError(409, "Data archive is unavailable", "SYNC_DATA_REQUIRED");
        const dataDeadline = createDeadlineSignal(controller.signal, this.options.uploadTimeoutMs ?? 60_000);
        let dataUpload: Response;
        try {
          dataUpload = await peerFetch(`${baseUrl}/api/peer/sync-sessions/${encodeURIComponent(current.syncId)}/data`, apiKey, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream", "Content-Length": String(current.dataSize) },
            body: fs.createReadStream(dataPath),
            signal: dataDeadline.signal,
            duplex: "half",
          });
        } catch (error) {
          if (dataDeadline.timedOut()) throw new SyncSourceError(504, "Peer data upload timed out", "SYNC_UPLOAD_TIMEOUT");
          throw error;
        } finally { dataDeadline.dispose(); }
        if (!dataUpload.ok) throw await sourceResponseError(dataUpload);
      }
      if (TERMINAL.has(this.jobs.get(jobId)!.status)) return;
      this.change(jobId, "activating");
      await this.commitUntilTerminal(jobId, baseUrl, apiKey, controller);
    } catch (error) {
      if (!TERMINAL.has(this.jobs.get(jobId)?.status ?? "failed")) this.fail(jobId, error);
    } finally {
      cleanupData?.();
      this.controllers.delete(jobId);
      this.activePeers.delete(jobId);
    }
  }

  private async commitUntilTerminal(jobId: string, baseUrl: string, apiKey: string, controller: AbortController): Promise<void> {
    const job = this.jobs.get(jobId)!;
    const timeoutMs = this.options.commitTimeoutMs ?? 60_000;
    const deadlineAt = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadlineAt) {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Synchronization cancelled");
      const remaining = Math.max(1, deadlineAt - Date.now());
      const deadline = createDeadlineSignal(controller.signal, remaining);
      try {
        const response = await peerFetch(`${baseUrl}/api/peer/sync-sessions/${encodeURIComponent(job.syncId)}/commit`, apiKey, {
          method: "POST", signal: deadline.signal,
        });
        if (response.ok) {
          let backupId: string | null;
          try {
            backupId = await validatedCommitBackupId(response, job);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Target commit response is invalid";
            this.change(jobId, "recovery-required", message);
            return;
          }
          this.change(jobId, "completed", undefined, backupId ?? undefined);
          return;
        }
        const error = await sourceResponseError(response);
        if (error.code !== "SYNC_COMMIT_IN_PROGRESS") {
          this.change(jobId, ["APP_INSTALL_RECOVERY_REQUIRED", "SYNC_RECOVERY_REQUIRED", "APP_DATA_ROLLBACK_FAILED"].includes(error.code)
            ? "recovery-required" : "failed", error.message);
          return;
        }
        lastError = error;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = error;
      } finally { deadline.dispose(); }
      const delay = Math.min(this.options.commitRetryDelayMs ?? 100, Math.max(0, deadlineAt - Date.now()));
      if (delay > 0) await abortableDelay(delay, controller.signal);
    }
    this.change(jobId, "recovery-required", lastError instanceof Error
      ? "Target commit outcome could not be verified before the deadline"
      : "Target commit deadline expired before its outcome could be verified");
  }

  private fail(id: string, error: unknown): SyncJobRecord {
    return this.change(id, "failed", error instanceof SyncSourceError ? error.message : "Synchronization failed");
  }

  private change(id: string, status: SyncJobStatus, error?: string, backupId?: string): SyncJobRecord {
    const job = this.jobs.transition(id, status, error, backupId);
    this.events(id).emit("status", job);
    return job;
  }
}

async function validatedCommitBackupId(response: Response, job: SyncJobRecord): Promise<string | null> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (body?.success !== true || !isRecord(body.data)) throw new Error("Target commit response is invalid");
  const session = body.data.session;
  const outcome = body.data.outcome;
  if (!isRecord(session) || session.id !== job.syncId || session.status !== "completed"
    || session.appName !== job.appName || session.appVersion !== job.appVersion
    || session.packageDigest !== job.packageDigest || !isRecord(outcome)
    || outcome.name !== job.appName || outcome.appVersion !== job.appVersion
    || outcome.digest !== job.packageDigest) {
    throw new Error("Target commit response does not match the synchronization job");
  }
  const backupId = body.data.backupId;
  if (job.withData) {
    if (typeof backupId !== "string" || !isAppBackupId(backupId)) {
      throw new Error("Target data synchronization did not return a valid safety backup ID");
    }
    return backupId;
  }
  if (backupId !== null) throw new Error("Target application-only synchronization returned an unexpected backup ID");
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function activePackage(dataDir: string, ownerId: string, appName: string): Promise<{ path: string; appVersion: string; localVersion: number; digest: string; size: number }> {
  const meta = readPageMeta(dataDir, ownerId, appName);
  if (!meta) throw new SyncSourceError(404, "Application not found", "APP_NOT_FOUND");
  const active = meta.versions.find((entry) => entry.version === meta.currentVersion);
  if (!active?.appVersion || !active.digest || !active.packagePath) {
    throw new SyncSourceError(409, "Active application version has no retained portable package", "APP_PACKAGE_NOT_RETAINED");
  }
  const pageDir = path.resolve(getPageDir(dataDir, ownerId, appName));
  const packageRoot = path.join(pageDir, ".packages");
  const packagePath = path.resolve(pageDir, active.packagePath);
  if (path.dirname(packagePath) !== packageRoot || !fs.existsSync(packagePath)) {
    throw new SyncSourceError(409, "Active application package is unavailable", "APP_PACKAGE_NOT_RETAINED");
  }
  const inspected = await inspectAppPackage(packagePath);
  if (inspected.name !== appName || inspected.version !== active.appVersion || inspected.digest !== active.digest) {
    throw new SyncSourceError(409, "Retained application package does not match active metadata", "APP_PACKAGE_MISMATCH");
  }
  return { path: packagePath, appVersion: active.appVersion, localVersion: active.version, digest: active.digest, size: fs.statSync(packagePath).size };
}

type NodeRequestInit = Omit<RequestInit, "body"> & { body?: RequestInit["body"] | NodeJS.ReadableStream; duplex?: "half" };

async function peerFetch(url: string, apiKey: string, init: NodeRequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: "error",
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${apiKey}` },
  } as unknown as RequestInit);
}

async function sourceResponseError(response: Response): Promise<SyncSourceError> {
  const body = await response.json().catch(() => null) as { code?: unknown; error?: unknown } | null;
  const code = typeof body?.code === "string" && PEER_ERROR_CODES.has(body.code) ? body.code : "PEER_SYNC_FAILED";
  return new SyncSourceError(response.status, `Peer synchronization failed (${response.status})`, code);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function createDeadlineSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal; timedOut: () => boolean; dispose: () => void;
} {
  const controller = new AbortController();
  let timeout = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => { timeout = true; controller.abort(new Error("deadline exceeded")); }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", abortFromParent); },
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    function done() { signal.removeEventListener("abort", abort); resolve(); }
    signal.addEventListener("abort", abort, { once: true });
  });
}
