import { EventEmitter, once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TaskStore, type TaskKind, type TaskRecord, type TaskStatus } from "./task-store.cjs";
import type { WorkspaceStore } from "./workspace-store.cjs";
import { ProcessTreeController } from "./process-tree.cjs";

export type { TaskRecord } from "./task-store.cjs";

export interface StartTaskInput {
  workspaceId: string;
  kind: "build" | "test" | "git" | "agent";
  executable: string;
  args: string[];
  timeoutMs: number;
  requestedBy: string;
  logParser?: (line: string) => { type: "text"; text: string };
}

export interface TaskLogChunk {
  cursor: number;
  nextCursor: number;
  content: string;
  eof: boolean;
}

export interface TaskEvent {
  type: "status" | "log";
  taskId: string;
  status: TaskStatus;
  task: TaskRecord;
  content?: string;
  cursor?: number;
}

export interface TaskRunnerOptions {
  workspaceStore: WorkspaceStore;
  taskStore: TaskStore;
  taskDir: string;
  supervisorPath: string;
  allowedExecutables?: Record<string, string>;
  authorizeExecution?: (userId: string) => boolean;
  processController?: ProcessTreeController;
  platform?: NodeJS.Platform;
}

interface ActiveTask {
  child: ChildProcess;
  readyPath: string;
  startPath: string;
  desiredStatus: Exclude<TaskStatus, "running" | "succeeded" | "failed"> | null;
  timer: NodeJS.Timeout | null;
  closed: Promise<void>;
}

const MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_LOG_CHUNK_BYTES = 64 * 1024;
const DEFAULT_EXECUTABLES = ["node", "npm", "pnpm", "git", "localapp", "codex", "opencode"] as const;

