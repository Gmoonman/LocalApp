import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  canonicalizeDeviceActionPermissions,
  type DeviceActionPermissionSet,
} from "@localapp/dsh-device-services/device-action-types";

const MAGIC = Buffer.from("LADP");
const HEADER_BYTES = 8;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

export interface ExecuteDeviceActionInput {
  id: string;
  script: string;
  input: unknown;
  context?: unknown;
  permissions: DeviceActionPermissionSet;
  timeoutSeconds: number;
  workingDirectory: string;
  dataDirectory: string;
  nodeExecutable?: string;
  runnerPath?: string;
  signal?: AbortSignal;
}

export class DeviceActionExecutionError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "DeviceActionExecutionError";
  }
}

export async function executeDeviceAction(input: ExecuteDeviceActionInput): Promise<unknown> {
  const permissions = canonicalizeDeviceActionPermissions(input.permissions);
  const workingDirectory = path.resolve(input.workingDirectory);
  const dataDirectory = path.resolve(input.dataDirectory);
  await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
  const actionDirectory = path.join(dataDirectory, "device-actions", input.id);
  const environmentPath = path.join(actionDirectory, "environment");
  await mkdir(environmentPath, { recursive: true, mode: 0o700 });

  const runnerPath = input.runnerPath;
  const nodeExecutable = input.nodeExecutable ?? process.execPath;
  if (!runnerPath) throw new DeviceActionExecutionError("DEVICE_ACTION_RUNNER_UNAVAILABLE");
  if (!path.isAbsolute(runnerPath) || !path.isAbsolute(nodeExecutable)) {
    throw new DeviceActionExecutionError("DEVICE_ACTION_INVALID_EXECUTION_PATH");
  }
  const args = permissionArguments(permissions, runnerPath, nodeExecutable, dataDirectory, actionDirectory, workingDirectory, environmentPath);
  const child = spawn(nodeExecutable, [...args, runnerPath], {
    cwd: workingDirectory,
    env: minimalEnvironment(),
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    return await communicate(child, {
      id: input.id,
      script: input.script,
      input: input.input,
      context: input.context ?? {},
      environmentPath,
      timeoutMs: Math.max(1, input.timeoutSeconds * 1000),
      signal: input.signal,
    });
  } finally {
    await stopChild(child);
    await rm(path.join(environmentPath, `.localapp-run-${child.pid ?? process.pid}`), { force: true }).catch(() => {});
  }
}

function permissionArguments(
  permissions: DeviceActionPermissionSet,
  runnerPath: string,
  nodeExecutable: string,
  dataDirectory: string,
  actionDirectory: string,
  workingDirectory: string,
  environmentPath: string,
): string[] {
  const realNodeExecutable = fs.realpathSync(nodeExecutable);
  const realRunnerPath = fs.realpathSync(runnerPath);
  const realDataDirectory = realPermissionPath(dataDirectory);
  const realActionDirectory = realPermissionPath(actionDirectory);
  const realWorkingDirectory = realPermissionPath(workingDirectory);
  const realEnvironmentPath = realPermissionPath(environmentPath);
  const args = [
    "--permission",
    "--allow-fs-read=/var",
    `--allow-fs-read=${runnerPath}`,
    `--allow-fs-read=${path.dirname(runnerPath)}`,
    `--allow-fs-read=${realRunnerPath}`,
    `--allow-fs-read=${path.dirname(realRunnerPath)}`,
    `--allow-fs-read=${nodeExecutable}`,
    `--allow-fs-read=${path.dirname(nodeExecutable)}`,
    `--allow-fs-read=${realNodeExecutable}`,
    `--allow-fs-read=${path.dirname(realNodeExecutable)}`,
    `--allow-fs-read=${dataDirectory}`,
    `--allow-fs-read=${realDataDirectory}`,
    `--allow-fs-read=${actionDirectory}`,
    `--allow-fs-read=${realActionDirectory}`,
    `--allow-fs-read=${workingDirectory}`,
    `--allow-fs-read=${realWorkingDirectory}`,
    `--allow-fs-read=${environmentPath}`,
    `--allow-fs-read=${realEnvironmentPath}`,
    `--allow-fs-read=${path.join(environmentPath, "*")}`,
    `--allow-fs-read=${path.join(realEnvironmentPath, "*")}`,
    `--allow-fs-write=${actionDirectory}`,
    `--allow-fs-write=${realActionDirectory}`,
    `--allow-fs-write=${environmentPath}`,
    `--allow-fs-write=${realEnvironmentPath}`,
  ];
  for (const root of permissions.filesystemRead ?? []) args.push(`--allow-fs-read=${realPermissionPath(root)}`);
  for (const root of permissions.filesystemWrite ?? []) {
    const realRoot = realPermissionPath(root);
    // Node's permission glob must cover descendants when the user-selected
    // root does not exist yet; allowing only the root path rejects mkdir(root/*).
    args.push(
      `--allow-fs-read=${root}`,
      `--allow-fs-read=${path.join(root, "*")}`,
      `--allow-fs-read=${realRoot}`,
      `--allow-fs-read=${path.join(realRoot, "*")}`,
      `--allow-fs-write=${root}`,
      `--allow-fs-write=${path.join(root, "*")}`,
      `--allow-fs-write=${realRoot}`,
      `--allow-fs-write=${path.join(realRoot, "*")}`,
    );
  }
  if (permissions.network) args.push("--allow-net");
  if (permissions.childProcess) args.push("--allow-child-process", "--allow-worker");
  return args;
}

function realPermissionPath(candidate: string): string {
  let existing = path.resolve(candidate);
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  environment.LOCALAPP_DEVICE_ACTION = "1";
  return environment;
}

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new DeviceActionExecutionError("DEVICE_ACTION_FRAME_TOO_LARGE");
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  MAGIC.copy(frame, 0);
  frame.writeUInt32BE(payload.length, 4);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

function boundedMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "Device action failed");
  const bytes = Buffer.from(message, "utf8");
  return bytes.length <= MAX_ERROR_BYTES ? message : bytes.subarray(0, MAX_ERROR_BYTES).toString("utf8");
}

