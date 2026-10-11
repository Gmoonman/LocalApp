import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeMetaDb, initMetaDb } from "../../src/lib/meta-sqlite.js";
import { AgentRunner } from "../../src/lib/agent-runner.js";
import { TaskRunner, type TaskRecord } from "../../src/lib/task-runner.js";
import { TaskStore } from "../../src/lib/task-store.js";
import { WorkspaceStore } from "../../src/lib/workspace-store.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import { buildServer } from "../../src/server.js";
import { createTestUser, registerAndLogin } from "../helpers/createUser.js";
import { createTestServer, getTestApiKey } from "./helpers.js";

const temporaryDirectories: string[] = [];
const activeRunners: TaskRunner[] = [];
const activeServerStops: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of activeServerStops.splice(0)) await stop();
  for (const runner of activeRunners.splice(0)) await runner.shutdown();
  closeMetaDb();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("workspace task API", () => {
  it("rejects new task starts after the runner shuts down", async () => {
    const { runner, workspace, store } = await directRunnerFixture();
    await runner.shutdown();
    await expect(runner.start({ workspaceId: workspace.id, requestedBy: "owner", kind: "test", executable: "node", args: ["-e", "0"], timeoutMs: 1000 })).rejects.toThrow("Task runner is stopped");
    expect(store.listRunning()).toEqual([]);
  });

  it("keeps workspace files available to users but reserves every process-start entry point for admins", async () => {
    const server = await createTestServer();
    activeServerStops.push(server.stop);
    temporaryDirectories.push(server.dataDir);
    const ordinary = await createTestUser(server.baseUrl, "task-ordinary", "password123");
    const ordinaryWorkspace = await createWorkspaceWithHeaders(server.baseUrl, "User Files", {
      "X-API-Key": ordinary.apiKey,
      "Content-Type": "application/json",
    });
    const fileWrite = await fetch(`${server.baseUrl}/api/workspaces/${ordinaryWorkspace}/file`, {
      method: "PUT",
      headers: { "X-API-Key": ordinary.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes.txt", content: "still allowed" }),
    });
    expect(fileWrite.status).toBe(204);

    const attempts = [
      { path: "/api/tasks", body: { workspaceId: ordinaryWorkspace, kind: "test", executable: "node", args: ["-e", "0"], timeoutMs: 1_000 } },
      { path: "/api/tasks/agents", body: { workspaceId: ordinaryWorkspace, agent: "codex", prompt: "no", timeoutMs: 1_000 } },
      { path: `/api/workspaces/${ordinaryWorkspace}/build`, body: {} },
      { path: `/api/workspaces/${ordinaryWorkspace}/install`, body: {} },
      { path: "/api/workspaces/clone", body: { name: "No clone", repositoryUrl: "https://example.invalid/repo.git" } },
    ];
    for (const authHeaders of [{ "X-API-Key": ordinary.apiKey }, { Cookie: ordinary.cookie }]) {
      for (const attempt of attempts) {
        const response = await fetch(`${server.baseUrl}${attempt.path}`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(attempt.body),
        });
        expect(response.status, `${attempt.path} with ${Object.keys(authHeaders)[0]}`).toBe(403);
      }
    }

    const adminCookie = await loginCookie(server.baseUrl, "localadmin", "localadmin");
    const adminWorkspace = await createWorkspace(server.baseUrl, "Admin Execution");
    for (const authHeaders of [{ "X-API-Key": getTestApiKey() }, { Cookie: adminCookie }]) {
      const response = await fetch(`${server.baseUrl}/api/tasks`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: adminWorkspace, kind: "test", executable: "node", args: ["-e", "process.exit(0)"], timeoutMs: 2_000 }),
      });
      expect(response.status, `admin ${Object.keys(authHeaders)[0]}`).toBe(201);
      const task = (await response.json()).data as TaskRecord;
      await waitForTask(server.baseUrl, task.id, (record) => record.status === "succeeded");
    }
  });

  it("persists, streams logs and events, authorizes, and cancels a process group", async () => {
    const server = await createTestServer();
    activeServerStops.push(server.stop);
    temporaryDirectories.push(server.dataDir);
    const otherCookie = await registerAndLogin(server.baseUrl, "task-other", "password123");
    const workspaceId = await createWorkspace(server.baseUrl, "Lifecycle");
    await writeWorkspaceFile(server.baseUrl, workspaceId, "slow-task.mjs", `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log("started child:" + child.pid);
      setInterval(() => console.log("tick"), 1000);
    `);

    const startedResponse = await fetch(`${server.baseUrl}/api/tasks`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        workspaceId,
        kind: "test",
        executable: "node",
        args: ["slow-task.mjs"],
        timeoutMs: 10_000,
      }),
    });
    expect(startedResponse.status).toBe(201);
    const started = (await startedResponse.json()).data as TaskRecord;
    expect(started).toMatchObject({ workspaceId, status: "running", requestedBy: "localadmin" });

    const unauthenticated = await fetch(`${server.baseUrl}/api/tasks/${started.id}`);
    expect(unauthenticated.status).toBe(401);
    const anotherUsersTask = await fetch(`${server.baseUrl}/api/tasks/${started.id}`, { headers: { Cookie: otherCookie } });
    expect(anotherUsersTask.status).toBe(404);

    const initialLog = await waitForLog(server.baseUrl, started.id, "started child:");
    const childPid = Number(initialLog.match(/child:(\d+)/)?.[1]);
    expect(childPid).toBeGreaterThan(1);

    const eventAbort = new AbortController();
    const eventResponse = await fetch(`${server.baseUrl}/api/tasks/${started.id}/events`, {
      headers: { "X-API-Key": getTestApiKey() },
      signal: eventAbort.signal,
    });
    expect(eventResponse.status).toBe(200);
    expect(eventResponse.headers.get("content-type")).toContain("text/event-stream");
    const firstEvent = await eventResponse.body!.getReader().read();
    eventAbort.abort();
    expect(Buffer.from(firstEvent.value ?? []).toString("utf8")).toContain('"status":"running"');

    const cancelled = await fetch(`${server.baseUrl}/api/tasks/${started.id}/cancel`, {
      method: "POST",
      headers: { "X-API-Key": getTestApiKey() },
    });
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).data.status).toBe("cancelled");

    const persisted = await fetch(`${server.baseUrl}/api/tasks/${started.id}`, { headers: { "X-API-Key": getTestApiKey() } });
    expect((await persisted.json()).data.status).toBe("cancelled");
    const logResponse = await fetch(`${server.baseUrl}/api/tasks/${started.id}/logs?cursor=0`, {
      headers: { "X-API-Key": getTestApiKey() },
    });
    const log = (await logResponse.json()).data as { content: string; cursor: number; nextCursor: number };
    expect(log.content).toContain("started");
    expect(log.cursor).toBe(0);
    expect(log.nextCursor).toBeGreaterThan(0);

    if (process.platform !== "win32") await expectProcessGone(childPid);
  });

  it("times out a task and kills its descendant process", async () => {
    const server = await createTestServer();
    activeServerStops.push(server.stop);
    temporaryDirectories.push(server.dataDir);
    const workspaceId = await createWorkspace(server.baseUrl, "Timeout");
    await writeWorkspaceFile(server.baseUrl, workspaceId, "timeout-task.mjs", `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log("timeout-child:" + child.pid);
      setInterval(() => {}, 1000);
    `);
    const started = await postTask(server.baseUrl, {
      workspaceId,
      kind: "test",
      executable: "node",
      args: ["timeout-task.mjs"],
      timeoutMs: 200,
    });
    const log = await waitForLog(server.baseUrl, started.id, "timeout-child:");
    const childPid = Number(log.match(/timeout-child:(\d+)/)?.[1]);
    const finished = await waitForTask(server.baseUrl, started.id, (task) => task.status === "timed_out");
    expect(finished.status).toBe("timed_out");
    if (process.platform !== "win32") await expectProcessGone(childPid);
  });

  it("rejects non-allowlisted executables and does not interpret arguments through a shell", async () => {
    const fixture = await directRunnerFixture();
    const marker = path.join(fixture.root, "shell-marker");
    const executable = path.join(fixture.root, "argument-printer.mjs");
    fs.writeFileSync(executable, `#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    fixture.runner.setAllowedExecutable("fixture", executable);

    await expect(fixture.runner.start({
      workspaceId: fixture.workspace.id,
      kind: "test",
      executable: "sh",
      args: ["-c", "true"],
      timeoutMs: 1_000,
      requestedBy: "owner",
    })).rejects.toThrow("allowlisted executable");

    const task = await fixture.runner.start({
      workspaceId: fixture.workspace.id,
      kind: "test",
      executable: "fixture",
      args: ["safe", ";", "touch", marker],
      timeoutMs: 2_000,
      requestedBy: "owner",
    });
    await waitForStoredTask(fixture.store, task.id, (record) => record.status === "succeeded");
    expect(fs.existsSync(marker)).toBe(false);
    expect((await fixture.runner.logs(task.id, 0)).content).toContain(`";","touch"`);
  });

  it("reconciles persisted running tasks to interrupted when Server starts", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-task-reconcile-"));
    temporaryDirectories.push(dataDir);
    const env = serverEnv(dataDir);
    const setupTokens = new SetupTokenStore();
    const first = await buildServer({ env, setupTokens });
    const issued = setupTokens.issue();
    expect((await first.inject({
      method: "POST",
      url: "/api/setup/initialize",
      payload: { token: issued.token, username: "localadmin", password: "password123" },
    })).statusCode).toBe(201);

    const workspaces = new WorkspaceStore({ workspaceDir: path.join(dataDir, "workspaces") });
    const workspace = await workspaces.create({ name: "Interrupted", ownerId: "localadmin" });
    const tasks = new TaskStore();
    const running = tasks.create({
      workspaceId: workspace.id,
      kind: "test",
      executable: "node",
      args: ["missing.mjs"],
      timeoutMs: 1_000,
      requestedBy: "localadmin",
      outputPath: path.join(dataDir, "tasks", "interrupted.log"),
      status: "running",
    });
    await first.close();
    closeMetaDb();

    const restarted = await buildServer({ env });
    const response = await restarted.inject({
      method: "GET",
      url: `/api/tasks/${running.id}`,
      headers: { "x-api-key": "task-test-api-key" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id: running.id, status: "interrupted" });
    await restarted.close();
  });

  it("reports each unavailable agent executable without selecting another runtime", async () => {
    const fixture = await directRunnerFixture();
    const agents = new AgentRunner({ taskRunner: fixture.runner, executableResolver: () => null });
    expect(agents.capabilities()).toEqual([
      { kind: "codex", executable: "codex", available: false, supportsContinuation: false },
      { kind: "opencode", executable: "opencode", available: false, supportsContinuation: false },
    ]);
    await expect(agents.start({
      workspaceId: fixture.workspace.id,
      agent: "codex",
      prompt: "Build an app",
      timeoutMs: 1_000,
      requestedBy: "owner",
    })).rejects.toThrow("codex executable is unavailable");
  });

  it("starts Codex and OpenCode through their current non-interactive argv protocols", async () => {
    const fixture = await directRunnerFixture();
    const executable = path.join(fixture.root, "agent-argv.mjs");
    fs.writeFileSync(executable, `#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    const agents = new AgentRunner({ taskRunner: fixture.runner, executableResolver: () => executable });

    const codex = await agents.start({
      workspaceId: fixture.workspace.id,
      agent: "codex",
      prompt: "Codex prompt",
      timeoutMs: 2_000,
      requestedBy: "owner",
    });
    await waitForStoredTask(fixture.store, codex.id, (record) => record.status === "succeeded");
    expect(fixture.runner.logs(codex.id, 0).content).toContain('["exec","--json","Codex prompt"]');

    const opencode = await agents.start({
      workspaceId: fixture.workspace.id,
      agent: "opencode",
      prompt: "OpenCode prompt",
      timeoutMs: 2_000,
      requestedBy: "owner",
    });
    await waitForStoredTask(fixture.store, opencode.id, (record) => record.status === "succeeded");
    expect(fixture.runner.logs(opencode.id, 0).content).toContain('["run","--format","json","OpenCode prompt"]');
  });

  it("normalizes real adapter protocol output in persisted logs and emitted log events", async () => {
    const fixture = await directRunnerFixture();
    const executable = path.join(fixture.root, "agent-protocol.mjs");
    fs.writeFileSync(executable, `#!/usr/bin/env node
      const codex = process.argv[2] === "exec";
      setTimeout(() => {
        console.log(JSON.stringify(codex
          ? { type: "item.completed", item: { type: "agent_message", text: "codex normalized" } }
          : { type: "text", text: "opencode normalized" }));
      }, 100);
    `, { mode: 0o700 });
    const agents = new AgentRunner({ taskRunner: fixture.runner, executableResolver: () => executable });

    for (const [agent, expected] of [["codex", "codex normalized"], ["opencode", "opencode normalized"]] as const) {
      const task = await agents.start({
        workspaceId: fixture.workspace.id,
        agent,
        prompt: "Normalize",
        timeoutMs: 2_000,
        requestedBy: "owner",
      });
      const observed: string[] = [];
      fixture.runner.events(task.id).on("event", (event) => {
        if (event.type === "log" && event.content) observed.push(event.content);
      });
      await waitForStoredTask(fixture.store, task.id, (record) => record.status === "succeeded");
      const log = fixture.runner.logs(task.id, 0).content;
      expect(log).toContain(expected);
      expect(log).not.toContain("item.completed");
      expect(observed.join("")).toContain(expected);
    }
  });

  it("paginates logs on UTF-8 boundaries without permanently corrupting multibyte output", async () => {
    const fixture = await directRunnerFixture();
    const outputPath = path.join(fixture.root, "utf8.log");
    const expected = `${"a".repeat(65_535)}😀z`;
    fs.writeFileSync(outputPath, expected);
    const task = fixture.store.create({
      workspaceId: fixture.workspace.id,
      kind: "test",
      executable: "node",
      args: [],
      timeoutMs: 1_000,
      requestedBy: "owner",
      outputPath,
      status: "succeeded",
    });

    const first = fixture.runner.logs(task.id, 0);
    const second = fixture.runner.logs(task.id, first.nextCursor);

    expect(first.content).not.toContain("�");
    expect(second.content).not.toContain("�");
    expect(first.content + second.content).toBe(expected);
    expect(second.eof).toBe(true);
  });
});

