import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createIpcClient } from "../src/daemon/ipc-client.js";
import { publishRelease } from "../src/daemon/release-store.js";
import { createRuntimeLayout } from "../src/daemon/runtime-layout.js";
import { buildLocalAppPackage } from "../scripts/build-package.mjs";

const repositoryRoot = path.resolve(process.cwd(), "../..");
const testRoot = path.join(repositoryRoot, "tmp/task-7b-daemon-integration");
const directories: string[] = [];
const children: ChildProcess[] = [];
const execFileAsync = promisify(execFile);

let fixture: { root: string; artifact: string; layout: ReturnType<typeof createRuntimeLayout> };
beforeAll(async () => {
  if (process.platform === "win32") return;
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, "fixture-"));
  const artifact = path.join(root, "packed");
  await buildLocalAppPackage({ outputDirectory: artifact });
  const layout = createRuntimeLayout({ supportDir: path.join(root, "support"), runtimeDir: path.join(root, "run"), dataDir: path.join(root, "data") });
  await publishRelease({ sourceDirectory: artifact, layout });
  fixture = { root, artifact, layout };
}, 120_000);
afterAll(async () => { if (fixture) await fs.rm(fixture.root, { recursive: true, force: true }); });
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("packed daemon integration", () => {
  it.skipIf(process.platform === "win32")("runs the packed internal daemon through IPC, health, restart, and stop without a user service", async () => {
    const { artifact, layout } = fixture;
    const daemon = spawn(process.execPath, [path.join(artifact, "bin/localapp.mjs"), "_daemon"], {
      env: { ...process.env, LOCALAPP_SUPPORT_DIR: layout.supportDir, LOCALAPP_RUNTIME_DIR: layout.runtimeDir, LOCALAPP_DATA_DIR: layout.dataDir },
      stdio: "ignore",
    });
    children.push(daemon);
    const client = createIpcClient({ endpoint: layout.controlEndpoint, timeoutMs: 10_000 });
    const first = await waitForStatus(client);
    const serverDescendants = new Set(await observeServerDescendants(daemon.pid!));
    expect(first.data.server.listenUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(first.data.server.setupUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup\?token=/);
    await expect(fetch(`${first.data.server.listenUrl}/health`)).resolves.toMatchObject({ status: 200 });
    await expect(client.request({ type: "restart" })).resolves.toEqual({ ok: true, type: "restart" });
    const second = await waitForStatus(client);
    for (const pid of await observeServerDescendants(daemon.pid!)) serverDescendants.add(pid);
    expect(second.data.bootId).toBe(first.data.bootId);
    await expect(fetch(`${second.data.server.listenUrl}/health`)).resolves.toMatchObject({ status: 200 });
    await expect(client.request({ type: "stop" })).resolves.toEqual({ ok: true, type: "stop" });
    await waitForExit(daemon);
    expect(serverDescendants.size).toBeGreaterThan(0);
    for (const pid of serverDescendants) expectProcessAbsent(pid);
    await expect(fs.lstat(layout.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(layout.controlEndpoint)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(layout.dataDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  }, 90_000);
});

async function waitForStatus(client: ReturnType<typeof createIpcClient>) {
  let last: unknown;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const value = await client.request({ type: "status" });
      if (value.ok && value.type === "status" && value.data.server.status === "ready") return value;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw last ?? new Error("daemon did not become ready");
}

async function observeServerDescendants(daemonPid: number): Promise<number[]> {
  const observed = new Set<number>();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    for (const pid of await descendantPids(daemonPid)) observed.add(pid);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (observed.size === 0) throw new Error("did not observe a packed Server descendant");
  return [...observed];
}

async function descendantPids(rootPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="]);
  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/, 2);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent) || pid <= 1) continue;
    const children = childrenByParent.get(parent) ?? [];
    children.push(pid);
    childrenByParent.set(parent, children);
  }
  const output: number[] = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    output.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return output;
}

function expectProcessAbsent(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
    return;
  }
  throw new Error(`Server descendant ${pid} is still present after daemon stop`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not exit")), 10_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
