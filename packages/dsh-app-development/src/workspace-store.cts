import { initializeExecutionSchema } from "./execution-schema.cjs";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { Database } from "sql.js";
import { resolveWorkspacePath } from "@localapp/dsh-app-platform/workspace-path";
import type { TaskRecord } from "./task-types.cjs";
export interface WorkspaceTaskRunner {
  start(input: { workspaceId: string; kind: "build"; executable: string; args: string[]; timeoutMs: number; requestedBy: string }): Promise<TaskRecord>;
}
export interface WorkspacePersistence { database(): Database; flush(): void; }
import { ProcessTreeController } from "./process-tree.cjs";

export interface WorkspaceRecord {
  id: string;
  ownerId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceArchiveLimits {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxFileEntries: number;
}

export interface WorkspaceStoreOptions {
  workspaceDir: string;
  archiveLimits?: Partial<WorkspaceArchiveLimits>;
  authorizeExecution?: (userId: string) => boolean;
  fileOperations?: Partial<WorkspaceFileOperations>;
  gitExecutable?: string;
  cloneTimeoutMs?: number;
  processController?: ProcessTreeController;
}

export interface WorkspaceFileOperations {
  openSync: typeof fs.openSync;
  renameSync: typeof fs.renameSync;
}

const DEFAULT_ARCHIVE_LIMITS: WorkspaceArchiveLimits = {
  maxCompressedBytes: 100 * 1024 * 1024,
  maxExpandedBytes: 500 * 1024 * 1024,
  maxFileEntries: 10_000,
};

export class WorkspaceStore {
  readonly workspaceDir: string;
  readonly archiveLimits: WorkspaceArchiveLimits;
  private taskRunner: WorkspaceTaskRunner | null = null;
  private stopped = false;
  private assertActive(): void {
    if (this.stopped) throw new Error("Workspace store is stopped");
  }
  private readonly cloneProcesses = new Set<ActiveClone>();
  private readonly archiveImports = new Set<Promise<WorkspaceRecord>>();
  private readonly fileOperations: WorkspaceFileOperations;
  private readonly processController: ProcessTreeController;

  constructor(private readonly options: WorkspaceStoreOptions, private readonly persistence: WorkspacePersistence) {
    initializeExecutionSchema(persistence.database());
    persistence.flush();
    const workspaceDir = path.resolve(options.workspaceDir);
    this.archiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.archiveLimits };
    this.fileOperations = {
      openSync: options.fileOperations?.openSync ?? fs.openSync,
      renameSync: options.fileOperations?.renameSync ?? fs.renameSync,
    };
    this.processController = options.processController ?? new ProcessTreeController();
    fs.mkdirSync(workspaceDir, { recursive: true });
    this.workspaceDir = fs.realpathSync(workspaceDir);
  }

  setTaskRunner(taskRunner: WorkspaceTaskRunner): void {
    this.assertActive();
    this.taskRunner = taskRunner;
  }

