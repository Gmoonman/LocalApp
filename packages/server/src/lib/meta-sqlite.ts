import { initializePlatformSchema } from "@localapp/dsh-app-platform/platform-schema";
import { createSavedRepliesStore } from "@localapp/dsh-app-platform/saved-replies-store";
import { PeerRecords } from "@localapp/dsh-app-sync/peer-records";
import { AnalyticsStore } from "@localapp/dsh-app-platform/analytics";
import { createAccountServices } from "@localapp/dsh-multiuser/account-services";
import { initializeAccountSchema } from "@localapp/dsh-multiuser/account-schema";
export { apiKeyStorageValue } from "@localapp/dsh-multiuser/api-keys";
import type { UserRecord, AuthSessionRecord } from "@localapp/dsh-multiuser/accounts";
import { FavoritesStore } from "@localapp/dsh-app-platform/favorites";
import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { assertSqlJsRuntimeUsable, markSqlJsRuntimeUnusable } from "@localapp/server-core";

export const BOOTSTRAP_USER_ID = "localadmin";
export { MAX_NOTIFICATION_DELIVERY_SEQUENCE } from "@localapp/dsh-app-platform/platform-schema";

export const PROTECTED_USER_IDS = [BOOTSTRAP_USER_ID] as const;

export function isProtectedUserId(id: string): boolean {
  return (PROTECTED_USER_IDS as readonly string[]).includes(id);
}

export type { ApiKeyRecord } from "@localapp/dsh-multiuser/api-keys";

export type { PeerRow } from "@localapp/dsh-app-sync/peer-records";
export type { UserRecord } from "@localapp/dsh-multiuser/accounts";

export type { UserRow } from "@localapp/dsh-multiuser/accounts";

export type { AuthSessionRecord } from "@localapp/dsh-multiuser/accounts";

export type { SavedReplyRecord } from "@localapp/dsh-app-platform/saved-replies-store";

let db: SqlJsDatabase | null = null;
let dbPath: string = "";
let SqlJs: initSqlJs.SqlJsStatic | null = null;
let publishing = false;
let commitStateUnknown: MetaDatabaseCommitStateUnknownError | null = null;

export class MetaDatabaseCommitStateUnknownError extends Error {
  readonly code = "META_DATABASE_COMMIT_STATE_UNKNOWN";

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Meta database commit state unknown after atomic rename: ${detail}`, { cause });
    this.name = "MetaDatabaseCommitStateUnknownError";
  }
}

export interface MetaAtomicFileOperations {
  mkdirSync: typeof fs.mkdirSync;
  openSync: typeof fs.openSync;
  writeFileSync: typeof fs.writeFileSync;
  fsyncSync: typeof fs.fsyncSync;
  closeSync: typeof fs.closeSync;
  renameSync: typeof fs.renameSync;
  rmSync: typeof fs.rmSync;
}

let atomicFileOperations: MetaAtomicFileOperations = fs;

function isWasmRuntimeError(err: unknown): boolean {
  if (typeof WebAssembly !== "undefined" && err instanceof WebAssembly.RuntimeError) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/memory access out of bounds|wasm|webassembly/i.test(message)) return true;
  const stack = err instanceof Error ? err.stack ?? "" : "";
  return /sql-wasm\.js/i.test(stack) && (message.trim() === "" || message.includes("\uFFFD"));
}

function evictMetaDbAfterRuntimeError(err: unknown): void {
  if (!isWasmRuntimeError(err)) return;
  const current = db;
  db = null;
  try {
    current?.close();
  } catch {
    // The sql.js instance may already be poisoned; recovery happens by reopening from disk.
  }
  // Reopening cannot succeed in this process: `initSqlJs()` returns the trapped
  // module instance again, so the next `new SqlJs.Database(...)` traps the same
  // way — that is exactly the trap seen at `openMetaDbFromDisk`. Record the
  // terminal state so the process stops instead of failing every database
  // request until an unguarded timer callback kills it.
  markSqlJsRuntimeUnusable(err, "meta database");
}

function guardSqlJsCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    evictMetaDbAfterRuntimeError(err);
    throw err;
  }
}

function assertMetaDatabaseAvailable(): void {
  if (commitStateUnknown) throw commitStateUnknown;
  assertSqlJsRuntimeUsable();
}

function guardStatement<T extends Record<string, unknown>>(stmt: T): T {
  const target = stmt as Record<string, unknown>;
  for (const method of ["bind", "step", "get", "getAsObject", "run", "free"]) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = (...args: unknown[]) => guardSqlJsCall(() => original.apply(stmt, args));
  }
  return stmt;
}

function guardDatabase(database: SqlJsDatabase): SqlJsDatabase {
  const target = database as unknown as Record<string, unknown>;
  if (target.__localappMetaGuarded) return database;
  Object.defineProperty(target, "__localappMetaGuarded", { value: true });

  for (const method of ["run", "exec", "export"]) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = (...args: unknown[]) => guardSqlJsCall(() => {
      if (publishing && method !== "export") throw new Error("Meta database publication is already in progress");
      return original.apply(database, args);
    });
  }

  const originalPrepare = target.prepare;
  if (typeof originalPrepare === "function") {
    target.prepare = (...args: unknown[]) => guardStatement(guardSqlJsCall(() => {
      if (publishing) throw new Error("Meta database publication is already in progress");
      return originalPrepare.apply(database, args);
    }));
  }

  return database;
}

function openMetaDbFromDisk(): SqlJsDatabase {
  assertMetaDatabaseAvailable();
  if (!SqlJs || !dbPath) throw new Error("Meta database not initialized. Call initMetaDb first.");
  const nextDb = fs.existsSync(dbPath)
    ? new SqlJs.Database(fs.readFileSync(dbPath))
    : new SqlJs.Database();
  db = guardDatabase(nextDb);
  return db;
}

function saveDb(): void {
  assertMetaDatabaseAvailable();
  if (!db || !dbPath) return;
  if (publishing) throw new Error("Meta database publication is already in progress");
  publishing = true;
  const directory = path.dirname(dbPath);
  const temporaryPath = path.join(directory, `.${path.basename(dbPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let renamed = false;
  try {
    const buffer = Buffer.from(db.export());
    atomicFileOperations.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const descriptor = atomicFileOperations.openSync(temporaryPath, "wx", 0o600);
    try {
      atomicFileOperations.writeFileSync(descriptor, buffer);
      atomicFileOperations.fsyncSync(descriptor);
    } finally {
      atomicFileOperations.closeSync(descriptor);
    }
    atomicFileOperations.renameSync(temporaryPath, dbPath);
    renamed = true;
    syncMetaDirectory(directory);
  } catch (error) {
    try { atomicFileOperations.rmSync(temporaryPath, { force: true }); } catch { /* retain publication error */ }
    publishing = false;
    if (renamed) {
      const uncertain = new MetaDatabaseCommitStateUnknownError(error);
      commitStateUnknown = uncertain;
      const current = db;
      db = null;
      try { current?.close(); } catch { /* the process remains fail-stopped */ }
      throw uncertain;
    }
    reloadMetaDbFromVisibleDisk();
    throw error;
  } finally {
    publishing = false;
    try { atomicFileOperations.rmSync(temporaryPath, { force: true }); } catch { /* publication already completed */ }
  }
}

function syncMetaDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = atomicFileOperations.openSync(directory, "r");
    atomicFileOperations.fsyncSync(descriptor);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (["EINVAL", "EPERM", "EISDIR"].includes(code ?? "")) return;
    throw error;
  } finally {
    if (descriptor !== undefined) atomicFileOperations.closeSync(descriptor);
  }
}

