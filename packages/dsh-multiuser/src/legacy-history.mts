import { resolveDeepSeekPlugin } from "./deepseek-plugin.mjs";
import fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import Sessions, { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { scheduleDomain } from "@deepseek-ai/dsh-schedule";
import { workspaceDomainSpec, workspaceDomainState, workspaceRecord } from "@deepseek-ai/dsh-workspace";
import { userWorkspaceRoot, LegacyHistoryMigrationRequired } from "./user-workspace-root.cjs";

export async function resolveUserWorkspace(dataDir: string, userId: string, applicationId: string, providerId: string, providers: string[]) {
  try { return userWorkspaceRoot(dataDir, userId, applicationId, providerId, providers); }
  catch (error) {
    if (!(error instanceof LegacyHistoryMigrationRequired)) throw error;
    return migrateLegacyWorkspace(dataDir, userId, applicationId, providers);
  }
}

/** Publish a fully imported directory without replacing an existing workspace association. */
export async function migrateLegacyWorkspace(dataDir: string, userId: string, applicationId: string, providers: string[]) {
  const inventory = await inventoryLegacyHistory(dataDir, userId, applicationId, providers);
  if (!inventory.entries.length) throw new Error("No legacy sessions to migrate");
  for (const source of new Set(inventory.entries.map(entry => entry.root))) {
    const storage = path.join(source, "storage");
    try {
      await checkTree(storage);
      const unsupported = (await fs.readdir(storage)).filter(name => !["workspace.json", "schedule.json", "session_projcache"].includes(name));
      if (unsupported.length) throw new Error("Legacy storage contains additional units that require migration: " + unsupported.join(", "));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const directory = createHash("sha256").update(randomUUID()).digest("hex");
  const agentRoot = path.join(dataDir, "agent"), root = path.join(agentRoot, directory);
  const associations = path.join(agentRoot, "associations");
  try { await fs.mkdir(associations, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await fs.lstat(associations);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid user workspace associations directory");
  const association = path.join(associations, createHash("sha256").update(JSON.stringify([userId, applicationId])).digest("hex") + ".json");
  try { await fs.lstat(association); throw new Error("Workspace association already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const plan = await stageLegacyHistory(inventory, root);
  const temporary = path.join(associations, randomUUID() + ".pending");
  let published = false;
  try {
    await fs.writeFile(path.join(root, "legacy-import.json"), JSON.stringify({ version: 1, sessions: plan }) + "\n", { flag: "wx", mode: 0o600 });
    // Publish the pointer only after imported data and its directory entries are flushed.
    await syncImportedTree(root);
    await syncDirectory(agentRoot);
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, directory }) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    // link creates the association atomically and refuses a concurrent winner.
    await fs.link(temporary, association);
    published = true;
    await syncDirectory(associations);
    return root;
  } finally {
    await fs.rm(temporary, { force: true });
    if (!published) await fs.rm(root, { recursive: true, force: true });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not support opening directories through this filesystem API.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncImportedTree(directory: string): Promise<void> {
  await checkTree(directory);
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) { await syncImportedTree(filename); continue; }
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Invalid imported history artifact");
      await handle.sync();
    } finally { await handle.close(); }
  }
  await syncDirectory(directory);
}

/** Read old provider directories through dsh's format readers before planning an import. */
export async function inventoryLegacyHistory(dataDir: string, userId: string, applicationId: string, providerIds: string[]) {
  const entries: Array<{ providerId: string; root: string; sessionId: string; parentSessionId?: string; eventCount: number; digest: string }> = [];
  for (const providerId of new Set(providerIds)) {
    const directory = createHash("sha256").update(JSON.stringify([userId, applicationId, providerId])).digest("hex");
    const root = path.join(dataDir, "agent", directory), sessions = path.join(root, "sessions");
    try { await fs.access(sessions); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const parent of [path.join(dataDir, "agent"), root]) {
      const stat = await fs.lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid legacy workspace directory");
    }
    await checkTree(sessions);
    const context = new Context();
    try {
      await context.plugin(resolveDeepSeekPlugin(Sessions));
      await context.plugin(resolveDeepSeekPlugin(Persistence), { root: sessions, compression: "none" });
      for (const snapshot of await context.sessionPersistence.list()) {
        const handle = await context.sessionPersistence.open(snapshot.header.id, "read");
        try {
          const stored = await handle.read();
          entries.push({ providerId, root, sessionId: handle.id, ...(handle.header.parentSession ? { parentSessionId: handle.header.parentSession } : {}), eventCount: stored.events.length, digest: createHash("sha256").update(JSON.stringify([handle.header, stored.events])).digest("hex") });
        } finally { await handle.close(); }
      }
    } finally { await context.fiber.dispose(); }
  }
  const owners = new Map<string, string[]>();
  for (const entry of entries) owners.set(entry.sessionId, [...(owners.get(entry.sessionId) ?? []), entry.providerId]);
  return { entries, conflicts: [...owners].filter(([, providers]) => providers.length > 1).map(([sessionId, providers]) => ({ sessionId, providers })) };
}
async function checkTree(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid legacy session directory");
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) throw new Error("Invalid legacy session artifact");
    if (item.isDirectory()) await checkTree(path.join(directory, item.name));
  }
}

/** Build stable import identities without changing source sessions or event content. */
export function planLegacyHistory(inventory: Awaited<ReturnType<typeof inventoryLegacyHistory>>) {
  const counts = new Map<string, number>();
  for (const entry of inventory.entries) counts.set(entry.sessionId, (counts.get(entry.sessionId) ?? 0) + 1);
  const conflicts = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
  const identities = new Map<string, string>(), destinations = new Set<string>();
  const sourceKey = (provider: string, id: string) => JSON.stringify([provider, id]);
  for (const entry of inventory.entries) {
    const key = sourceKey(entry.providerId, entry.sessionId);
    if (identities.has(key)) throw new Error("Duplicate legacy source session");
    const target = conflicts.has(entry.sessionId) ? "import-" + createHash("sha256").update(key).digest("hex") : entry.sessionId;
    if (destinations.has(target)) throw new Error("Legacy import session identity collision");
    identities.set(key, target); destinations.add(target);
  }
  const plan = inventory.entries.map(entry => {
    const targetParentSessionId = entry.parentSessionId === undefined ? undefined : identities.get(sourceKey(entry.providerId, entry.parentSessionId));
    if (entry.parentSessionId !== undefined && targetParentSessionId === undefined) throw new Error("Legacy parent session is missing from its provider history");
    return { ...entry, targetSessionId: identities.get(sourceKey(entry.providerId, entry.sessionId))!, ...(targetParentSessionId === undefined ? {} : { targetParentSessionId }) };
  });
  const parents = new Map(plan.map(entry => [entry.targetSessionId, entry.targetParentSessionId]));
  const checked = new Set<string>();
  for (const entry of plan) {
    const chain = new Set<string>();
    let current: string | undefined = entry.targetSessionId;
    while (current !== undefined && !checked.has(current)) {
      if (chain.has(current)) throw new Error("Legacy parent session cycle");
      chain.add(current);
      current = parents.get(current);
    }
    for (const id of chain) checked.add(id);
  }
  return plan;
}

/** Write a fresh staging store through dsh; never overwrite or select an active workspace. */
export async function stageLegacyHistory(inventory: Awaited<ReturnType<typeof inventoryLegacyHistory>>, destination: string) {
  const plan = planLegacyHistory(inventory);
  // Exclusive creation keeps cleanup confined to a directory owned by this operation.
  await fs.mkdir(destination, { mode: 0o700 });
  const target = new Context();
  try {
    await target.plugin(Sessions);
    await target.plugin(Persistence, { root: path.join(destination, "sessions"), compression: "none" });
    for (const root of new Set(plan.map(entry => entry.root))) await copyLegacyAttachments(root, destination);
    for (const entry of new Map(plan.map(entry => [entry.providerId, entry])).values()) {
      const sourceWorkspace = path.join(entry.root, "workspace");
      const targetWorkspace = legacyWorkspace(destination, entry.providerId);
      try { await fs.lstat(sourceWorkspace); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { await fs.mkdir(targetWorkspace, { recursive: true, mode: 0o700 }); continue; } throw error; }
      await checkTree(sourceWorkspace);
      await fs.cp(sourceWorkspace, targetWorkspace, { recursive: true, errorOnExist: true, force: false });
    }
    await importLegacySchedules(plan, destination);
    await importLegacyWorkspacePreferences(plan, destination);
    for (const entry of plan) {
      const rootStat = await fs.lstat(entry.root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Invalid legacy workspace directory");
      await checkTree(path.join(entry.root, "sessions"));
      const source = new Context();
      try {
        await source.plugin(Sessions);
        await source.plugin(Persistence, { root: path.join(entry.root, "sessions"), compression: "none" });
        const input = await source.sessionPersistence.open(SessionId(entry.sessionId), "read");
        try {
          const stored = await input.read();
          const digest = createHash("sha256").update(JSON.stringify([input.header, stored.events])).digest("hex");
          if (digest !== entry.digest) throw new Error("Legacy history changed after inventory");
          const { parentSession: _parent, ...header } = input.header;
          const sourceWorkspace = path.join(entry.root, "workspace");
          const relativeCwd = path.relative(sourceWorkspace, header.cwd ?? sourceWorkspace);
          if (relativeCwd === ".." || relativeCwd.startsWith(".." + path.sep) || path.isAbsolute(relativeCwd)) throw new Error("Legacy session working directory is outside its workspace");
          const output = await target.sessionPersistence.create({ ...header, cwd: path.join(legacyWorkspace(destination, entry.providerId), relativeCwd), id: SessionId(entry.targetSessionId), ...(entry.targetParentSessionId ? { parentSession: SessionId(entry.targetParentSessionId) } : {}) }, { inheritedEventCount: input.inheritedEventCount });
          try { await output.append(remapLegacyDirectories(remapLegacyCatalog(stored.events, entry.providerId, plan), sourceWorkspace, legacyWorkspace(destination, entry.providerId))); await output.flush(); }
          finally { await output.close(); }
        } finally { await input.close(); }
      } finally { await source.fiber.dispose(); }
    }
    return plan;
  } catch (error) {
    await target.fiber.dispose();
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  } finally { await target.fiber.dispose(); }
}

async function importLegacyWorkspacePreferences(plan: ReturnType<typeof planLegacyHistory>, destination: string) {
  const descriptor = { name: workspaceDomainSpec.name, version: workspaceDomainSpec.version, tables: ["workspaces"], hasGlobal: true };
  const target = new JsonStorageBackend(path.join(destination, "storage"));
  try {
    const unit = await target.kv.open(descriptor);
    const state = { initialized: false, workspaceIds: [] as string[], archivedSessionIds: [] as string[], pinnedSessionIds: [] as string[] };
    for (const entry of new Map(plan.map(entry => [entry.providerId, entry])).values()) {
      const source = new JsonStorageBackend(path.join(entry.root, "storage"));
      try {
        const stored = await (await source.kv.open(descriptor)).loadAll();
        if (stored.global === null) {
          if (Object.keys(stored.tables.workspaces).length) throw new Error("Legacy workspace records have no registry state");
          continue;
        }
        const previous = workspaceDomainState.parse(stored.global);
        if (previous.pendingMutation) throw new Error("Legacy workspace has an unfinished mutation");
        const knownWorkspaces = new Set<string>(previous.workspaceIds);
        if (knownWorkspaces.size !== previous.workspaceIds.length || Object.keys(stored.tables.workspaces).some(id => !knownWorkspaces.has(id))) throw new Error("Legacy workspace registry is inconsistent");
        if (previous.pinnedSessionIds.some(id => previous.archivedSessionIds.includes(id))) throw new Error("Legacy session is both archived and pinned");
        const sessionId = (id: string) => {
          const found = plan.find(item => item.providerId === entry.providerId && item.sessionId === id);
          if (!found) throw new Error("Legacy workspace preference session is missing");
          return found.targetSessionId;
        };
        for (const id of previous.workspaceIds) {
          const record = workspaceRecord.parse(stored.tables.workspaces[id]);
          const relative = path.relative(path.join(entry.root, "workspace"), record.path);
          if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Legacy registered workspace is outside its workspace");
          const importedId = "import-" + createHash("sha256").update(JSON.stringify([entry.providerId, id])).digest("hex");
          await unit.putRecord("workspaces", importedId, { ...record, path: path.join(legacyWorkspace(destination, entry.providerId), relative), sessionIds: record.sessionIds.map(sessionId) });
          state.workspaceIds.push(importedId);
        }
        state.archivedSessionIds.push(...previous.archivedSessionIds.map(sessionId));
        state.pinnedSessionIds.push(...previous.pinnedSessionIds.map(sessionId));
      } finally { await source.close(); }
    }
    if (state.workspaceIds.length || state.archivedSessionIds.length || state.pinnedSessionIds.length) await unit.setGlobal(workspaceDomainState.parse({ ...state, initialized: true }));
  } finally { await target.close(); }
}

async function importLegacySchedules(plan: ReturnType<typeof planLegacyHistory>, destination: string) {
  const descriptor = { name: scheduleDomain.name, version: scheduleDomain.version, tables: ["tasks"], hasGlobal: false };
  const tasks: Array<{ providerId: string; key: string; value: ReturnType<typeof scheduleDomain.tables.tasks.valueSchema.parse> }> = [];
  for (const entry of new Map(plan.map(entry => [entry.providerId, entry])).values()) {
    const storage = path.join(entry.root, "storage");
    try { await fs.lstat(storage); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    await checkTree(storage);
    const backend = new JsonStorageBackend(storage);
    try {
      const unit = await backend.kv.open(descriptor);
      for (const [key, raw] of Object.entries((await unit.loadAll()).tables.tasks ?? {})) {
        const value = scheduleDomain.tables.tasks.valueSchema.parse(raw);
        if (key !== value.record.id) throw new Error("Legacy schedule identity mismatch");
        const session = plan.find(item => item.providerId === entry.providerId && item.sessionId === value.sessionId);
        if (!session) throw new Error("Legacy schedule session is missing from its provider history");
        tasks.push({ providerId: entry.providerId, key, value: { ...value, sessionId: SessionId(session.targetSessionId) } });
      }
    } finally { await backend.close(); }
  }
  if (!tasks.length) return;
  const backend = new JsonStorageBackend(path.join(destination, "storage"));
  try {
    const unit = await backend.kv.open(descriptor);
    const destinations = new Set<string>();
    for (const task of tasks) {
      const id = tasks.filter(other => other.key === task.key).length > 1 ? "import-" + createHash("sha256").update(JSON.stringify([task.providerId, task.key])).digest("hex") : task.key;
      if (destinations.has(id)) throw new Error("Legacy schedule import identity collision");
      destinations.add(id);
      const value = scheduleDomain.tables.tasks.valueSchema.parse({ ...task.value, record: { ...task.value.record, id } });
      await unit.putRecord("tasks", id, value);
    }
  } finally { await backend.close(); }
}

function legacyWorkspace(destination: string, providerId: string) {
  return path.join(destination, "workspace", "imported", createHash("sha256").update(providerId).digest("hex"));
}

export function remapLegacyDirectories(events: readonly SessionEvent[], sourceWorkspace: string, destinationWorkspace: string): SessionEvent[] {
  return events.map(event => {
    if (event.type !== "working-directory/change") return event;
    const data = event.data as unknown as { cwd: string };
    if (typeof data.cwd !== "string" || !path.isAbsolute(data.cwd)) throw new Error("Invalid legacy working directory event");
    const relative = path.relative(sourceWorkspace, data.cwd);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Legacy working directory event is outside its workspace");
    return { ...event, data: { ...data, cwd: path.join(destinationWorkspace, relative) } } as SessionEvent;
  });
}

async function copyLegacyAttachments(sourceRoot: string, destination: string) {
  const rootStat = await fs.lstat(sourceRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Invalid legacy workspace directory");
  const source = path.join(sourceRoot, "attachments");
  try { await fs.lstat(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await checkTree(source);
  async function copy(directory: string, relative: string): Promise<void> {
    await fs.mkdir(path.join(destination, "attachments", relative), { recursive: true, mode: 0o700 });
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const from = path.join(directory, item.name), suffix = path.join(relative, item.name);
      if (item.isDirectory()) { await copy(from, suffix); continue; }
      const sourceDigest = await fileDigest(from);
      const segments = relative.split(path.sep);
      const digest = ["objects", "file-objects"].includes(segments[1]) ? item.name : segments[1] === "files" ? segments[3] : undefined;
      if (digest && /^[a-f0-9]{64}$/.test(digest) && sourceDigest !== digest) throw new Error("Legacy attachment integrity mismatch");
      const to = path.join(destination, "attachments", suffix);
      let copied = false;
      try { await fs.copyFile(from, to, constants.COPYFILE_EXCL); copied = true; await fs.chmod(to, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (await fileDigest(to) !== sourceDigest) throw new Error(copied ? "Legacy attachment changed while copying" : "Legacy attachment collision");
    }
  }
  await copy(source, "");
}

/** Hash files incrementally so large attachments do not require a whole-file Buffer. */
async function fileDigest(filename: string): Promise<string> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Invalid legacy attachment file");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename, { fd: handle.fd, autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally { await handle.close(); }
}

/** Rewrite only dsh's durable local child catalog, leaving model text and external IDs intact. */
export function remapLegacyCatalog(events: readonly SessionEvent[], providerId: string, plan: ReturnType<typeof planLegacyHistory>): SessionEvent[] {
  const identities = new Map(plan.filter(entry => entry.providerId === providerId).map(entry => [entry.sessionId, entry.targetSessionId]));
  return events.map(event => {
    if (event.type !== "subagent/catalog") return event;
    const data = event.data as unknown as { childId: string; mode: string };
    if (data.mode === "external") return event;
    const childId = identities.get(data.childId);
    if (childId === undefined) throw new Error("Legacy catalog child session is missing from its provider history");
    return { ...event, data: { ...data, childId } } as SessionEvent;
  });
}
