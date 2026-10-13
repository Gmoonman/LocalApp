import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { DeepSeekHarness } from "../deepseek-harness.mjs";
import { inventoryLegacyHistory, planLegacyHistory, stageLegacyHistory, remapLegacyCatalog, remapLegacyDirectories, migrateLegacyWorkspace, resolveUserWorkspace } from "@localapp/dsh-agent-runtime/legacy-history";
import { userWorkspaceRoot } from "@localapp/dsh-multiuser/workspace-root";
import Sessions, { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session-persistence-jsonl";
import { createRequire } from "node:module";
const { default: Attachments } = await import(createRequire(new URL("../../../../dsh-multiuser/package.json", import.meta.url)).resolve("@deepseek-ai/dsh-attachment-local"));
const { default: Persistence } = await import(createRequire(new URL("../../../../dsh-multiuser/package.json", import.meta.url)).resolve("@deepseek-ai/dsh-session-persistence-jsonl"));

it("migrates real forked histories with their inherited prefix and provider-local parent", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/legacy-fork");
  await fs.mkdir(parent, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(parent, "data-"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"fork reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })));
  const forks = new Map<string, string>();
  try {
    for (const provider of ["first", "second"]) {
      const root = path.join(dataDir, "agent", createHash("sha256").update(JSON.stringify(["alice", "platform", provider])).digest("hex"));
      const harness = new DeepSeekHarness({ ownerId: "alice", root, capabilities: [], autoSessionTitles: false, llmApiKey: "secret", llmBaseUrl: "http://model.test/v1", llmModel: provider });
      try {
        await harness.run("alice", { sessionId: "same-parent", prompt: "parent history " + provider, systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
        const native = await harness.nativeApi();
        const fork = await native.gateway.invoke({ namespace: "session", method: "fork", args: { request: { sessionId: "same-parent" } } }) as { sessionId: string };
        forks.set(provider, fork.sessionId);
      } finally { await harness.close(); }
    }
    const inventory = await inventoryLegacyHistory(dataDir, "alice", "platform", ["first", "second"]);
    expect(inventory.entries).toHaveLength(4);
    const destination = path.join(dataDir, "merged");
    const plan = await stageLegacyHistory(inventory, destination);
    const context = new Context();
    try {
      await context.plugin(Sessions); await context.plugin(Persistence, { root: path.join(destination, "sessions"), compression: "none" });
      for (const provider of ["first", "second"]) {
        const child = plan.find(entry => entry.providerId === provider && entry.sessionId === forks.get(provider))!;
        const source = plan.find(entry => entry.providerId === provider && entry.sessionId === "same-parent")!;
        expect(child.targetParentSessionId).toBe(source.targetSessionId);
        const handle = await context.sessionPersistence.open(SessionId(child.targetSessionId), "read");
        try {
          expect(handle.header.parentSession).toBe(source.targetSessionId);
          expect(handle.inheritedEventCount).toBeGreaterThan(0);
          const history = JSON.stringify((await handle.read()).events);
          expect(history).toContain("parent history " + provider);
          expect(history).not.toContain("parent history " + (provider === "first" ? "second" : "first"));
        } finally { await handle.close(); }
      }
    } finally { await context.fiber.dispose(); }
    const resumed = new DeepSeekHarness({ ownerId: "alice", root: destination, capabilities: [], autoSessionTitles: false, llmApiKey: "secret", llmBaseUrl: "http://model.test/v1", llmModel: "current-model" });
    try {
      for (const provider of ["first", "second"]) {
        const child = plan.find(entry => entry.providerId === provider && entry.sessionId === forks.get(provider))!;
        await resumed.run("alice", { sessionId: child.targetSessionId, prompt: "continue child " + provider, systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
        const native = await resumed.nativeApi();
        const projection = await native.gateway.invoke({ namespace: "session", method: "projections", args: { request: { sessionId: child.targetSessionId } } }) as { asOfSeq: number };
        const page = await native.gateway.invoke({ namespace: "session", method: "page", args: { request: { address: { kind: "session", sessionId: child.targetSessionId }, throughSeq: projection.asOfSeq } } });
        expect(JSON.stringify(page)).toContain("parent history " + provider);
        expect(JSON.stringify(page)).toContain("continue child " + provider);
        expect(JSON.stringify(page)).not.toContain("parent history " + (provider === "first" ? "second" : "first"));
      }
    } finally { await resumed.close(); }
  } finally { vi.unstubAllGlobals(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

it("inventories real provider histories without losing duplicate session identities", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/legacy-history");
  await fs.mkdir(parent, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(parent, "data-"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"legacy reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })));
  try {
    for (const provider of ["first", "second"]) {
      const root = path.join(dataDir, "agent", createHash("sha256").update(JSON.stringify(["alice", "platform", provider])).digest("hex"));
      const harness = new DeepSeekHarness({ ownerId: "alice", root, capabilities: [], autoSessionTitles: false, llmApiKey: "secret", llmBaseUrl: "http://model.test/v1", llmModel: provider });
      try {
        await harness.run("alice", { sessionId: "same-id", prompt: "history " + provider, systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
        const native = await harness.nativeApi();
        const goal = await native.gateway.invoke({ namespace: "goals", method: "create", args: { agentId: "same-id", request: { objective: "Preserve goal for " + provider, maxGoalRounds: 5 } } }) as { ref: { id: string; revision: number } };
        await native.gateway.invoke({ namespace: "goals", method: "pause", args: { agentId: "same-id", ref: goal.ref } });
      }
      finally { await harness.close(); }
    }
    const result = await inventoryLegacyHistory(dataDir, "alice", "platform", ["first", "second", "first"]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.every(entry => entry.eventCount > 0)).toBe(true);
    expect(new Set(result.entries.map(entry => entry.digest)).size).toBe(2);
    expect(result.conflicts).toEqual([{ sessionId: "same-id", providers: ["first", "second"] }]);
    const planned = planLegacyHistory(result);
    expect(new Set(planned.map(entry => entry.targetSessionId)).size).toBe(2);
    expect(planLegacyHistory({ ...result, entries: [...result.entries].reverse() }).map(entry => entry.targetSessionId).reverse()).toEqual(planned.map(entry => entry.targetSessionId));
    expect(await inventoryLegacyHistory(dataDir, "bob", "platform", ["first", "second"])).toEqual({ entries: [], conflicts: [] });
    expect(await inventoryLegacyHistory(dataDir, "alice", "another-app", ["first", "second"])).toEqual({ entries: [], conflicts: [] });
    expect(await inventoryLegacyHistory(dataDir, "alice", "platform", ["first", "second"])).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("secret");
    for (const entry of result.entries) {
      await fs.mkdir(path.join(entry.root, "workspace"), { recursive: true });
      await fs.writeFile(path.join(entry.root, "workspace", "same-name.txt"), entry.providerId);
      await fs.mkdir(path.join(entry.root, "storage"), { recursive: true });
      await fs.writeFile(path.join(entry.root, "storage", "workspace.json"), JSON.stringify({ unit: { name: "workspace", version: 2 }, global: { initialized: true, workspaceIds: ["same-workspace"], archivedSessionIds: entry.providerId === "first" ? [entry.sessionId] : [], pinnedSessionIds: entry.providerId === "second" ? [entry.sessionId] : [] }, tables: { workspaces: { "same-workspace": { path: path.join(entry.root, "workspace"), title: entry.providerId, sessionIds: [entry.sessionId], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } } } }));
      await fs.writeFile(path.join(entry.root, "storage", "schedule.json"), JSON.stringify({ unit: { name: "schedule", version: 1 }, global: null, tables: { tasks: { "same-task": { sessionId: entry.sessionId, status: "inactive", record: { id: "same-task", kind: "at", title: entry.providerId, prompt: "remember " + entry.providerId, scheduledAt: "2030-01-01T00:00:00.000Z" } } } } }));
    }
    const attachmentContext = new Context();
    let file;
    try {
      await attachmentContext.plugin(Attachments, { dshHome: result.entries[0].root });
      file = await attachmentContext.attachments.saveFile({ name: "report.pdf", data: Buffer.from("%PDF-1.7 migration bytes") });
    } finally { await attachmentContext.fiber.dispose(); }
    for (const entry of result.entries) {
      await fs.mkdir(path.join(entry.root, "attachments"), { recursive: true });
      await fs.writeFile(path.join(entry.root, "attachments", "large.bin"), Buffer.alloc(2 * 1024 * 1024, 73));
    }
    const stagedData = path.join(dataDir, "staged");
    const stagedRoot = path.join(stagedData, "agent", createHash("sha256").update(JSON.stringify(["alice", "platform", "merged"])).digest("hex"));
    await fs.mkdir(path.dirname(stagedRoot), { recursive: true });
    await stageLegacyHistory(result, stagedRoot);
    expect((await fs.stat(path.join(stagedRoot, "attachments", "large.bin"))).size).toBe(2 * 1024 * 1024);
    await fs.writeFile(path.join(result.entries[1].root, "attachments", "large.bin"), "different content");
    const collisionRoot = path.join(dataDir, "attachment-collision");
    await expect(stageLegacyHistory(result, collisionRoot)).rejects.toThrow("attachment collision");
    await expect(fs.stat(collisionRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(result.entries[1].root, "attachments", "large.bin"), Buffer.alloc(2 * 1024 * 1024, 73));
    const workspacePreferences = JSON.parse(await fs.readFile(path.join(stagedRoot, "storage", "workspace.json"), "utf8"));
    expect(workspacePreferences.global.workspaceIds).toHaveLength(2);
    expect(workspacePreferences.global.archivedSessionIds).toEqual([planned.find(entry => entry.providerId === "first")!.targetSessionId]);
    expect(workspacePreferences.global.pinnedSessionIds).toEqual([planned.find(entry => entry.providerId === "second")!.targetSessionId]);
    const scheduled = JSON.parse(await fs.readFile(path.join(stagedRoot, "storage", "schedule.json"), "utf8"));
    expect(Object.keys(scheduled.tables.tasks)).toHaveLength(2);
    for (const entry of planned) {
      const task = Object.values(scheduled.tables.tasks).find((value: any) => value.record.title === entry.providerId) as any;
      expect(task).toMatchObject({ sessionId: entry.targetSessionId, status: "inactive", record: { prompt: "remember " + entry.providerId } });
      expect(scheduled.tables.tasks[task.record.id]).toEqual(task);
    }
    for (const entry of result.entries) {
      const providerDirectory = createHash("sha256").update(entry.providerId).digest("hex");
      expect(await fs.readFile(path.join(stagedRoot, "workspace", "imported", providerDirectory, "same-name.txt"), "utf8")).toBe(entry.providerId);
      expect(await fs.readFile(path.join(entry.root, "workspace", "same-name.txt"), "utf8")).toBe(entry.providerId);
    }
    const restoredAttachments = new Context();
    try {
      await restoredAttachments.plugin(Sessions);
      await restoredAttachments.plugin(Persistence, { root: path.join(stagedRoot, "sessions"), compression: "none" });
      const snapshots = await (restoredAttachments as unknown as { sessionPersistence: { list(): Promise<Array<{ header: { id: string; cwd?: string } }>> } }).sessionPersistence.list();
      for (const entry of planned) {
        expect(snapshots.find(snapshot => snapshot.header.id === entry.targetSessionId)?.header.cwd).toBe(path.join(stagedRoot, "workspace", "imported", createHash("sha256").update(entry.providerId).digest("hex")));
      }
      await restoredAttachments.plugin(Attachments, { dshHome: stagedRoot });
      const chunks: Uint8Array[] = [];
      for await (const chunk of restoredAttachments.attachments.readFileStream(file)) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe("%PDF-1.7 migration bytes");
    } finally { await restoredAttachments.fiber.dispose(); }
    const imported = await inventoryLegacyHistory(stagedData, "alice", "platform", ["merged"]);
    expect(imported.entries.map(entry => entry.sessionId).sort()).toEqual(planned.map(entry => entry.targetSessionId).sort());
    expect(imported.entries.map(entry => entry.eventCount).sort()).toEqual(result.entries.map(entry => entry.eventCount).sort());
    await expect(stageLegacyHistory(result, stagedRoot)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await inventoryLegacyHistory(stagedData, "alice", "platform", ["merged"])).toEqual(imported);
    await expect(stageLegacyHistory({ ...result, entries: result.entries.map(entry => ({ ...entry, digest: "changed" })) }, path.join(dataDir, "failed-stage"))).rejects.toThrow("changed after inventory");
    await expect(fs.access(path.join(dataDir, "failed-stage"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await inventoryLegacyHistory(dataDir, "alice", "platform", ["first", "second"])).toEqual(result);
    for (const entry of planned) {
      vi.mocked(fetch).mockClear();
      const resumed = new DeepSeekHarness({ ownerId: "alice", root: stagedRoot, capabilities: ["files"], autoSessionTitles: false, llmApiKey: "new-secret", llmBaseUrl: "http://model.test/v1", llmModel: "new-model" });
      try {
        await resumed.run("alice", { sessionId: entry.targetSessionId, prompt: "continue " + entry.providerId, systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
        const agent = (resumed as any).conversations.get(entry.targetSessionId).handle.agent;
        const read = await agent.ctx.tools.execute({ callId: "migration-read", signal: new AbortController().signal, name: "read", arguments: { file_path: "same-name.txt" }, agent });
        expect(read.isError).not.toBe(true);
        expect(JSON.stringify(read)).toContain(entry.providerId);
        const write = await agent.ctx.tools.execute({ callId: "migration-write", signal: new AbortController().signal, name: "write", arguments: { file_path: "continued.txt", content: "continued " + entry.providerId }, agent });
        expect(write.isError).not.toBe(true);
        const migratedWorkspace = path.join(stagedRoot, "workspace", "imported", createHash("sha256").update(entry.providerId).digest("hex"));
        expect(await fs.readFile(path.join(migratedWorkspace, "continued.txt"), "utf8")).toBe("continued " + entry.providerId);
        await expect(fs.access(path.join(entry.root, "workspace", "continued.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      finally { await resumed.close(); }
      const requests = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
      expect(requests.some(request => JSON.stringify(request.messages).includes("history " + entry.providerId))).toBe(true);
      expect(requests.every(request => !JSON.stringify(request.messages).includes("history " + (entry.providerId === "first" ? "second" : "first")))).toBe(true);
      expect(requests.every(request => request.model === "new-model")).toBe(true);
    }
    const continued = await inventoryLegacyHistory(stagedData, "alice", "platform", ["merged"]);
    for (const entry of imported.entries) expect(continued.entries.find(current => current.sessionId === entry.sessionId)!.eventCount).toBeGreaterThan(entry.eventCount);
    const navigation = new DeepSeekHarness({ ownerId: "alice", root: stagedRoot, capabilities: ["files", "schedule"], autoSessionTitles: false, llmApiKey: "new-secret", llmBaseUrl: "http://model.test/v1", llmModel: "new-model" });
    try {
      const native = await navigation.nativeApi();
      const controller = new AbortController();
      const stream = await native.gateway.stream({ namespace: "workspace", method: "follow", args: {}, signal: controller.signal });
      const iterator = stream[Symbol.asyncIterator]();
      try {
        const opening = await iterator.next();
        expect(JSON.stringify(opening.value)).toContain(planned[0].targetSessionId);
        expect(JSON.stringify(opening.value)).toContain(planned[1].targetSessionId);
        expect(opening.value).toMatchObject({ type: "baseline", value: { archivedSessionIds: workspacePreferences.global.archivedSessionIds, pinnedSessionIds: workspacePreferences.global.pinnedSessionIds } });
      } finally { controller.abort(); await iterator.return?.(); }
      const catalog = await native.gateway.invoke({ namespace: "schedule", method: "catalog", args: {} });
      expect(JSON.stringify(catalog)).toContain("remember first");
      expect(JSON.stringify(catalog)).toContain("remember second");
      for (const entry of planned) expect(catalog).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: entry.targetSessionId, status: "inactive", prompt: "remember " + entry.providerId })]));
      const visible = planned.find(entry => entry.providerId === "second")!;
      for (const entry of planned) expect(await native.gateway.invoke({ namespace: "goals", method: "get", args: { agentId: entry.targetSessionId } })).toMatchObject({ objective: "Preserve goal for " + entry.providerId, phase: "paused", activation: "disarmed" });
      const projections = await native.gateway.invoke({ namespace: "session", method: "projections", args: { request: { sessionId: visible.targetSessionId } } }) as { asOfSeq: number };
      const page = await native.gateway.invoke({ namespace: "session", method: "page", args: { request: { address: { kind: "session", sessionId: visible.targetSessionId }, throughSeq: projections.asOfSeq } } });
      expect(JSON.stringify(page)).toContain("history second");
      expect(JSON.stringify(page)).toContain("continue second");
      expect(JSON.stringify(page)).not.toContain("history first");
    } finally { await navigation.close(); }
    const unsupportedStorage = path.join(result.entries[0].root, "storage", "additional.json");
    await fs.writeFile(unsupportedStorage, "{}");
    await expect(resolveUserWorkspace(dataDir, "alice", "platform", "first", ["first", "second"])).rejects.toThrow("additional units");
    expect(await fs.readdir(path.join(dataDir, "agent", "associations"))).toEqual([]);
    await fs.unlink(unsupportedStorage);
    const workspaceFile = path.join(result.entries[0].root, "storage", "workspace.json");
    const originalWorkspace = await fs.readFile(workspaceFile, "utf8");
    await fs.writeFile(workspaceFile, JSON.stringify({ ...JSON.parse(originalWorkspace), global: null }));
    await expect(resolveUserWorkspace(dataDir, "alice", "platform", "first", ["first", "second"])).rejects.toThrow("records have no registry state");
    expect(await fs.readdir(path.join(dataDir, "agent", "associations"))).toEqual([]);
    await fs.writeFile(workspaceFile, originalWorkspace);
    const originalOpen = fs.open.bind(fs);
    const syncFailure = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(path.sep + "legacy-import.json")) handle.sync = async () => { throw new Error("Simulated imported history sync failure"); };
      return handle;
    });
    try {
      await expect(resolveUserWorkspace(dataDir, "alice", "platform", "first", ["first", "second"])).rejects.toThrow("history sync failure");
      expect(await fs.readdir(path.join(dataDir, "agent", "associations"))).toEqual([]);
      expect((await fs.readdir(path.join(dataDir, "agent"))).filter(name => /^[a-f0-9]{64}$/.test(name))).toHaveLength(2);
      expect(await inventoryLegacyHistory(dataDir, "alice", "platform", ["first", "second"])).toEqual(result);
    } finally { syncFailure.mockRestore(); }
    const races = await Promise.allSettled([
      resolveUserWorkspace(dataDir, "alice", "platform", "first", ["first", "second"]),
      migrateLegacyWorkspace(dataDir, "alice", "platform", ["first", "second"]),
    ]);
    expect(races.filter(result => result.status === "fulfilled"), races.map(result => result.status === "rejected" ? String(result.reason) : result.value).join("\n")).toHaveLength(1);
    expect(races.filter(result => result.status === "rejected")).toHaveLength(1);
    const activatedRoot = (races.find(result => result.status === "fulfilled") as PromiseFulfilledResult<string>).value;
    expect((await fs.readdir(path.join(dataDir, "agent", "associations"))).filter(name => name.endsWith(".pending"))).toEqual([]);
    expect((await fs.readdir(path.join(dataDir, "agent"))).filter(name => /^[a-f0-9]{64}$/.test(name))).toHaveLength(3);
    expect(userWorkspaceRoot(dataDir, "alice", "platform", "first", ["first", "second"])).toBe(activatedRoot);
    expect(userWorkspaceRoot(dataDir, "alice", "platform", "second", ["first", "second"])).toBe(activatedRoot);
    expect(await resolveUserWorkspace(dataDir, "alice", "platform", "second", ["first", "second"])).toBe(activatedRoot);
    await expect(migrateLegacyWorkspace(dataDir, "alice", "platform", ["first", "second"])).rejects.toThrow("association already exists");
    expect(JSON.parse(await fs.readFile(path.join(activatedRoot, "legacy-import.json"), "utf8")).sessions.map((entry: any) => entry.targetSessionId)).toEqual(planned.map(entry => entry.targetSessionId));
    expect(await inventoryLegacyHistory(dataDir, "alice", "platform", ["first", "second"])).toEqual(result);
    const alias = path.join(dataDir, "workspace-alias");
    await fs.symlink(result.entries[0].root, alias);
    await expect(stageLegacyHistory({ ...result, entries: [{ ...result.entries[0], root: alias }] }, path.join(dataDir, "alias-stage"))).rejects.toThrow("Invalid legacy workspace directory");
    await expect(fs.access(path.join(dataDir, "alias-stage"))).rejects.toMatchObject({ code: "ENOENT" });
    const outside = path.join(dataDir, "outside"); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(result.entries[0].root, "sessions", "external-history"));
    await expect(inventoryLegacyHistory(dataDir, "alice", "platform", ["first", "second"])).rejects.toThrow("Invalid legacy session artifact");
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.unlink(path.join(result.entries[0].root, "sessions", "external-history"));
    const objectDigest = file.attachmentId.slice("sha256:".length);
    await fs.chmod(path.join(result.entries[0].root, "attachments", "v1", "file-objects", objectDigest.slice(0, 2), objectDigest), 0o600);
    await fs.writeFile(path.join(result.entries[0].root, "attachments", "v1", "file-objects", objectDigest.slice(0, 2), objectDigest), "corrupt");
    await expect(stageLegacyHistory(result, path.join(dataDir, "corrupt-stage"))).rejects.toThrow("attachment integrity mismatch");
    await expect(fs.access(path.join(dataDir, "corrupt-stage"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { vi.unstubAllGlobals(); await fs.rm(dataDir, { recursive: true, force: true }); }
}, 15000);

it("maps persisted directory changes without changing conversation text", () => {
  const source = path.resolve("tmp/source-workspace"), destination = path.resolve("tmp/destination-workspace");
  const events = [{ seq: 0, type: "working-directory/change", data: { cwd: path.join(source, "nested") } }, { seq: 1, type: "user/message", data: { content: source } }] as unknown as SessionEvent[];
  expect(remapLegacyDirectories(events, source, destination)[0].data).toEqual({ cwd: path.join(destination, "nested") });
  expect(remapLegacyDirectories(events, source, destination)[1]).toBe(events[1]);
  expect(events[0].data).toEqual({ cwd: path.join(source, "nested") });
  expect(() => remapLegacyDirectories(events, path.join(source, "another"), destination)).toThrow("outside its workspace");
});

it("maps child sessions to their own provider parent and rejects missing parents", () => {
  const source = (providerId: string, sessionId: string, parentSessionId?: string) => ({ providerId, sessionId, parentSessionId, root: "unused", eventCount: 1, digest: "unused" });
  const entries = [source("first", "parent"), source("second", "parent"), source("first", "child-a", "parent"), source("second", "child-b", "parent")];
  const plan = planLegacyHistory({ entries, conflicts: [{ sessionId: "parent", providers: ["first", "second"] }] });
  expect(plan[2].targetSessionId).toBe("child-a");
  expect(plan[2].targetParentSessionId).toBe(plan[0].targetSessionId);
  expect(plan[3].targetParentSessionId).toBe(plan[1].targetSessionId);
  expect(plan[2].targetParentSessionId).not.toBe(plan[3].targetParentSessionId);
  expect(planLegacyHistory({ entries, conflicts: [] })).toEqual(plan);
  expect(() => planLegacyHistory({ entries: [source("first", "child", "missing")], conflicts: [] })).toThrow("parent session is missing");
  expect(() => planLegacyHistory({ entries: [source("first", "a", "b"), source("first", "b", "a")], conflicts: [] })).toThrow("parent session cycle");
  expect(() => planLegacyHistory({ entries: [source("first", "a", "a")], conflicts: [] })).toThrow("parent session cycle");
});

it("remaps local child catalogs without replacing user text or external execution IDs", () => {
  const entries = ["first", "second"].map(providerId => ({ providerId, root: "unused", sessionId: "child", eventCount: 1, digest: "unused" }));
  const plan = planLegacyHistory({ entries, conflicts: [] });
  const events = [
    { seq: 0, type: "subagent/catalog", data: { version: 0, childId: "child", mode: "continuable", label: "child", childCreatedAt: 1 } },
    { seq: 1, type: "subagent/catalog", data: { version: 2, childId: "child", mode: "external", childCreatedAt: 2 } },
    { seq: 2, type: "user/message", data: { content: "child" } },
  ] as unknown as SessionEvent[];
  const first = remapLegacyCatalog(events, "first", plan);
  expect(first[0].data).toMatchObject({ childId: plan[0].targetSessionId, label: "child" });
  expect(remapLegacyCatalog(events, "second", plan)[0].data).toMatchObject({ childId: plan[1].targetSessionId });
  expect(first.slice(1)).toEqual(events.slice(1));
  expect(events[0].data).toMatchObject({ childId: "child" });
  expect(() => remapLegacyCatalog(events, "missing", plan)).toThrow("catalog child session is missing");
});