  async create(input: { name: string; ownerId: string }): Promise<WorkspaceRecord> {
    this.assertActive();
    const name = requireName(input.name);
    const id = randomUUID();
    const temporary = this.temporaryPath(id);
    const destination = this.pathFor(id);
    fs.mkdirSync(temporary, { recursive: true });
    try {
      fs.renameSync(temporary, destination);
      return this.insert({ id, ownerId: input.ownerId, name });
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async clone(input: { name: string; ownerId: string; repositoryUrl: string; signal?: AbortSignal; timeoutMs?: number }): Promise<WorkspaceRecord> {
    this.assertActive();
    const name = requireName(input.name);
    const repositoryUrl = input.repositoryUrl.trim();
    if (!repositoryUrl) throw new Error("Repository URL is required");
    if (path.isAbsolute(repositoryUrl) || /^file:/i.test(repositoryUrl)) {
      throw new Error("Repository URL must not reference an absolute local path");
    }
    if (repositoryUrl.startsWith("-")) throw new Error("Repository URL is invalid");
    if (!isRemoteRepositoryUrl(repositoryUrl)) throw new Error("Repository URL must not reference a local path");
    const authorized = this.options.authorizeExecution?.(input.ownerId) ?? false;
    if (!authorized) throw new Error("ADMIN_EXECUTION_REQUIRED");

    const id = randomUUID();
    const temporary = this.temporaryPath(id);
    const destination = this.pathFor(id);
    try {
      await this.runGitClone(repositoryUrl, temporary, input.signal, input.timeoutMs);
      this.assertActive();
      fs.renameSync(temporary, destination);
      return this.insert({ id, ownerId: input.ownerId, name });
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async importArchive(input: { name: string; ownerId: string; archivePath: string }): Promise<WorkspaceRecord> {
    this.assertActive();
    const importing = this.importArchiveSource(input);
    this.archiveImports.add(importing);
    try { return await importing; }
    finally { this.archiveImports.delete(importing); }
  }

  private async importArchiveSource(input: { name: string; ownerId: string; archivePath: string }): Promise<WorkspaceRecord> {
    const name = requireName(input.name);
    const archivePath = path.resolve(input.archivePath);
    const archiveSize = fs.statSync(archivePath).size;
    if (archiveSize > this.archiveLimits.maxCompressedBytes) throw archiveLimitError("compressed size");

    const id = randomUUID();
    const temporary = this.temporaryPath(id);
    const destination = this.pathFor(id);
    fs.mkdirSync(temporary, { recursive: true });
    try {
      await extractArchive(archivePath, temporary, this.archiveLimits);
      this.assertActive();
      fs.renameSync(temporary, destination);
      return this.insert({ id, ownerId: input.ownerId, name });
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }

  list(ownerId: string): WorkspaceRecord[] {
    const statement = this.persistence.database().prepare("SELECT * FROM workspaces WHERE owner_id = ? ORDER BY created_at DESC, id DESC");
    statement.bind([ownerId]);
    const records: WorkspaceRecord[] = [];
    while (statement.step()) records.push(workspaceFromRow(statement.getAsObject()));
    statement.free();
    return records;
  }

  get(id: string): WorkspaceRecord | null {
    const statement = this.persistence.database().prepare("SELECT * FROM workspaces WHERE id = ?");
    statement.bind([id]);
    const record = statement.step() ? workspaceFromRow(statement.getAsObject()) : null;
    statement.free();
    return record;
  }

  getOwned(id: string, ownerId: string): WorkspaceRecord | null {
    const record = this.get(id);
    return record?.ownerId === ownerId ? record : null;
  }

  pathFor(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid workspace ID");
    return path.join(this.workspaceDir, id);
  }

  requireOwnedPath(id: string, ownerId: string): string {
    if (!this.getOwned(id, ownerId)) throw new Error("WORKSPACE_NOT_FOUND");
    const workspacePath = this.pathFor(id);
    const workspaceStat = fs.lstatSync(workspacePath, { throwIfNoEntry: false });
    if (!workspaceStat?.isDirectory() || workspaceStat.isSymbolicLink()) throw new Error("WORKSPACE_NOT_FOUND");
    if (fs.realpathSync(workspacePath) !== workspacePath) throw new Error("WORKSPACE_NOT_FOUND");
    return workspacePath;
  }

  async readFile(id: string, ownerId: string, relativePath: string): Promise<string> {
    const workspacePath = this.requireOwnedPath(id, ownerId);
    const filePath = resolveWorkspacePath(workspacePath, relativePath);
    let descriptor: number;
    try {
      descriptor = this.fileOperations.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") throw workspaceBoundaryChanged();
      if (code === "ENOENT" || code === "ENOTDIR") throw new Error("WORKSPACE_FILE_NOT_FOUND");
      throw error;
    }
    try {
      const identity = fs.fstatSync(descriptor);
      if (!identity.isFile()) throw new Error("WORKSPACE_FILE_NOT_FOUND");
      assertStableWorkspaceFile(workspacePath, relativePath, filePath, identity);
      return fs.readFileSync(descriptor, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  }

  async writeFile(id: string, ownerId: string, relativePath: string, content: string | Buffer): Promise<void> {
    this.assertActive();
    const workspacePath = this.requireOwnedPath(id, ownerId);
    const filePath = resolveWorkspacePath(workspacePath, relativePath);
    const parentPath = path.dirname(filePath);
    fs.mkdirSync(parentPath, { recursive: true });
    assertStableWorkspaceDirectory(workspacePath, path.relative(workspacePath, parentPath), parentPath);
    const temporaryPath = path.join(parentPath, `.localapp-write-${randomUUID()}.tmp`);
    const descriptor = this.fileOperations.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    let published = false;
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
      const identity = fs.fstatSync(descriptor);
      assertStableWorkspaceFile(workspacePath, path.relative(workspacePath, temporaryPath), temporaryPath, identity);
      const target = fs.lstatSync(filePath, { throwIfNoEntry: false });
      if (target?.isSymbolicLink()) throw workspaceBoundaryChanged();
      this.fileOperations.renameSync(temporaryPath, filePath);
      published = true;
      assertStableWorkspaceFile(workspacePath, relativePath, filePath, identity);
    } finally {
      fs.closeSync(descriptor);
      if (!published) fs.rmSync(temporaryPath, { force: true });
    }
    const now = new Date().toISOString();
    this.persistence.database().run("UPDATE workspaces SET updated_at = ? WHERE id = ? AND owner_id = ?", [now, id, ownerId]);
    this.persistence.flush();
  }

  async remove(id: string, ownerId: string): Promise<boolean> {
    this.assertActive();
    const record = this.getOwned(id, ownerId);
    if (!record) return false;
    const workspacePath = this.requireOwnedPath(id, ownerId);
    const identity = fs.lstatSync(workspacePath);
    const tombstone = path.join(this.workspaceDir, `.delete-${id}-${randomUUID()}`);
    this.fileOperations.renameSync(workspacePath, tombstone);
    const moved = fs.lstatSync(tombstone, { throwIfNoEntry: false });
    if (!moved || moved.isSymbolicLink() || moved.dev !== identity.dev || moved.ino !== identity.ino) {
      if (moved?.isSymbolicLink()) fs.unlinkSync(tombstone);
      throw workspaceBoundaryChanged();
    }
    if (path.dirname(fs.realpathSync(tombstone)) !== this.workspaceDir) throw workspaceBoundaryChanged();
    fs.rmSync(tombstone, { recursive: true, force: true });
    this.persistence.database().run("DELETE FROM workspaces WHERE id = ? AND owner_id = ?", [id, ownerId]);
    this.persistence.flush();
    return true;
  }

  async build(id: string, requestedBy: string, timeoutMs = 15 * 60_000): Promise<TaskRecord> {
    this.assertActive();
    return this.requireTaskRunner().start({
      workspaceId: id,
      kind: "build",
      executable: "npm",
      args: ["run", "build"],
      timeoutMs,
      requestedBy,
    });
  }

  async install(id: string, requestedBy: string, timeoutMs = 15 * 60_000): Promise<TaskRecord> {
    this.assertActive();
    return this.requireTaskRunner().start({
      workspaceId: id,
      kind: "build",
      executable: "localapp",
      args: ["upload"],
      timeoutMs,
      requestedBy,
    });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const active = [...this.cloneProcesses];
    await Promise.all(active.map((clone) => clone.cancel(new Error("Git clone terminated during Server shutdown"))));
    await Promise.all(active.map((clone) => clone.closed));
    await Promise.allSettled([...this.archiveImports]);
  }

  private insert(input: { id: string; ownerId: string; name: string }): WorkspaceRecord {
    const now = new Date().toISOString();
    this.persistence.database().run(
      "INSERT INTO workspaces (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [input.id, input.ownerId, input.name, now, now],
    );
    this.persistence.flush();
    return { id: input.id, ownerId: input.ownerId, name: input.name, createdAt: now, updatedAt: now };
  }

  private temporaryPath(id: string): string {
    return path.join(this.workspaceDir, `.tmp-${id}-${randomUUID()}`);
  }

  private requireTaskRunner(): WorkspaceTaskRunner {
    if (!this.taskRunner) throw new Error("Task runner is not configured");
    return this.taskRunner;
  }

  private runGitClone(repositoryUrl: string, destination: string, signal?: AbortSignal, requestedTimeoutMs?: number): Promise<void> {
    const timeoutMs = requestedTimeoutMs ?? this.options.cloneTimeoutMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) throw new Error("Invalid Git clone timeout");
    if (signal?.aborted) throw new Error("Git clone aborted");
    const environmentDirectory = path.join(this.workspaceDir, `.git-env-${randomUUID()}`);
    fs.mkdirSync(environmentDirectory, { mode: 0o700 });
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.gitExecutable ?? "git", ["clone", "--", repositoryUrl, destination], {
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe"],
        env: gitEnvironment(environmentDirectory),
        windowsHide: true,
      });
      let stderr = "";
      let settled = false;
      let processClosed = false;
      let requestedError: Error | null = null;
      let closeActive!: () => void;
      const closed = new Promise<void>((close) => { closeActive = close; });
      const cancel = async (error: Error) => {
        if (processClosed || child.exitCode !== null || child.signalCode !== null) return;
        if (!requestedError) requestedError = error;
        if (!child.pid) return;
        await this.processController.signalTree(child.pid, false);
        if (!await waitPromise(closed, 1_000)) {
          await this.processController.signalTree(child.pid, true);
          await waitPromise(closed, 1_000);
        }
      };
      const active: ActiveClone = { child, closed, cancel };
      this.cloneProcesses.add(active);
      const reportCancellationFailure = (error: unknown) => {
        if (!settled) { settled = true; reject(error); }
      };
      const timer = setTimeout(() => { void cancel(new Error("Git clone timed out")).catch(reportCancellationFailure); }, timeoutMs);
      timer.unref();
      const onAbort = () => { void cancel(new Error("Git clone aborted")).catch(reportCancellationFailure); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        processClosed = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.cloneProcesses.delete(active);
        fs.rmSync(environmentDirectory, { recursive: true, force: true });
        closeActive();
      };
      child.stderr!.on("data", (chunk) => {
        if (stderr.length < 64 * 1024) stderr += String(chunk);
      });
      child.once("error", (error) => {
        fs.rmSync(destination, { recursive: true, force: true });
        cleanup();
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once("close", (code, signal) => {
        if (requestedError || code !== 0) fs.rmSync(destination, { recursive: true, force: true });
        cleanup();
        if (settled) return;
        settled = true;
        if (requestedError) reject(requestedError);
        else if (code === 0) resolve();
        else reject(new Error(`Git clone failed (${code ?? signal ?? "signal"}): ${stderr.trim()}`));
      });
    });
  }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function workspaceBoundaryChanged(): Error {
  return new Error("Workspace boundary changed during filesystem operation");
}

function assertStableWorkspaceDirectory(workspacePath: string, relativePath: string, expectedPath: string): void {
  try {
    const resolved = resolveWorkspacePath(workspacePath, relativePath || ".");
    const stat = fs.lstatSync(resolved);
    if (resolved !== expectedPath || stat.isSymbolicLink() || !stat.isDirectory()) throw workspaceBoundaryChanged();
  } catch {
    throw workspaceBoundaryChanged();
  }
}

function assertStableWorkspaceFile(
  workspacePath: string,
  relativePath: string,
  expectedPath: string,
  identity: fs.Stats,
): void {
  try {
    const resolved = resolveWorkspacePath(workspacePath, relativePath);
    const stat = fs.lstatSync(resolved);
    if (resolved !== expectedPath || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw workspaceBoundaryChanged();
    }
  } catch {
    throw workspaceBoundaryChanged();
  }
}

function workspaceFromRow(row: Record<string, unknown>): WorkspaceRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function requireName(value: string): string {
  const name = value?.trim();
  if (!name) throw new Error("Workspace name is required");
  if (Buffer.byteLength(name, "utf8") > 200) throw new Error("Workspace name is too long");
  return name;
}

function isRemoteRepositoryUrl(value: string): boolean {
  if (/^[^@/\s]+@[^:/\s]+:.+$/.test(value)) return true;
  try {
    return ["http:", "https:", "ssh:", "git:", "ftp:", "ftps:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function archiveLimitError(limit: string): Error {
  return new Error(`Workspace archive limit exceeded: ${limit}`);
}

function openArchive(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, zipFile) => {
      if (error || !zipFile) {
        const message = error instanceof Error ? error.message : String(error ?? "Unable to open workspace archive");
        reject(/invalid relative path|invalid characters in filename/i.test(message) ? new Error(`Path crosses workspace boundary: ${message}`) : (error ?? new Error(message)));
      }
      else resolve(zipFile);
    });
  });
}

function openEntry(zipFile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("Unable to read workspace archive entry"));
      else resolve(stream);
    });
  });
}