async function directRunnerFixture() {
  closeMetaDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-direct-task-"));
  temporaryDirectories.push(root);
  await initMetaDb(root);
  const workspaces = new WorkspaceStore({ workspaceDir: path.join(root, "workspaces") });
  const workspace = await workspaces.create({ name: "Direct", ownerId: "owner" });
  const store = new TaskStore();
  const runner = new TaskRunner({ workspaceStore: workspaces, taskStore: store, taskDir: path.join(root, "tasks"), authorizeExecution: () => true });
  activeRunners.push(runner);
  return { root, workspace, store, runner };
}

async function createWorkspace(baseUrl: string, name: string): Promise<string> {
  return createWorkspaceWithHeaders(baseUrl, name, apiHeaders());
}

async function createWorkspaceWithHeaders(baseUrl: string, name: string, headers: Record<string, string>): Promise<string> {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).data.id as string;
}

async function loginCookie(baseUrl: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie().find((value) => value.startsWith("token="))!.split(";")[0];
}

async function writeWorkspaceFile(baseUrl: string, workspaceId: string, filePath: string, content: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/file`, {
    method: "PUT",
    headers: apiHeaders(),
    body: JSON.stringify({ path: filePath, content }),
  });
  expect(response.status).toBe(204);
}

async function postTask(baseUrl: string, input: Record<string, unknown>): Promise<TaskRecord> {
  const response = await fetch(`${baseUrl}/api/tasks`, { method: "POST", headers: apiHeaders(), body: JSON.stringify(input) });
  expect(response.status).toBe(201);
  return (await response.json()).data as TaskRecord;
}

async function waitForLog(baseUrl: string, taskId: string, text: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/tasks/${taskId}/logs?cursor=0`, { headers: { "X-API-Key": getTestApiKey() } });
    if (response.ok) {
      const content = (await response.json()).data.content as string;
      if (content.includes(text)) return content;
    }
    await delay(25);
  }
  throw new Error(`Task log did not contain ${text}`);
}

async function waitForTask(baseUrl: string, taskId: string, predicate: (task: TaskRecord) => boolean): Promise<TaskRecord> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, { headers: { "X-API-Key": getTestApiKey() } });
    const task = (await response.json()).data as TaskRecord;
    if (predicate(task)) return task;
    await delay(25);
  }
  throw new Error(`Task ${taskId} did not reach expected state`);
}

async function waitForStoredTask(store: TaskStore, taskId: string, predicate: (task: TaskRecord) => boolean): Promise<TaskRecord> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const task = store.get(taskId);
    if (task && predicate(task)) return task;
    await delay(25);
  }
  throw new Error(`Stored task ${taskId} did not reach expected state`);
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await delay(25);
  }
  throw new Error(`Descendant process ${pid} is still alive`);
}

function apiHeaders(): Record<string, string> {
  return { "X-API-Key": getTestApiKey(), "Content-Type": "application/json" };
}

function serverEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    DATA_DIR: dataDir,
    BOOTSTRAP_API_KEY: "task-test-api-key",
    JWT_SECRET: "task-test-jwt-secret",
    ADMIN_STATIC_DIR: path.resolve(__dirname, "../../static/admin"),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