function reloadMetaDbFromVisibleDisk(): void {
  const current = db;
  db = null;
  try { current?.close(); } catch { /* failed publication already fails closed */ }
  if (SqlJs && dbPath) openMetaDbFromDisk();
}

export function flushMetaDb(): void {
  saveDb();
}

export function mutateMetaDbAtomically<T>(mutation: (database: SqlJsDatabase) => T): T {
  const database = getDb();
  database.run("BEGIN IMMEDIATE");
  try {
    const result = mutation(database);
    database.run("COMMIT");
    saveDb();
    return result;
  } catch (error) {
    try { database.run("ROLLBACK"); } catch { /* publication failure reloads the visible database */ }
    throw error;
  }
}

export async function initMetaDb(
  dataDir: string,
  options: { atomicFileOperations?: MetaAtomicFileOperations; schema?: "accounts" | "platform" } = {},
): Promise<void> {
  assertMetaDatabaseAvailable();
  if (db) {
    if (options.schema === "platform") {
      initializePlatformSchema(db, initializeAccountSchema);
      saveDb();
    }
    return;
  }

  atomicFileOperations = options.atomicFileOperations ?? fs;

  if (!SqlJs) {
    SqlJs = await initSqlJs();
  }

  dbPath = path.join(dataDir, "meta.sqlite");

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = guardDatabase(new SqlJs.Database(fileBuffer));
  } else {
    db = guardDatabase(new SqlJs.Database());
  }

  if (options.schema === "accounts") initializeAccountSchema(db);
  else initializePlatformSchema(db, initializeAccountSchema);

  saveDb();

}

export function getDb(): SqlJsDatabase {
  assertMetaDatabaseAvailable();
  if (!db) return openMetaDbFromDisk();
  return db;
}

export function closeMetaDb(): void {
  if (commitStateUnknown) {
    const current = db;
    db = null;
    try { current?.close(); } catch { /* explicit shutdown clears the fail-stop latch */ }
    commitStateUnknown = null;
    publishing = false;
    return;
  }
  const current = db;
  if (current) {
    try {
      saveDb();
    } catch (err) {
      if (!isWasmRuntimeError(err)) throw err;
    }
    try {
      current.close();
    } finally {
      if (db === current) db = null;
    }
    db = null;
  }
}

const savedReplies = createSavedRepliesStore({ database: getDb, flush: saveDb });
export const { listSavedReplies, createSavedReply, updateSavedReply, deleteSavedReply } = savedReplies;