export class TaskRunner {
  private stopped = false;
  private readonly active = new Map<string, ActiveTask>();
  private readonly emitters = new Map<string, EventEmitter>();
  private readonly allowedExecutables = new Map<string, string>();
  private readonly processController: ProcessTreeController;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: TaskRunnerOptions) {
    this.platform = options.platform ?? process.platform;
    this.processController = options.processController ?? new ProcessTreeController();
    fs.mkdirSync(options.taskDir, { recursive: true });
    for (const executable of DEFAULT_EXECUTABLES) {
      const resolved = executable === "node" ? process.execPath : findExecutable(executable, { platform: this.platform });
      if (resolved) this.allowedExecutables.set(executable, resolved);
    }
    for (const [name, executablePath] of Object.entries(options.allowedExecutables ?? {})) {
      this.setAllowedExecutable(name, executablePath);
    }
  }

  setAllowedExecutable(name: string, executablePath: string): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error("Invalid executable allowlist name");
    const resolved = fs.realpathSync(executablePath);
    if (!fs.statSync(resolved).isFile()) throw new Error("Allowlisted executable is not a file");
    if (this.platform === "win32") {
      if (!isDirectWindowsExecutable(resolved)) throw new Error("Allowlisted Windows executable cannot be launched with shell:false");
    } else {
      try {
        fs.accessSync(resolved, fs.constants.X_OK);
      } catch {
        throw new Error("Allowlisted executable is not executable");
      }
    }
    this.allowedExecutables.set(name, resolved);
  }

  resolveAllowedExecutable(name: string): string | null {
    return this.allowedExecutables.get(name) ?? null;
  }

  async start(input: StartTaskInput): Promise<TaskRecord> {
    if (this.stopped) throw new Error("Task runner is stopped");
    validateStartInput(input);
    const authorized = this.options.authorizeExecution?.(input.requestedBy) ?? false;
    if (!authorized) throw new Error("ADMIN_EXECUTION_REQUIRED");
    const workspacePath = this.options.workspaceStore.requireOwnedPath(input.workspaceId, input.requestedBy);
    const executablePath = this.allowedExecutables.get(input.executable);
    if (!executablePath) throw new Error(`Executable is not an allowlisted executable: ${input.executable}`);

    const id = randomUUID();
    const outputPath = path.join(this.options.taskDir, `${id}.log`);
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    let record: TaskRecord;
    try {
      record = this.options.taskStore.create({ ...input, id, outputPath, status: "running" });
    } catch (error) {
      fs.rmSync(outputPath, { force: true });
      throw error;
    }

    const emitter = new EventEmitter();
    this.emitters.set(record.id, emitter);
    const output = input.logParser ? null : fs.openSync(outputPath, "a");
    const identityToken = randomUUID();
    const readyPath = path.join(this.options.taskDir, `${id}.supervisor-ready`);
    const startPath = path.join(this.options.taskDir, `${id}.supervisor-start`);
    const supervisorArgs = [
      this.options.supervisorPath,
      identityToken,
      readyPath,
      startPath,
      executablePath,
      Buffer.from(JSON.stringify(input.args), "utf8").toString("base64url"),
    ];
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, supervisorArgs, {
        cwd: workspacePath,
        env: boundedEnvironment(),
        shell: false,
        detached: this.platform !== "win32",
        stdio: input.logParser ? ["ignore", "pipe", "pipe"] : ["ignore", output!, output!],
        windowsHide: true,
      });
    } catch (error) {
      if (output !== null) fs.closeSync(output);
      const failure = this.finishSpawnFailure(record.id, error);
      setImmediate(() => this.emitters.delete(record.id));
      return Promise.reject(failure);
    }
    if (output !== null) fs.closeSync(output);
    if (input.logParser) {
      this.attachParsedOutput(record.id, child.stdout!, input.logParser, outputPath);
      this.attachParsedOutput(record.id, child.stderr!, input.logParser, outputPath);
    }
    let closeActive!: () => void;
    const closed = new Promise<void>((resolve) => { closeActive = resolve; });
    const active: ActiveTask = { child, readyPath, startPath, desiredStatus: null, timer: null, closed };
    this.active.set(record.id, active);

    child.once("close", (code, signal) => {
      if (active.timer) clearTimeout(active.timer);
      cleanupSupervisorHandshake(active);
      this.active.delete(record.id);
      const current = this.options.taskStore.get(record.id);
      if (current?.status === "running") {
        const desired = active.desiredStatus;
        const status = desired ?? (code === 0 ? "succeeded" : "failed");
        const finished = this.options.taskStore.finish(record.id, status, {
          exitCode: code,
          error: status === "failed" ? `Process exited with ${code ?? signal ?? "unknown status"}` : null,
        });
        this.emit(record.id, finished);
      }
      closeActive();
      setImmediate(() => this.emitters.delete(record.id));
    });
    child.once("error", (error) => {
      if (active.timer) clearTimeout(active.timer);
      cleanupSupervisorHandshake(active);
      this.active.delete(record.id);
      const current = this.options.taskStore.get(record.id);
      if (current?.status === "running") {
        const failed = this.options.taskStore.finish(record.id, "failed", { error: boundedError(error) });
        this.emit(record.id, failed);
      }
      closeActive();
      setImmediate(() => this.emitters.delete(record.id));
    });

    try {
      await once(child, "spawn");
    } catch (error) {
      const current = this.options.taskStore.get(record.id);
      if (current?.status === "running") this.finishSpawnFailure(record.id, error);
      throw error;
    }

    if (!child.pid) {
      const error = new Error("Spawned task has no process ID");
      this.finishSpawnFailure(record.id, error);
      throw error;
    }
    let started: TaskRecord;
    try {
      await waitForSupervisorReady(child, readyPath, identityToken);
      const processIdentity = await this.processController.processIdentity(child.pid);
      if (!processIdentity || !processIdentity.includes(identityToken) || !processIdentity.includes("task-supervisor.mjs")) {
        throw new Error("Unable to establish task process identity");
      }
      started = this.options.taskStore.setPid(record.id, child.pid, processIdentity);
      if (this.stopped) throw new Error("Task runner is stopped");
      writeDurableExclusive(startPath, identityToken);
    } catch (error) {
      await this.processController.terminateAndWait(child.pid).catch(() => undefined);
      const current = this.options.taskStore.get(record.id);
      if (current?.status === "running") this.finishSpawnFailure(record.id, error);
      throw error;
    }
    active.timer = setTimeout(() => void this.terminate(record.id, "timed_out"), input.timeoutMs);
    active.timer.unref();

    this.emit(record.id, started);
    return started;
  }

  async cancel(id: string): Promise<TaskRecord> {
    const record = this.options.taskStore.get(id);
    if (!record) throw new Error("TASK_NOT_FOUND");
    if (record.status !== "running") return record;
    await this.terminate(id, "cancelled");
    return this.options.taskStore.get(id)!;
  }

  logs(id: string, cursor: number): TaskLogChunk {
    const outputPath = this.options.taskStore.outputPath(id);
    if (!outputPath) throw new Error("TASK_NOT_FOUND");
    const size = fs.statSync(outputPath, { throwIfNoEntry: false })?.size ?? 0;
    let safeCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? Math.min(cursor, size) : 0;
    const descriptor = fs.openSync(outputPath, "r");
    try {
      while (safeCursor < size && isUtf8Continuation(readByte(descriptor, safeCursor))) safeCursor += 1;
      let end = Math.min(safeCursor + MAX_LOG_CHUNK_BYTES, size);
      if (end < size && isUtf8Continuation(readByte(descriptor, end))) {
        do { end -= 1; } while (end > safeCursor && isUtf8Continuation(readByte(descriptor, end)));
      }
      const length = end - safeCursor;
      const buffer = Buffer.alloc(length);
      if (length > 0) fs.readSync(descriptor, buffer, 0, length, safeCursor);
      return { cursor: safeCursor, nextCursor: end, content: buffer.toString("utf8"), eof: end >= size };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  events(id: string): EventEmitter {
    let emitter = this.emitters.get(id);
    if (!emitter) {
      emitter = new EventEmitter();
      this.emitters.set(id, emitter);
    }
    return emitter;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.active.keys()].map((id) => this.terminate(id, "interrupted")));
  }

  async reconcileRunning(): Promise<number> {
    const running = this.options.taskStore.listRunning();
    for (const task of running) {
      if (task.pid && task.processIdentity) {
        const liveIdentity = await this.processController.processIdentity(task.pid);
        if (liveIdentity === task.processIdentity) await this.processController.terminateAndWait(task.pid);
      }
      this.options.taskStore.finish(task.id, "interrupted", { error: "Server restarted while task was running" });
    }
    return running.length;
  }

  private async terminate(id: string, status: "cancelled" | "timed_out" | "interrupted"): Promise<void> {
    const active = this.active.get(id);
    if (!active) {
      const record = this.options.taskStore.get(id);
      if (record?.status === "running") this.emit(id, this.options.taskStore.finish(id, status));
      return;
    }
    if (!active.desiredStatus) active.desiredStatus = status;
    if (active.child.pid) await this.processController.signalTree(active.child.pid, false);
    const closedAfterTerm = await waitBounded(active.closed, 1_000);
    if (!closedAfterTerm) {
      if (active.child.pid) await this.processController.signalTree(active.child.pid, true);
      await waitBounded(active.closed, 1_000);
    }
    const current = this.options.taskStore.get(id);
    if (current?.status === "running") this.emit(id, this.options.taskStore.finish(id, status));
  }

  private finishSpawnFailure(id: string, error: unknown): Error {
    const failed = this.options.taskStore.finish(id, "failed", { error: boundedError(error) });
    this.emit(id, failed);
    return error instanceof Error ? error : new Error(String(error));
  }

  private emit(id: string, task: TaskRecord): void {
    this.emitters.get(id)?.emit("event", { type: "status", taskId: id, status: task.status, task } satisfies TaskEvent);
  }

  private attachParsedOutput(
    id: string,
    stream: NodeJS.ReadableStream,
    parser: (line: string) => { type: "text"; text: string },
    outputPath: string,
  ): void {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const publish = (line: string) => {
      if (!line) return;
      let text: string;
      try {
        text = parser(line).text;
      } catch {
        text = line;
      }
      if (!text) return;
      const content = `${text}\n`;
      const cursor = fs.statSync(outputPath).size;
      fs.appendFileSync(outputPath, content);
      const task = this.options.taskStore.get(id);
      if (task) {
        this.emitters.get(id)?.emit("event", {
          type: "log",
          taskId: id,
          status: task.status,
          task,
          content,
          cursor,
        } satisfies TaskEvent);
      }
    };
    stream.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) publish(line);
    });
    stream.once("end", () => {
      pending += decoder.end();
      if (pending) publish(pending);
      pending = "";
    });
  }
}

