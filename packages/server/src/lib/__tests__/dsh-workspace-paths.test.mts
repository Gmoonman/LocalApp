import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { userWorkspaceRoot } from "@localapp/dsh-multiuser/workspace-root";
import { DeepSeekHarness } from "../deepseek-harness.mjs";
const parent = path.resolve(import.meta.dirname, "../../../../../tmp/workspace-paths");
const hash = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

it.each(["inside", "outside"])("adopts a persisted %s directory only within the current application workspace", async location => {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "adoption-"));
  const root = path.join(directory, "runtime");
  const workspace = path.join(root, "workspace");
  const previous = location === "inside" ? path.join(workspace, "imported", "provider") : path.join(directory, "outside");
  await fs.mkdir(previous, { recursive: true });
  await fs.writeFile(path.join(previous, "private.txt"), "unchanged private file");
  const config = { root, ownerId: "alice", llmApiKey: "unused", llmBaseUrl: "http://127.0.0.1:1", llmModel: "unused", capabilities: [], autoSessionTitles: false };
  let harness = new DeepSeekHarness({ ...config, workspaceRoot: previous });
  try {
    const old = await harness.nativeApi();
    await old.gateway.invoke({ namespace: "session", method: "create", args: { request: { sessionId: "persisted-directory" } } });
    await harness.close();
    harness = new DeepSeekHarness({ ...config, workspaceRoot: workspace });
    const native = await harness.nativeApi();
    const adopt = native.gateway.invoke({ namespace: "session", method: "create", args: { request: { sessionId: "persisted-directory" } } });
    if (location === "inside") expect(await adopt).toMatchObject({ sessionId: "persisted-directory" });
    else await expect(adopt).rejects.toThrow("outside the application workspace");
    await expect(native.gateway.invoke({ namespace: "session", method: "create", args: { request: { sessionId: "persisted-directory", cwd: previous } } })).rejects.toThrow("outside the application workspace");
    expect(await fs.readFile(path.join(previous, "private.txt"), "utf8")).toBe("unchanged private file");
  } finally { await harness.close(); await fs.rm(directory, { recursive: true, force: true }); }
}, 15000);

it("keeps a concurrently published association instead of replacing it", async () => {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "data-"));
  const winner = hash(["concurrent-winner"]);
  const originalLink = syncFs.linkSync;
  const link = vi.spyOn(syncFs, "linkSync").mockImplementationOnce((source, target) => {
    syncFs.writeFileSync(target, JSON.stringify({ version: 1, directory: winner }) + "\n", { flag: "wx" });
    return originalLink(source, target);
  });
  try {
    const root = userWorkspaceRoot(directory, "alice", "application", "first", ["first"]);
    expect(root).toBe(path.join(directory, "agent", winner));
    expect(userWorkspaceRoot(directory, "alice", "application", "second", ["first", "second"])).toBe(root);
    expect(await fs.readdir(path.join(directory, "agent", "associations"))).toEqual([hash(["alice", "application"]) + ".json"]);
  } finally { link.mockRestore(); await fs.rm(directory, { recursive: true, force: true }); }
});

it.each(["agent", "associations", "record", "root", "sessions"])("rejects a symlink at the %s workspace path", async location => {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "data-"));
  try {
    const root = userWorkspaceRoot(directory, "alice", "application", "first", ["first"]);
    const outside = path.join(directory, "outside");
    await fs.mkdir(outside);
    await fs.mkdir(root); await fs.mkdir(path.join(root, "sessions"));
    const target = location === "agent" ? path.join(directory, "agent") : location === "associations" ? path.join(directory, "agent", "associations") : location === "record" ? path.join(directory, "agent", "associations", hash(["alice", "application"]) + ".json") : location === "root" ? root : path.join(root, "sessions");
    let linkTarget = outside;
    if (location === "record") { linkTarget = path.join(outside, "record.json"); await fs.writeFile(linkTarget, JSON.stringify({ version: 1, directory: path.basename(root) })); }
    await fs.rm(target, { recursive: true, force: true });
    await fs.symlink(linkTarget, target);
    expect(() => userWorkspaceRoot(directory, "alice", "application", "second", ["first", "second"])).toThrow("Invalid user workspace path");
    expect(await fs.readdir(outside)).toEqual(location === "record" ? ["record.json"] : []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it("retains ordinary workspace associations across model switches", async () => {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "data-"));
  try {
    const root = userWorkspaceRoot(directory, "alice", "application", "first", ["first"]);
    expect(userWorkspaceRoot(directory, "alice", "application", "second", ["first", "second"])).toBe(root);
    expect(userWorkspaceRoot(directory, "bob", "application", "first", ["first"])).not.toBe(root);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