export const accountServices = createAccountServices({ database: getDb, flush: saveDb, atomic: mutateMetaDbAtomically });
const { accounts, apiKeys, groups } = accountServices;
export const validateApiKey = apiKeys.validateApiKey.bind(apiKeys);
export const createApiKey = apiKeys.createApiKey.bind(apiKeys);
export const listApiKeysByUser = apiKeys.listApiKeysByUser.bind(apiKeys);

const peerRecords = new PeerRecords({ database: getDb, flush: saveDb });
export const createPeerRecord = peerRecords.createPeerRecord.bind(peerRecords);
export const getPeerRecord = peerRecords.getPeerRecord.bind(peerRecords);
export const listPeerRecords = peerRecords.listPeerRecords.bind(peerRecords);
export const updatePeerRecord = peerRecords.updatePeerRecord.bind(peerRecords);
export const deletePeerRecord = peerRecords.deletePeerRecord.bind(peerRecords);
export const updatePeerVerificationIfCurrent = peerRecords.updatePeerVerificationIfCurrent.bind(peerRecords);

export const createUser = accounts.createUser.bind(accounts);
export const createInitialAdmin = accounts.createInitialAdmin.bind(accounts);
export const provisionUserWithApiKey = accounts.provisionUserWithApiKey.bind(accounts);
export const findUserById = accounts.findUserById.bind(accounts);
export const findUserByName = accounts.findUserByName.bind(accounts);
export const getUserRole = accounts.getUserRole.bind(accounts);
export const listUsers = accounts.listUsers.bind(accounts);
export const listAllUsersBasic = accounts.listAllUsersBasic.bind(accounts);
export const listAllUsersPlatform = accounts.listAllUsersPlatform.bind(accounts);
export const updateUserProfile = accounts.updateUserProfile.bind(accounts);
export const updateUserPassword = accounts.updateUserPassword.bind(accounts);
export const updateUserPasswordAndRevokeSessions = accounts.updateUserPasswordAndRevokeSessions.bind(accounts);
export const insertAuthSession = accounts.insertAuthSession.bind(accounts);
export const insertAuthSessionForUserVersion = accounts.insertAuthSessionForUserVersion.bind(accounts);
export const findAuthSession = accounts.findAuthSession.bind(accounts);
export const updateAuthSessionActivity = accounts.updateAuthSessionActivity.bind(accounts);
export const deleteAuthSession = accounts.deleteAuthSession.bind(accounts);
export const deleteAuthSessionsForUser = accounts.deleteAuthSessionsForUser.bind(accounts);
export const deleteExpiredAuthSessions = accounts.deleteExpiredAuthSessions.bind(accounts);
export const updateUserAvatar = accounts.updateUserAvatar.bind(accounts);
export const updateUserRole = accounts.updateUserRole.bind(accounts);
export const findUserProvider = accounts.findUserProvider.bind(accounts);
export const resetUserPassword = accounts.resetUserPassword.bind(accounts);
export const clearMustChangePassword = accounts.clearMustChangePassword.bind(accounts);
export const setMustChangePassword = accounts.setMustChangePassword.bind(accounts);
export const deleteUserById = accounts.deleteUserById.bind(accounts);

export type { RequestLogEntry, PageViewEntry } from "@localapp/dsh-app-platform/analytics";
export const analytics = new AnalyticsStore({ database: getDb, flush: saveDb });
export const insertRequestLogs = analytics.insertRequestLogs.bind(analytics);
export const insertPageViews = analytics.insertPageViews.bind(analytics);
export const cleanOldLogs = analytics.cleanOldLogs.bind(analytics);

export type { GroupRecord, GroupWithMeta } from "@localapp/dsh-multiuser/groups";
export const createGroup = groups.createGroup.bind(groups);
export const findGroupById = groups.findGroupById.bind(groups);
export const findGroupByName = groups.findGroupByName.bind(groups);
export const listGroupsByUser = groups.listGroupsByUser.bind(groups);
export const listSystemGroups = groups.listSystemGroups.bind(groups);
export const updateGroup = groups.updateGroup.bind(groups);
export const deleteGroup = groups.deleteGroup.bind(groups);
export const addGroupMembers = groups.addGroupMembers.bind(groups);
export const removeGroupMembers = groups.removeGroupMembers.bind(groups);
export const getGroupMembers = groups.getGroupMembers.bind(groups);
export const isUserInGroup = groups.isUserInGroup.bind(groups);

export type { FavoriteRecord, RecentVisitRecord } from "@localapp/dsh-app-platform/favorites";
const favorites = new FavoritesStore({ database: getDb, flush: saveDb });
export const addFavorite = favorites.addFavorite.bind(favorites);
export const removeFavorite = favorites.removeFavorite.bind(favorites);
export const isFavorited = favorites.isFavorited.bind(favorites);
export const getFavoriteCount = favorites.getFavoriteCount.bind(favorites);
export const listUserFavorites = favorites.listUserFavorites.bind(favorites);
export const listRecentVisits = favorites.listRecentVisits.bind(favorites);
