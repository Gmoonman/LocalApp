import { expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Development from "@localapp/dsh-app-development";
import initSqlJs from "sql.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream, readdirSync } from "node:fs";
import { ZipArchive } from "archiver";

it("rejects workspace mutations and process starts after the development plugin stops", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../../tmp/workspace-lifecycle");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "run-"));
  const SQL = await initSqlJs(); const database = new SQL.Database(); const ctx = new Context();
  try {
    await ctx.plugin(Development, { dataDir: root, persistence: { database: () => database, flush: () => {} } });
    const store = ctx.localappDevelopment.workspaces({ workspaceDir: path.join(root, "workspaces"), authorizeExecution: () => true });
    const start = vi.fn(); store.setTaskRunner({ start });
    const workspace = await store.create({ name: "test", ownerId: "alice" });
    await store.writeFile(workspace.id, "alice", "source.txt", "preserved");
    await ctx.fiber.dispose();
    await expect(store.create({ name: "late", ownerId: "alice" })).rejects.toThrow("Workspace store is stopped");
    await expect(store.clone({ name: "late", ownerId: "alice", repositoryUrl: "https://example.test/repository.git" })).rejects.toThrow("Workspace store is stopped");
    await expect(store.importArchive({ name: "late", ownerId: "alice", archivePath: "missing.zip" })).rejects.toThrow("Workspace store is stopped");
    await expect(store.writeFile(workspace.id, "alice", "source.txt", "changed")).rejects.toThrow("Workspace store is stopped");
    await expect(store.remove(workspace.id, "alice")).rejects.toThrow("Workspace store is stopped");
    await expect(store.build(workspace.id, "alice")).rejects.toThrow("Workspace store is stopped");
    await expect(store.install(workspace.id, "alice")).rejects.toThrow("Workspace store is stopped");
    expect(() => store.setTaskRunner({ start })).toThrow("Workspace store is stopped");
    expect(start).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(store.pathFor(workspace.id), "source.txt"), "utf8")).toBe("preserved");
    expect(store.list("alice")).toHaveLength(1);
  } finally { await ctx.fiber.dispose(); database.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it("cleans an archive import that finishes after the owning plugin stops", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../../tmp/workspace-lifecycle");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "archive-"));
  const SQL = await initSqlJs(); const database = new SQL.Database(); const ctx = new Context();
  try {
    const archivePath = path.join(root, "source.zip");
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive(); archive.pipe(output);
    const closed = new Promise<void>((resolve, reject) => { output.once("close", resolve); output.once("error", reject); archive.once("error", reject); });
    archive.append("source content", { name: "source.txt" });
    await archive.finalize(); await closed;
    await ctx.plugin(Development, { dataDir: root, persistence: { database: () => database, flush: () => {} } });
    const store = ctx.localappDevelopment.workspaces({ workspaceDir: path.join(root, "workspaces") });
    const importing = store.importArchive({ name: "late-import", ownerId: "alice", archivePath });
    const rejected = expect(importing).rejects.toThrow("Workspace store is stopped");
    // importArchive creates staging synchronously, then yields to archive I/O.
    expect(readdirSync(store.workspaceDir)).toHaveLength(1);
    await ctx.fiber.dispose();
    // Disposal must finish cleanup without relying on the caller awaiting import.
    expect(readdirSync(store.workspaceDir)).toEqual([]);
    await rejected;
    expect(await fs.readdir(store.workspaceDir)).toEqual([]);
    expect(store.list("alice")).toEqual([]);
  } finally { await ctx.fiber.dispose(); database.close(); await fs.rm(root, { recursive: true, force: true }); }
});
