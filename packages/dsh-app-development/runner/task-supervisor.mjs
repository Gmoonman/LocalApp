import { execFile, spawn } from "node:child_process";
import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const [, , token, readyPath, startPath, executable, encodedArgs] = process.argv;
if (!token || !readyPath || !startPath || !executable || !encodedArgs) {
  console.error("Invalid LocalApp task supervisor invocation");
  process.exit(125);
}

let args;
try {
  args = JSON.parse(Buffer.from(encodedArgs, "base64url").toString("utf8"));
  if (!Array.isArray(args) || !args.every((argument) => typeof argument === "string")) throw new Error("invalid args");
} catch {
  console.error("Invalid LocalApp task supervisor arguments");
  process.exit(125);
}

const parentPid = process.ppid;
const AUTHORIZATION_TIMEOUT_MS = 5_000;
const CHILD_GRACE_MS = 400;
let child = null;
let childClosed = Promise.resolve();
let resolveChildClosed = () => {};
let shuttingDown = false;

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  writeDurableExclusive(readyPath, JSON.stringify({ pid: process.pid, token }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(125);
}

if (!await waitForStartAuthorization()) exitWithoutTask();

childClosed = new Promise((resolve) => { resolveChildClosed = resolve; });
child = spawn(executable, args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  detached: process.platform !== "win32",
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  resolveChildClosed();
  if (!shuttingDown) exitSupervisor(127);
});
child.once("close", (code, signal) => {
  resolveChildClosed();
  if (!shuttingDown) exitSupervisor(typeof code === "number" ? code : signal ? 1 : 0);
});

if (shuttingDown) await shutdown("SIGTERM");

async function waitForStartAuthorization() {
  const deadline = Date.now() + AUTHORIZATION_TIMEOUT_MS;
  while (!shuttingDown && Date.now() < deadline) {
    if (process.ppid !== parentPid) return false;
    try {
      if (readFileSync(startPath, "utf8") === token) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    await delay(10);
  }
  return false;
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!child?.pid) exitSupervisor(signal === "SIGINT" ? 130 : 143);
  await signalChildTree(false);
  if (!await waitBounded(childClosed, CHILD_GRACE_MS)) {
    await signalChildTree(true);
    await waitBounded(childClosed, CHILD_GRACE_MS);
  }
  exitSupervisor(signal === "SIGINT" ? 130 : 143);
}

async function signalChildTree(force) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        timeout: 1_000,
        windowsHide: true,
      }, () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    try {
      process.kill(child.pid, force ? "SIGKILL" : "SIGTERM");
    } catch (fallbackError) {
      if (fallbackError?.code !== "ESRCH") throw fallbackError;
    }
  }
}

function writeDurableExclusive(filePath, content) {
  const descriptor = openSync(filePath, "wx", 0o600);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function exitWithoutTask() {
  exitSupervisor(shuttingDown ? 143 : 125);
}

function exitSupervisor(code) {
  rmSync(readyPath, { force: true });
  rmSync(startPath, { force: true });
  process.exit(code);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitBounded(promise, milliseconds) {
  return Promise.race([promise.then(() => true), delay(milliseconds).then(() => false)]);
}