function communicate(
  child: ChildProcess,
  input: {
    id: string;
    script: string;
    input: unknown;
    context: unknown;
    environmentPath: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let stderr = "";
    let started = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: DeviceActionExecutionError, result?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new DeviceActionExecutionError("DEVICE_ACTION_CANCELLED", "Device action cancelled"));
    const sendStart = () => {
      if (started || settled) return;
      started = true;
      try {
        child.stdin?.write(encodeFrame({
          type: "start",
          taskId: input.id,
          script: input.script,
          input: input.input,
          context: input.context,
          environmentPath: input.environmentPath,
        }));
      } catch (error) {
        finish(new DeviceActionExecutionError("DEVICE_ACTION_RUN_FAILED", boundedMessage(error)));
      }
    };
    const handleMessage = (message: any) => {
      if (message?.type === "ready" && message.protocolVersion === 1) {
        sendStart();
        return;
      }
      if (message?.type === "completed" && message.taskId === input.id) {
        finish(undefined, message.result);
        return;
      }
      if (message?.type === "failed" && (message.taskId === input.id || message.taskId === null)) {
        const messageText = boundedMessage(`${message.message ?? ""}${stderr ? `\n${stderr}` : ""}`);
        const code = /permission|not permitted|operation not permitted|access denied/i.test(messageText)
          ? "DEVICE_ACTION_PERMISSION_DENIED"
          : (typeof message.code === "string" ? `DEVICE_ACTION_${message.code.toUpperCase()}` : "DEVICE_ACTION_RUN_FAILED");
        finish(new DeviceActionExecutionError(code, messageText));
        return;
      }
      if (message?.type === "cancelled" && message.taskId === input.id) {
        finish(new DeviceActionExecutionError("DEVICE_ACTION_CANCELLED", "Device action cancelled"));
      }
    };
    const handleChunk = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= HEADER_BYTES) {
        if (!buffer.subarray(0, 4).equals(MAGIC)) {
          finish(new DeviceActionExecutionError("DEVICE_ACTION_PROTOCOL_ERROR"));
          return;
        }
        const length = buffer.readUInt32BE(4);
        if (length > MAX_FRAME_BYTES) {
          finish(new DeviceActionExecutionError("DEVICE_ACTION_FRAME_TOO_LARGE"));
          return;
        }
        if (buffer.length < HEADER_BYTES + length) return;
        try {
          handleMessage(JSON.parse(buffer.subarray(HEADER_BYTES, HEADER_BYTES + length).toString("utf8")));
        } catch (error) {
          finish(new DeviceActionExecutionError("DEVICE_ACTION_PROTOCOL_ERROR", boundedMessage(error)));
          return;
        }
        buffer = buffer.subarray(HEADER_BYTES + length);
      }
    };
    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = boundedMessage(`${stderr}${chunk.toString("utf8")}`);
    });
    child.once("error", (error) => finish(new DeviceActionExecutionError("DEVICE_ACTION_RUN_FAILED", boundedMessage(error))));
    child.once("close", (code) => {
      if (!settled) finish(new DeviceActionExecutionError(
        "DEVICE_ACTION_INTERRUPTED",
        `Device action runner exited before completion (${code ?? "unknown"})`,
      ));
    });
    timer = setTimeout(() => finish(new DeviceActionExecutionError("DEVICE_ACTION_TIMEOUT", "Device action timed out")), input.timeoutMs);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // The runner may have exited between the state check and the signal.
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}
