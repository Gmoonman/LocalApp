import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { MAX_APP_PACKAGE_BYTES } from "./app-package.cjs";
import { removeDirRecursive } from "./file-utils.cjs";

export const MAX_SYNC_DATA_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
export type SyncSessionStatus = "created" | "uploaded" | "committing" | "completed" | "failed" | "recovery-required";
export interface SyncSessionRecord {
  id: string;
  ownerId: string;
  mode: "app-only" | "app-and-data";
  appName: string;
  appVersion: string;
  packageDigest: string;
  packageSize: number;
  dataDigest: string | null;
  dataSize: number | null;
  status: SyncSessionStatus;
  outcome: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class SyncSessionError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode: number) {
    super(message);
    this.name = "SyncSessionError";
  }
}

export class SyncSessionStore {
  readonly rootDir: string;
  private readonly retentionMs: number;

  constructor(options: { dataDir: string; rootDir?: string; retentionMs?: number }) {
    this.rootDir = path.resolve(options.rootDir ?? path.join(options.dataDir, ".staging", "sync"));
    this.retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
  }

  sessionDir(id: string): string {
    assertSessionId(id);
    const directory = path.resolve(this.rootDir, id);
    if (path.dirname(directory) !== this.rootDir) throw new SyncSessionError("SYNC_ID_INVALID", "Invalid synchronization ID", 400);
    return directory;
  }