async function extractArchive(archivePath: string, destination: string, limits: WorkspaceArchiveLimits): Promise<void> {
  const zipFile = await openArchive(archivePath);
  let entries = 0;
  let expandedBytes = 0;
  const seen = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      const message = error instanceof Error ? error.message : String(error);
      reject(/invalid relative path|invalid characters in filename/i.test(message) ? new Error(`Path crosses workspace boundary: ${message}`) : error);
    };
    zipFile.once("error", fail);
    zipFile.once("end", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    zipFile.on("entry", (entry: Entry) => {
      void (async () => {
        entries += 1;
        if (entries > limits.maxFileEntries) throw archiveLimitError("file count");
        const entryName = entry.fileName;
        if (!entryName || entryName.includes("\\") || path.posix.isAbsolute(entryName) || /^[A-Za-z]:/.test(entryName)) {
          throw new Error(`Path crosses workspace boundary: ${entryName}`);
        }
        const normalized = path.posix.normalize(entryName);
        if (normalized === ".." || normalized.startsWith("../") || seen.has(normalized)) {
          throw new Error(`Path crosses workspace boundary: ${entryName}`);
        }
        seen.add(normalized);
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > limits.maxExpandedBytes) throw archiveLimitError("expanded size");

        const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (fileType === 0o120000) throw new Error(`Path crosses workspace boundary: ${entryName}`);
        const outputPath = resolveWorkspacePath(destination, normalized.replace(/\/$/, ""));
        if (entryName.endsWith("/")) {
          fs.mkdirSync(outputPath, { recursive: true });
        } else {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          let actualBytes = 0;
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              actualBytes += chunk.length;
              if (expandedBytes - entry.uncompressedSize + actualBytes > limits.maxExpandedBytes) {
                callback(archiveLimitError("expanded size"));
              } else {
                callback(null, chunk);
              }
            },
          });
          await pipeline(await openEntry(zipFile, entry), counter, fs.createWriteStream(outputPath, { mode: 0o600 }));
        }
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.readEntry();
  });
}

interface ActiveClone {
  child: ChildProcess;
  closed: Promise<void>;
  cancel(error: Error): Promise<void>;
}

function gitEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "SSH_AUTH_SOCK"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

async function waitPromise(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
}
