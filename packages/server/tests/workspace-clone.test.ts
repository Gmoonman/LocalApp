import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessTreeController } from "../src/lib/process-tree.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeMetaDb, initMetaDb, getDb, flushMetaDb } from "../src/lib/meta-sqlite.js";
import { WorkspaceStore } from "../src/lib/workspace-store.js";
import { createTestServer, getTestApiKey } from "./integration/helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  closeMetaDb();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("managed Git clone lifecycle", () => {
  it("terminates clones owned by the Cordis development plugin when it stops", async () => {
    const fixture = await cloneFixture(`setInterval(() => {}, 1000);`);
    const root = path.dirname(fixture.store.workspaceDir);
    const { Context } = await import("@deepseek-ai/cordis");
    const { default: ApplicationDevelopment } = await import("@localapp/dsh-app-development");
    const context = new Context();
    try {
      await context.plugin(ApplicationDevelopment, { dataDir: root, persistence: { database: getDb, flush: flushMetaDb } });
      const store = context.localappDevelopment.workspaces({ workspaceDir: path.join(root, "plugin-workspaces"), gitExecutable: path.join(root, "fixture-git"), authorizeExecution: () => true });
      const cloning = store.clone({ name: "Plugin stop", ownerId: "owner", repositoryUrl: "https://example.invalid/plugin-stop.git" });
      const rejected = expect(cloning).rejects.toThrow(/shutdown|terminated/i);
      await waitFor(() => temporaryCloneEntries(store.workspaceDir).length > 0);
      await context.fiber.dispose();
      await rejected;
      expect(temporaryCloneEntries(store.workspaceDir)).toEqual([]);
    } finally { await context.fiber.dispose(); }
  });
  it("reports cancellation failures and retains the process for shutdown retry", async () => {
    const controller = new ProcessTreeController();
    const signal = vi.spyOn(controller, "signalTree").mockRejectedValueOnce(Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
    const fixture = await cloneFixture(`setInterval(() => {}, 1000);`, 2000, controller);
    const abort = new AbortController();
    const cloning = fixture.store.clone({ name: "Cancellation failure", ownerId: "owner", repositoryUrl: "https://example.invalid/cancel.git", signal: abort.signal });
    const rejected = expect(cloning).rejects.toThrow("kill EPERM");
    await waitFor(() => temporaryCloneEntries(fixture.store.workspaceDir).length > 0);
    abort.abort();
    await rejected;
    await fixture.store.shutdown();
    expect(signal).toHaveBeenCalledTimes(2);
    expect(temporaryCloneEntries(fixture.store.workspaceDir)).toEqual([]);
  });
  it("clones successfully with argument separation and an isolated bounded Git environment", async () => {
    const fixture = await cloneFixture(`
      const fs = require("node:fs");
      const destination = process.argv.at(-1);
      fs.mkdirSync(destination);
      fs.writeFileSync(destination + "/clone.json", JSON.stringify({
        args: process.argv.slice(2),
        noSystem: process.env.GIT_CONFIG_NOSYSTEM,
        globalConfig: process.env.GIT_CONFIG_GLOBAL,
        terminalPrompt: process.env.GIT_TERMINAL_PROMPT,
        sshCommand: process.env.GIT_SSH_COMMAND ?? null,
      }));
    `);
    const previousSshCommand = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "unsafe inherited command";
    try {
      const workspace = await fixture.store.clone({
        name: "Success",
        ownerId: "owner",
        repositoryUrl: "https://example.invalid/repository.git",
      });
      const observed = JSON.parse(fs.readFileSync(path.join(fixture.store.pathFor(workspace.id), "clone.json"), "utf8"));
      expect(observed.args.slice(0, 3)).toEqual(["clone", "--", "https://example.invalid/repository.git"]);
      expect(observed).toMatchObject({ noSystem: "1", terminalPrompt: "0", sshCommand: null });
      expect(observed.globalConfig).toMatch(/^(\/dev\/null|NUL)$/);
      expect(temporaryCloneEntries(fixture.store.workspaceDir)).toEqual([]);
    } finally {
      if (previousSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = previousSshCommand;
    }
  });

  it("times out a clone, terminates its process tree, and removes temporary directories", async () => {
    const fixture = await cloneFixture(`setInterval(() => {}, 1000);`, 100);

    await expect(fixture.store.clone({
      name: "Timeout",
      ownerId: "owner",
      repositoryUrl: "https://example.invalid/timeout.git",
    })).rejects.toThrow(/timed out/i);

    expect(temporaryCloneEntries(fixture.store.workspaceDir)).toEqual([]);
  });

  it("cancels a clone through AbortSignal and cleans its staging paths", async () => {
    const fixture = await cloneFixture(`setInterval(() => {}, 1000);`);
    const abort = new AbortController();
    const cloning = fixture.store.clone({
      name: "Abort",
      ownerId: "owner",
      repositoryUrl: "https://example.invalid/abort.git",
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 100).unref();

    await expect(cloning).rejects.toThrow(/aborted/i);
    expect(temporaryCloneEntries(fixture.store.workspaceDir)).toEqual([]);
  });

  it("cancels active clones during store shutdown", async () => {
    const fixture = await cloneFixture(`setInterval(() => {}, 1000);`);
    const cloning = fixture.store.clone({
      name: "Shutdown",
      ownerId: "owner",
      repositoryUrl: "https://example.invalid/shutdown.git",
    });
    const rejected = expect(cloning).rejects.toThrow(/shutdown|terminated/i);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await fixture.store.shutdown();

    await rejected;
    expect(temporaryCloneEntries(fixture.store.workspaceDir)).toEqual([]);
  });

  it("propagates an aborted HTTP clone request into process cancellation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-clone-http-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const gitPath = path.join(root, "git");
    writeExecutable(gitPath, `setInterval(() => {}, 1000);`);
    const server = await createTestServer({ env: { PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}` } });
    cleanups.push(server.stop);
    const abort = new AbortController();
    const request = fetch(`${server.baseUrl}/api/workspaces/clone`, {
      method: "POST",
      headers: { "X-API-Key": getTestApiKey(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "HTTP abort", repositoryUrl: "https://example.invalid/http-abort.git" }),
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 100).unref();

    const response = await request.catch(() => null);
    if (response) expect(response.status).toBe(400);
    await waitFor(() => temporaryCloneEntries(path.join(server.dataDir, "workspaces")).length === 0);
  });
});

async function cloneFixture(program: string, cloneTimeoutMs = 2_000, processController?: ProcessTreeController) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-clone-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  await initMetaDb(root);
  const gitExecutable = path.join(root, "fixture-git");
  writeExecutable(gitExecutable, program);
  const store = new WorkspaceStore({
    workspaceDir: path.join(root, "workspaces"),
    gitExecutable,
    cloneTimeoutMs,
    processController,
    authorizeExecution: () => true,
  });
  cleanups.push(() => store.shutdown());
  return { root, store };
}

function writeExecutable(filePath: string, program: string): void {
  fs.writeFileSync(filePath, `#!${process.execPath}\n${program}\n`, { mode: 0o700 });
}

function temporaryCloneEntries(workspaceDir: string): string[] {
  if (!fs.existsSync(workspaceDir)) return [];
  return fs.readdirSync(workspaceDir).filter((name) => name.startsWith(".tmp-") || name.startsWith(".git-env-"));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not reached");
}