  create(input: Omit<SyncSessionRecord, "status" | "outcome" | "error" | "createdAt" | "updatedAt" | "dataDigest" | "dataSize"> & {
    dataDigest?: string | null;
    dataSize?: number | null;
  }): SyncSessionRecord {
    const normalized = { ...input, dataDigest: input.dataDigest ?? null, dataSize: input.dataSize ?? null };
    validateInput(normalized);
    const directory = this.sessionDir(normalized.id);
    let existing: SyncSessionRecord | null = null;
    try { existing = this.get(normalized.id); }
    catch (error) {
      if (error instanceof SyncSessionError) throw error;
      if (!isSafeUncommittedResidue(directory)) throw error;
      removeDirRecursive(directory);
      syncDirectory(this.rootDir);
    }
    if (existing) {
      if (!sameIdentity(existing, normalized)) throw new SyncSessionError("SYNC_SESSION_CONFLICT", "Synchronization ID is already used for different metadata", 409);
      syncDirectory(this.rootDir);
      return existing;
    }
    const now = new Date().toISOString();
    const session: SyncSessionRecord = { ...normalized, status: "created", outcome: null, error: null, createdAt: now, updatedAt: now };
    const stagingDirectory = path.join(this.rootDir, `.session-${normalized.id}-${crypto.randomUUID()}.partial`);
    try {
      fs.mkdirSync(stagingDirectory, { mode: 0o700 });
      this.writeInDirectory(session, stagingDirectory);
      try {
        fs.renameSync(stagingDirectory, directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EEXIST", "ENOTEMPTY"].includes(code ?? "")) throw error;
        const raced = this.get(normalized.id);
        if (raced && sameIdentity(raced, normalized)) {
          syncDirectory(this.rootDir);
          return raced;
        }
        throw new SyncSessionError("SYNC_SESSION_CONFLICT", "Synchronization ID is already in use", 409);
      }
      syncDirectory(this.rootDir);
      return this.get(normalized.id)!;
    } finally {
      removeDirRecursive(stagingDirectory);
    }
  }

  get(id: string): SyncSessionRecord | null {
    const metadataPath = path.join(this.sessionDir(id), "session.json");
    if (!fs.existsSync(metadataPath)) return null;
    const value = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as SyncSessionRecord;
    if (value.dataDigest === undefined) value.dataDigest = null;
    if (value.dataSize === undefined) value.dataSize = null;
    validateStored(value, id);
    return value;
  }

  getOwned(id: string, ownerId: string): SyncSessionRecord | null {
    const session = this.get(id);
    return session?.ownerId === ownerId ? session : null;
  }

  list(): SyncSessionRecord[] {
    const sessions: SyncSessionRecord[] = [];
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const session = this.get(entry.name);
        if (session) sessions.push(session);
      } catch { /* corrupt entries are retained for operator recovery */ }
    }
    return sessions;
  }

  packagePath(id: string): string {
    return path.join(this.sessionDir(id), "package.localapp");
  }

  dataPath(id: string): string {
    return path.join(this.sessionDir(id), "data.zip");
  }

  async receivePackage(input: {
    id: string;
    ownerId: string;
    stream: Readable;
    contentLength: number;
    signal?: AbortSignal;
  }): Promise<SyncSessionRecord> {
    const session = this.getOwned(input.id, input.ownerId);
    if (!session) throw new SyncSessionError("SYNC_SESSION_NOT_FOUND", "Synchronization session not found", 404);
    if (input.contentLength !== session.packageSize) throw new SyncSessionError("SYNC_PACKAGE_SIZE_MISMATCH", "Package size does not match session metadata", 400);
    if (input.contentLength > MAX_APP_PACKAGE_BYTES) throw new SyncSessionError("SYNC_PACKAGE_TOO_LARGE", "Package exceeds transfer limit", 413);
    const finalPath = this.packagePath(input.id);
    if ((session.status === "uploaded" || session.status === "completed") && fs.existsSync(finalPath)) {
      const stat = fs.statSync(finalPath);
      if (stat.size === session.packageSize && await sha256File(finalPath) === session.packageDigest) return session;
      throw new SyncSessionError("SYNC_PACKAGE_CONFLICT", "Staged package does not match session metadata", 409);
    }
    if (session.status === "committing") throw new SyncSessionError("SYNC_COMMIT_IN_PROGRESS", "Synchronization commit is in progress", 409);
    if (session.status === "recovery-required") throw new SyncSessionError("SYNC_RECOVERY_REQUIRED", "Synchronization requires operator recovery", 409);
    const partialPath = path.join(this.sessionDir(input.id), `package.${process.pid}.${crypto.randomUUID()}.partial`);
    const handle = await fs.promises.open(partialPath, "wx", 0o600);
    const hash = crypto.createHash("sha256");
    let size = 0;
    try {
      for await (const value of input.stream) {
        if (input.signal?.aborted) throw new SyncSessionError("SYNC_CANCELLED", "Synchronization upload cancelled", 409);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > session.packageSize || size > MAX_APP_PACKAGE_BYTES) {
          throw new SyncSessionError("SYNC_PACKAGE_TOO_LARGE", "Package exceeds declared or configured limit", 413);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (size !== session.packageSize) throw new SyncSessionError("SYNC_PACKAGE_SIZE_MISMATCH", "Uploaded package size mismatch", 400);
      if (hash.digest("hex") !== session.packageDigest) throw new SyncSessionError("SYNC_PACKAGE_DIGEST_MISMATCH", "Uploaded package digest mismatch", 400);
      await handle.sync();
      await handle.close();
      fs.renameSync(partialPath, finalPath);
      syncDirectory(this.sessionDir(input.id));
      return this.transition(input.id, input.ownerId, "uploaded");
    } catch (error) {
      await handle.close().catch(() => undefined);
      fs.rmSync(partialPath, { force: true });
      throw error;
    }
  }

  async receiveData(input: {
    id: string;
    ownerId: string;
    stream: Readable;
    contentLength: number;
    signal?: AbortSignal;
  }): Promise<SyncSessionRecord> {
    const session = this.getOwned(input.id, input.ownerId);
    if (!session) throw new SyncSessionError("SYNC_SESSION_NOT_FOUND", "Synchronization session not found", 404);
    if (session.mode !== "app-and-data" || session.dataDigest === null || session.dataSize === null) {
      throw new SyncSessionError("SYNC_DATA_NOT_EXPECTED", "This synchronization session does not include application data", 409);
    }
    if (!fs.existsSync(this.packagePath(input.id))) {
      throw new SyncSessionError("SYNC_PACKAGE_REQUIRED", "A verified package upload is required before application data", 409);
    }
    if (input.contentLength !== session.dataSize) throw new SyncSessionError("SYNC_DATA_SIZE_MISMATCH", "Data archive size does not match session metadata", 400);
    if (input.contentLength > MAX_SYNC_DATA_ARCHIVE_BYTES) throw new SyncSessionError("SYNC_DATA_TOO_LARGE", "Data archive exceeds transfer limit", 413);
    const finalPath = this.dataPath(input.id);
    if ((session.status === "uploaded" || session.status === "completed") && fs.existsSync(finalPath)) {
      const stat = fs.statSync(finalPath);
      if (stat.size === session.dataSize && await sha256File(finalPath) === session.dataDigest) return session;
      throw new SyncSessionError("SYNC_DATA_CONFLICT", "Staged data archive does not match session metadata", 409);
    }
    if (session.status === "committing") throw new SyncSessionError("SYNC_COMMIT_IN_PROGRESS", "Synchronization commit is in progress", 409);
    if (session.status === "recovery-required") throw new SyncSessionError("SYNC_RECOVERY_REQUIRED", "Synchronization requires operator recovery", 409);
    const partialPath = path.join(this.sessionDir(input.id), `data.${process.pid}.${crypto.randomUUID()}.partial`);
    const handle = await fs.promises.open(partialPath, "wx", 0o600);
    const hash = crypto.createHash("sha256");
    let size = 0;
    try {
      for await (const value of input.stream) {
        if (input.signal?.aborted) throw new SyncSessionError("SYNC_CANCELLED", "Synchronization upload cancelled", 409);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > session.dataSize || size > MAX_SYNC_DATA_ARCHIVE_BYTES) {
          throw new SyncSessionError("SYNC_DATA_TOO_LARGE", "Data archive exceeds declared or configured limit", 413);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (size !== session.dataSize) throw new SyncSessionError("SYNC_DATA_SIZE_MISMATCH", "Uploaded data archive size mismatch", 400);
      if (hash.digest("hex") !== session.dataDigest) throw new SyncSessionError("SYNC_DATA_DIGEST_MISMATCH", "Uploaded data archive digest mismatch", 400);
      await handle.sync();
      await handle.close();
      fs.renameSync(partialPath, finalPath);
      syncDirectory(this.sessionDir(input.id));
      return this.transition(input.id, input.ownerId, "uploaded");
    } catch (error) {
      await handle.close().catch(() => undefined);
      fs.rmSync(partialPath, { force: true });
      throw error;
    }
  }

  transition(id: string, ownerId: string, status: SyncSessionStatus, input?: { outcome?: Record<string, unknown>; error?: string }): SyncSessionRecord {
    const session = this.getOwned(id, ownerId);
    if (!session) throw new SyncSessionError("SYNC_SESSION_NOT_FOUND", "Synchronization session not found", 404);
    if (session.status === "completed") return session;
    const next: SyncSessionRecord = {
      ...session,
      status,
      outcome: input?.outcome ?? session.outcome,
      error: input?.error ?? (status === "failed" ? session.error : null),
      updatedAt: new Date().toISOString(),
    };
    this.write(next);
    return next;
  }

  remove(id: string, ownerId: string): boolean {
    const session = this.getOwned(id, ownerId);
    if (!session) return false;
    if (session.status === "committing" || session.status === "completed" || session.status === "recovery-required") {
      throw new SyncSessionError("SYNC_CANNOT_CANCEL", "Synchronization can no longer be cancelled", 409);
    }
    removeDirRecursive(this.sessionDir(id));
    syncDirectory(this.rootDir);
    return true;
  }

  prune(now = Date.now()): number {
    let removed = 0;
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.rootDir, entry.name);
      const age = now - fs.statSync(directory).mtimeMs;
      if (entry.name.startsWith(".session-") && entry.name.endsWith(".partial")) {
        if (age > this.retentionMs) { removeDirRecursive(directory); removed += 1; }
        continue;
      }
      let session: SyncSessionRecord | null;
      try { session = this.get(entry.name); }
      catch {
        if (age > this.retentionMs && isSafeUncommittedResidue(directory)) {
          removeDirRecursive(directory);
          removed += 1;
        }
        continue;
      }
      if (!session) {
        if (age > this.retentionMs && isSafeUncommittedResidue(directory)) {
          removeDirRecursive(directory);
          removed += 1;
        }
        continue;
      }
      if (session.status === "committing" || session.status === "completed" || session.status === "recovery-required") continue;
      if (age <= this.retentionMs) continue;
      removeDirRecursive(this.sessionDir(entry.name));
      removed += 1;
    }
    if (removed > 0) syncDirectory(this.rootDir);
    return removed;
  }

  private write(session: SyncSessionRecord): void {
    const directory = this.sessionDir(session.id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.writeInDirectory(session, directory);
  }

  private writeInDirectory(session: SyncSessionRecord, directory: string): void {
    const finalPath = path.join(directory, "session.json");
    const tempPath = path.join(directory, `.session.${process.pid}.${crypto.randomUUID()}.partial`);
    try {
      const descriptor = fs.openSync(tempPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(session)}\n`);
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      fs.renameSync(tempPath, finalPath);
      syncDirectory(directory);
    } finally { fs.rmSync(tempPath, { force: true }); }
  }
}

function isSafeUncommittedResidue(directory: string): boolean {
  if (!fs.existsSync(directory)) return true;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { return false; }
  return entries.every((entry) => entry.isFile()
    && (entry.name === "session.json" || entry.name.startsWith(".session.") || entry.name.endsWith(".partial")))
    && !entries.some((entry) => entry.name === "package.localapp" || entry.name === "data.zip");
}

function validateInput(input: { id: string; ownerId: string; mode: string; appName: string; appVersion: string; packageDigest: string; packageSize: number; dataDigest?: string | null; dataSize?: number | null }): void {
  assertSessionId(input.id);
  if (!input.ownerId || !input.appName || !input.appVersion) throw new SyncSessionError("SYNC_METADATA_INVALID", "Synchronization metadata is incomplete", 400);
  if (input.mode !== "app-only" && input.mode !== "app-and-data") throw new SyncSessionError("SYNC_MODE_UNSUPPORTED", "Unsupported synchronization mode", 400);
  if (!/^[a-f0-9]{64}$/.test(input.packageDigest)) throw new SyncSessionError("SYNC_DIGEST_INVALID", "Package digest must be lowercase SHA-256", 400);
  if (!Number.isSafeInteger(input.packageSize) || input.packageSize < 1) throw new SyncSessionError("SYNC_SIZE_INVALID", "Package size must be a positive integer", 400);
  if (input.packageSize > MAX_APP_PACKAGE_BYTES) throw new SyncSessionError("SYNC_PACKAGE_TOO_LARGE", "Package exceeds transfer limit", 413);
  if (input.mode === "app-and-data") {
    if (typeof input.dataDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.dataDigest)) throw new SyncSessionError("SYNC_DATA_DIGEST_INVALID", "Data digest must be lowercase SHA-256", 400);
    if (typeof input.dataSize !== "number" || !Number.isSafeInteger(input.dataSize) || input.dataSize < 1) throw new SyncSessionError("SYNC_DATA_SIZE_INVALID", "Data archive size must be a positive integer", 400);
    if (input.dataSize > MAX_SYNC_DATA_ARCHIVE_BYTES) throw new SyncSessionError("SYNC_DATA_TOO_LARGE", "Data archive exceeds transfer limit", 413);
  } else if (input.dataDigest !== null && input.dataDigest !== undefined || input.dataSize !== null && input.dataSize !== undefined) {
    throw new SyncSessionError("SYNC_DATA_NOT_EXPECTED", "Application-only synchronization cannot include data metadata", 400);
  }
}

function validateStored(value: SyncSessionRecord, id: string): void {
  try {
    if (value.id !== id) throw new Error("identity mismatch");
    validateInput(value);
    if (!["created", "uploaded", "committing", "completed", "failed", "recovery-required"].includes(value.status)) {
      throw new Error("invalid status");
    }
    if (value.outcome !== null && (typeof value.outcome !== "object" || Array.isArray(value.outcome))) throw new Error("invalid outcome");
    if (value.error !== null && typeof value.error !== "string") throw new Error("invalid error");
    if (typeof value.createdAt !== "string" || !value.createdAt || typeof value.updatedAt !== "string" || !value.updatedAt) {
      throw new Error("invalid timestamps");
    }
  } catch (error) {
    throw new SyncSessionError("SYNC_SESSION_CORRUPT", "Invalid synchronization session metadata", 500);
  }
}

function sameIdentity(left: SyncSessionRecord, right: Pick<SyncSessionRecord, "ownerId" | "mode" | "appName" | "appVersion" | "packageDigest" | "packageSize"> & { dataDigest?: string | null; dataSize?: number | null }): boolean {
  return left.ownerId === right.ownerId && left.mode === right.mode && left.appName === right.appName
    && left.appVersion === right.appVersion && left.packageDigest === right.packageDigest && left.packageSize === right.packageSize
    && left.dataDigest === (right.dataDigest ?? null) && left.dataSize === (right.dataSize ?? null);
}

function assertSessionId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new SyncSessionError("SYNC_ID_INVALID", "Invalid synchronization ID", 400);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EINVAL", "EPERM", "EISDIR"].includes(code ?? "")) return;
    throw error;
  }
}