function readByte(descriptor: number, position: number): number {
  const byte = Buffer.allocUnsafe(1);
  return fs.readSync(descriptor, byte, 0, 1, position) === 1 ? byte[0] : 0;
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

function validateStartInput(input: StartTaskInput): void {
  if (!(["build", "test", "git", "agent"] satisfies TaskKind[]).includes(input.kind)) throw new Error("Invalid task kind");
  if (!input.workspaceId || !input.requestedBy) throw new Error("Workspace and requester are required");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(input.executable)) throw new Error("Executable is not an allowlisted executable");
  if (!Array.isArray(input.args) || !input.args.every((argument) => typeof argument === "string" && Buffer.byteLength(argument) <= 64 * 1024)) {
    throw new Error("Invalid task arguments");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS) throw new Error("Invalid task timeout");
}

function boundedEnvironment(): NodeJS.ProcessEnv {
  const exact = [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TMP", "TEMP",
    "SSH_AUTH_SOCK", "GIT_SSH", "GIT_SSH_COMMAND", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of exact) if (process.env[key] !== undefined) environment[key] = process.env[key];
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ["LOCALAPP_", "NODE_", "npm_", "OPENCODE_"].some((prefix) => key.startsWith(prefix))) environment[key] = value;
  }
  return environment;
}

export function findExecutable(
  name: string,
  options: { platform?: NodeJS.Platform; pathValue?: string; pathExt?: string } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const extensions = platform === "win32"
    ? (options.pathExt ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(isDirectWindowsExtension)
    : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return fs.realpathSync(candidate);
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

function isDirectWindowsExtension(extension: string): boolean {
  return [".exe", ".com"].includes(extension.toLowerCase());
}

function isDirectWindowsExecutable(executablePath: string): boolean {
  return isDirectWindowsExtension(path.extname(executablePath));
}

function cleanupSupervisorHandshake(active: Pick<ActiveTask, "readyPath" | "startPath">): void {
  fs.rmSync(active.readyPath, { force: true });
  fs.rmSync(active.startPath, { force: true });
}

async function waitForSupervisorReady(child: ChildProcess, readyPath: string, token: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Task supervisor exited before becoming ready");
    try {
      const ready = JSON.parse(fs.readFileSync(readyPath, "utf8")) as { pid?: unknown; token?: unknown };
      if (ready.pid !== child.pid || ready.token !== token) throw new Error("Task supervisor ready identity did not match");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Task supervisor did not become ready");
}

function writeDurableExclusive(filePath: string, content: string): void {
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function waitBounded(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), milliseconds);
      timer.unref();
    }),
  ]);
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Buffer.from(message, "utf8").subarray(0, 4_096).toString("utf8");
}
