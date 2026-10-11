import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { LocalAppRuntimeError, assertSqlJsRuntimeUsable, isWasmRuntimeError, markSqlJsRuntimeUnusable, wrapDatabaseRuntimeError } from "./runtime-errors.cjs";
import { collectConvertibleIssueTasks, replaceIssueTaskContent } from "./issue-task-conversion.cjs";
import type { FieldType, FieldConstraints, DataSchema } from "./models.cjs";

type SqlValue = number | string | Buffer | null;

let SqlJs: initSqlJs.SqlJsStatic | null = null;
let databaseWriteGuard: ((dbPath: string) => void) | null = null;

export function setDatabaseWriteGuard(guard: ((dbPath: string) => void) | null): void {
  databaseWriteGuard = guard;
}

function isReadOnlySql(sql: unknown): boolean {
  if (typeof sql !== "string") return false;
  const normalized = sql.trimStart().replace(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)+/, "").trimStart().toUpperCase();
  return normalized.startsWith("SELECT") || normalized.startsWith("PRAGMA") || normalized.startsWith("EXPLAIN");
}

function assertDatabaseWriteAllowed(dbPath: string, sql: unknown): void {
  if (!isReadOnlySql(sql)) databaseWriteGuard?.(dbPath);
}

async function getSqlJs(): Promise<initSqlJs.SqlJsStatic> {
  if (!SqlJs) {
    SqlJs = await initSqlJs();
  }
  return SqlJs;
}

// ── Per-database execution queue ──

export interface DbQueueInfo {
  dbPath: string;
  waitMs: number;
}

export interface DbQueueOptions {
  timeoutMs?: number;
  onWait?: (info: DbQueueInfo) => void;
}

interface DbQueueWaiter {
  resolve: (info: DbQueueInfo) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout | null;
  enqueuedAt: number;
}

interface DbQueueState {
  active: boolean;
  waiters: DbQueueWaiter[];
}

const DEFAULT_DB_QUEUE_TIMEOUT_MS = 5_000;
const dbQueues = new Map<string, DbQueueState>();
const dbQueueOwner = new AsyncLocalStorage<string>();

export function isCurrentDbQueueOwner(dbPath: string): boolean {
  return dbQueueOwner.getStore() === path.resolve(dbPath);
}

export async function withDbQueue<T>(
  dbPath: string,
  fn: (info: DbQueueInfo) => Promise<T> | T,
  options: DbQueueOptions = {},
): Promise<T> {
  const key = path.resolve(dbPath);
  const { info, release } = await acquireDbQueue(key, options);
  options.onWait?.(info);
  try {
    return await dbQueueOwner.run(key, () => fn(info));
  } finally {
    release();
  }
}

export function configureDbQueueForTests(options: { reset?: boolean } = {}): void {
  if (!options.reset) return;
  for (const state of dbQueues.values()) {
    for (const waiter of state.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new LocalAppRuntimeError("Database queue reset", {
        status: 500,
        code: "db_runtime_error",
      }));
    }
  }
  dbQueues.clear();
}

async function acquireDbQueue(
  dbPath: string,
  options: DbQueueOptions,
): Promise<{ info: DbQueueInfo; release: () => void }> {
  const state = dbQueues.get(dbPath) ?? { active: false, waiters: [] };
  dbQueues.set(dbPath, state);
  if (!state.active) {
    state.active = true;
    return {
      info: { dbPath, waitMs: 0 },
      release: createDbQueueRelease(dbPath, state),
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_DB_QUEUE_TIMEOUT_MS;
  const enqueuedAt = Date.now();
  return new Promise((resolve, reject) => {
    const waiter: DbQueueWaiter = {
      resolve: (info) => resolve({ info, release: createDbQueueRelease(dbPath, state) }),
      reject,
      timer: null,
      enqueuedAt,
    };
    waiter.timer = setTimeout(() => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(new LocalAppRuntimeError("Database queue timed out waiting for app database", {
        status: 503,
        code: "db_queue_timeout",
        details: { waitMs: Date.now() - enqueuedAt },
      }));
    }, timeoutMs);
    state.waiters.push(waiter);
  });
}

function createDbQueueRelease(dbPath: string, state: DbQueueState): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.waiters.shift();
    if (!next) {
      state.active = false;
      if (dbQueues.get(dbPath) === state) dbQueues.delete(dbPath);
      return;
    }
    if (next.timer) clearTimeout(next.timer);
    next.resolve({ dbPath, waitMs: Date.now() - next.enqueuedAt });
  };
}

// ── Connection pool ──

interface PooledConnection {
  db: SqlJsDatabase;
  lastUsed: number;
  dirty: boolean;
  transactionDepth: number;
}

const _connections = new Map<string, PooledConnection>();
const openingConnections = new Map<string, Promise<SqlJsDatabase>>();
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export async function getConnection(dbPath: string): Promise<SqlJsDatabase> {
  const entry = _connections.get(dbPath);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.db;
  }
  const pending = openingConnections.get(dbPath);
  if (pending) return pending;
  const opening = openDatabase(dbPath).then(db => {
    _connections.set(dbPath, { db, lastUsed: Date.now(), dirty: false, transactionDepth: 0 });
    return db;
  });
  openingConnections.set(dbPath, opening);
  try { return await opening; }
  finally { if (openingConnections.get(dbPath) === opening) openingConnections.delete(dbPath); }
}

export async function exportDatabaseSnapshot(dbPath: string): Promise<Buffer> {
  return withDbQueue(dbPath, async () => {
    const db = await getConnection(dbPath);
    return Buffer.from(db.export());
  });
}

async function openDatabase(dbPath: string): Promise<SqlJsDatabase> {
  assertSqlJsRuntimeUsable();
  const SQL = await getSqlJs();
  try {
    const db = fs.existsSync(dbPath)
      ? new SQL.Database(fs.readFileSync(dbPath))
      : new SQL.Database();
    return guardDatabase(dbPath, db);
  } catch (err) {
    // A trap during the open means the module instance is torn; retrying on it
    // only traps again, so this is where the process stops instead.
    recoverFromSqlJsRuntimeError(dbPath, err);
    throw err;
  }
}

function guardDatabase(dbPath: string, database: SqlJsDatabase): SqlJsDatabase {
  const target = database as unknown as Record<string, unknown>;
  if (target.__localappAppDbGuarded) return database;
  Object.defineProperty(target, "__localappAppDbGuarded", { value: true });

  for (const method of ["run", "exec"]) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = (...args: unknown[]) => {
      assertDatabaseWriteAllowed(dbPath, args[0]);
      return guardSqlJsCall(dbPath, () => original.apply(database, args));
    };
  }

  const originalExport = target.export;
  if (typeof originalExport === "function") {
    target.export = (...args: unknown[]) => guardSqlJsCall(dbPath, () => originalExport.apply(database, args));
  }

  const originalPrepare = target.prepare;
  if (typeof originalPrepare === "function") {
    target.prepare = (...args: unknown[]) => {
      assertDatabaseWriteAllowed(dbPath, args[0]);
      return guardStatement(dbPath, guardSqlJsCall(dbPath, () => originalPrepare.apply(database, args)));
    };
  }

  return database;
}

function guardStatement<T extends Record<string, unknown>>(dbPath: string, stmt: T): T {
  const target = stmt as Record<string, unknown>;
  for (const method of ["bind", "step", "get", "getAsObject", "getColumnNames", "run", "free"]) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = (...args: unknown[]) => guardSqlJsCall(dbPath, () => original.apply(stmt, args));
  }
  return stmt;
}

function guardSqlJsCall<T>(dbPath: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    recoverFromSqlJsRuntimeError(dbPath, err);
    throw err;
  }
}

function recoverFromSqlJsRuntimeError(dbPath: string, err: unknown): void {
  if (!isWasmRuntimeError(err)) return;
  evictConnectionForDbPath(dbPath);
  // Clearing the cached module cannot help: `initSqlJs()` hands back the trapped
  // instance again, so this trap is terminal for the process.
  markSqlJsRuntimeUnusable(err, "application database");
}

function markDirty(dbPath: string): void {
  const entry = _connections.get(dbPath);
  if (entry) entry.dirty = true;
}

function saveConnection(dbPath: string): void {
  const entry = _connections.get(dbPath);
  if (!entry) return;
  if (!entry.dirty) return;
  if (entry.transactionDepth > 0) return;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = entry.db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  entry.dirty = false;
}

export function evictConnectionForDbPath(dbPath: string): void {
  const entry = _connections.get(dbPath);
  if (!entry) return;
  try {
    entry.db.close();
  } catch {
    // The connection may already be in a bad WASM state; eviction is best-effort.
  }
  _connections.delete(dbPath);
}

export function closeIdleConnections(): void {
  const now = Date.now();
  for (const [dbPath, entry] of _connections) {
    if (entry.transactionDepth > 0 || dbQueues.get(path.resolve(dbPath))?.active) continue;
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      if (entry.dirty) {
        const data = entry.db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
      }
      entry.db.close();
      _connections.delete(dbPath);
    }
  }
}

export function closeAllConnections(): void {
  for (const [dbPath, entry] of _connections) {
    if (entry.dirty) {
      const data = entry.db.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
    }
    entry.db.close();
  }
  _connections.clear();
}

/** Drain queued work before closing only connections inside this data directory. */
export async function closeConnectionsUnderDirectory(directory: string): Promise<void> {
  const root = path.resolve(directory);
  const files = [...new Set([..._connections.keys(), ...dbQueues.keys(), ...openingConnections.keys()])].filter(file => {
    const relative = path.relative(root, path.resolve(file));
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  });
  await Promise.all(files.map(file => withDbQueue(file, async () => {
    await openingConnections.get(file);
    const entry = _connections.get(file);
    if (!entry) return;
    saveConnection(file);
    entry.db.close();
    _connections.delete(file);
  })));
}

export function closeConnectionsForPage(pageDir: string): void {
  const dbPath = getDbPath(pageDir);
  const entry = _connections.get(dbPath);
  if (entry) {
    if (entry.dirty) {
      const data = entry.db.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
    }
    entry.db.close();
    _connections.delete(dbPath);
  }
}

export function execRawSql(dbPath: string, sql: string, params?: unknown[]): { columns?: string[]; rows?: Record<string, unknown>[]; changes?: number; lastInsertRowId?: number } {
  const entry = _connections.get(dbPath);
  const db = entry?.db;
  if (!db) throw new Error("No connection for " + dbPath);

  try {
    const upperSql = sql.trimStart().toUpperCase();
    const isReadOnly = upperSql.startsWith("SELECT") || upperSql.startsWith("PRAGMA");

    if (isReadOnly) {
      const results = params && params.length > 0 ? db.exec(sql, params as SqlValue[]) : db.exec(sql);
      if (results.length === 0) return { columns: [], rows: [] };
      const result = results[0];
      const rows = result.values.map((vals) => {
        const row: Record<string, unknown> = {};
        result.columns.forEach((col, i) => { row[col] = vals[i]; });
        return row;
      });
      return { columns: [...result.columns], rows };
    }

    if (params && params.length > 0) {
      db.run(sql, params as SqlValue[]);
    } else {
      db.run(sql);
    }
    const changes = db.getRowsModified();
    const lastInsertRowId = (db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] as number) ?? 0;
    markDirty(dbPath);
    if (entry.transactionDepth === 0) saveConnection(dbPath);

    return { changes, lastInsertRowId };
  } catch (err) {
    recoverFromSqlJsRuntimeError(dbPath, err);
    throw err;
  }
}

export function execQuerySqlWithBudget(
  dbPath: string,
  sql: string,
  params: unknown[] | undefined,
  budget: { sqlName: string; maxRows: number; maxBytes: number },
): { columns: string[]; rows: Record<string, unknown>[] } {
  const entry = _connections.get(dbPath);
  const db = entry?.db;
  if (!db) throw new Error("No connection for " + dbPath);

  let stmt: initSqlJs.Statement | null = null;
  try {
    stmt = db.prepare(sql, params && params.length > 0 ? params as SqlValue[] : undefined);
    const columns = stmt.getColumnNames();
    const rows: Record<string, unknown>[] = [];
    let bytes = estimateJsonBytes({ columns, rows });
    while (stmt.step()) {
      const values = stmt.get();
      const row: Record<string, unknown> = {};
      columns.forEach((column, index) => { row[column] = values[index]; });
      rows.push(row);
      bytes += estimateJsonBytes(row) + 1;
      if (rows.length > budget.maxRows || bytes > budget.maxBytes) {
        throw new LocalAppRuntimeError("Named SQL result exceeded platform budget. Use pagination or more selective filters.", {
          status: 413,
          code: "named_sql_result_too_large",
          details: {
            sqlName: budget.sqlName,
            rows: rows.length,
            bytes,
            maxRows: budget.maxRows,
            maxBytes: budget.maxBytes,
          },
        });
      }
    }
    return { columns, rows };
  } catch (err) {
    recoverFromSqlJsRuntimeError(dbPath, err);
    throw err;
  } finally {
    try {
      stmt?.free();
    } catch {
      // Ignore statement cleanup errors; the query error, if any, is more useful.
    }
  }
}

function estimateJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

export async function runDbTransaction<T>(
  dbPath: string,
  fn: () => Promise<T> | T,
  options: DbQueueOptions = {},
): Promise<T> {
  return withDbQueue(dbPath, async () => {
    const db = await getConnection(dbPath);
    const entry = _connections.get(dbPath);
    try {
      db.run("BEGIN");
      if (entry) entry.transactionDepth += 1;
    } catch (err) {
      if (isWasmRuntimeError(err)) {
        recoverFromSqlJsRuntimeError(dbPath, err);
        throw wrapDatabaseRuntimeError(err, { operation: "transaction", dbPath });
      }
      throw err;
    }
    try {
      const result = await fn();
      db.run("COMMIT");
      if (entry) entry.transactionDepth = Math.max(0, entry.transactionDepth - 1);
      markDirty(dbPath);
      saveConnection(dbPath);
      return result;
    } catch (err) {
      try {
        db.run("ROLLBACK");
        if (entry) {
          entry.transactionDepth = Math.max(0, entry.transactionDepth - 1);
          entry.dirty = false;
        }
      } catch (rollbackErr) {
        if (isWasmRuntimeError(rollbackErr)) {
          recoverFromSqlJsRuntimeError(dbPath, rollbackErr);
          throw wrapDatabaseRuntimeError(rollbackErr, { operation: "transaction", dbPath });
        }
      }
      if (isWasmRuntimeError(err)) {
        recoverFromSqlJsRuntimeError(dbPath, err);
        throw wrapDatabaseRuntimeError(err, { operation: "transaction", dbPath });
      }
      throw err;
    }
  }, options);
}

// ── Public API ──

export function isValidSchemaName(name: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(name);
}

export function fieldTypeToSql(type: FieldType): string {
  switch (type) {
    case "string":
      return "TEXT";
    case "number":
      return "REAL";
    case "boolean":
      return "INTEGER";
    case "timestamp":
      return "TEXT";
    case "auto_increment":
      return "INTEGER PRIMARY KEY AUTOINCREMENT";
    default:
      return "TEXT";
  }
}

export function getDbPath(pageDir: string): string {
  const devDb = path.join(pageDir, "dev.db");
  if (fs.existsSync(devDb)) return devDb;
  const appDb = path.join(pageDir, "app.db");
  if (fs.existsSync(appDb)) return appDb;
  const legacy = path.join(pageDir, "db.sqlite");
  if (fs.existsSync(legacy)) {
    fs.renameSync(legacy, appDb);
    return appDb;
  }
  return appDb;
}

export async function createTable(
  pageDir: string,
  schema: DataSchema,
): Promise<void> {
  const dbPath = getDbPath(pageDir);
  await withDbQueue(dbPath, async () => {
    const db = await getConnection(dbPath);

    const columns = ["id INTEGER PRIMARY KEY AUTOINCREMENT"];
    const userFieldNames = new Set(Object.keys(schema.fields));
    for (const [name, field] of Object.entries(schema.fields)) {
      columns.push(`${name} ${fieldTypeToSql(field.type)}`);
    }
    if (!userFieldNames.has("created_at")) columns.push("created_at TEXT");
    columns.push("updated_at TEXT");

    db.run(`CREATE TABLE IF NOT EXISTS ${schema.name} (${columns.join(", ")})`);
    markDirty(dbPath);
    saveConnection(dbPath);
  });
}

export async function alterTableAddColumn(
  pageDir: string,
  tableName: string,
  fieldName: string,
  fieldType: FieldType,
  constraints?: FieldConstraints,
): Promise<void> {
  const dbPath = getDbPath(pageDir);
  await withDbQueue(dbPath, async () => {
    const db = await getConnection(dbPath);
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${fieldName} ${fieldTypeToSql(fieldType)}`);
    markDirty(dbPath);
    saveConnection(dbPath);

    if (constraints?.defaultValue !== undefined) {
      db.run(`UPDATE ${tableName} SET ${fieldName} = ?`, [constraints.defaultValue as SqlValue]);
      markDirty(dbPath);
      saveConnection(dbPath);
    }
  });
}

export async function dropTable(
  pageDir: string,
  tableName: string,
): Promise<void> {
  const dbPath = getDbPath(pageDir);
  await withDbQueue(dbPath, async () => {
    const db = await getConnection(dbPath);
    db.run(`DROP TABLE IF EXISTS ${tableName}`);
    markDirty(dbPath);
    saveConnection(dbPath);
  });
}

// 注：countRows / selectAll / selectById / insertRow / updateRow / deleteRow
// 原 REST CRUD 端点的辅助函数已随 restrict-app-api-to-named-sql 变更整体移除。
// 应用层数据操作现由 named SQL 唯一承担，对应 SQL 由作者在
// backend/resources/<r>/{queries,mutations}.json 中声明。

// ── Issue support ──

export interface IssueRecord {
  id: number;
  issue_number: number;
  title: string;
  description: string;
  status: string;
  state_reason: "completed" | "not_planned" | null;
  label: string;
  issue_type: IssueType;
  reporter_id: string;
  locked_at: string | null;
  locked_by: string | null;
  lock_reason: IssueLockReason | null;
  milestone_id: number | null;
  pinned_at: string | null;
  pinned_by: string | null;
  created_at: string;
  updated_at: string;
  revision_count?: number;
}

export const ISSUE_TYPES = ["task", "bug", "feature"] as const;
export type IssueType = typeof ISSUE_TYPES[number];

export function isIssueType(value: unknown): value is IssueType {
  return typeof value === "string" && (ISSUE_TYPES as readonly string[]).includes(value);
}

export const ISSUE_LOCK_REASONS = ["resolved", "off_topic", "too_heated", "spam"] as const;
export type IssueLockReason = typeof ISSUE_LOCK_REASONS[number];

export function isIssueLockReason(value: unknown): value is IssueLockReason {
  return typeof value === "string" && (ISSUE_LOCK_REASONS as readonly string[]).includes(value);
}

export type IssueListSort = "activity" | "created" | "updated" | "comments";
export type IssueListDirection = "asc" | "desc";
export const ISSUE_SEARCH_SCOPES = ["title", "body", "comments"] as const;
export type IssueSearchScope = typeof ISSUE_SEARCH_SCOPES[number];

export function parseIssueSearchScopes(value: unknown): IssueSearchScope[] | null {
  if (typeof value !== "string" || !value) return null;
  const requested = value.split(",");
  if (requested.some((scope, index) => !ISSUE_SEARCH_SCOPES.includes(scope as IssueSearchScope) || requested.indexOf(scope) !== index)) return null;
  const canonical = ISSUE_SEARCH_SCOPES.filter((scope) => requested.includes(scope));
  return canonical.join(",") === value ? canonical : null;
}

export interface IssueListOptions {
  q?: string;
  searchIn?: readonly IssueSearchScope[];
  status?: "open" | "closed";
  label?: string;
  issueType?: IssueType;
  author?: string;
  participant?: string;
  assignee?: string;
  milestone?: number | "none";
  reason?: "completed" | "not_planned";
  subscriberId?: string;
  mentionedUserId?: string;
  locked?: boolean;
  sort?: IssueListSort;
  direction?: IssueListDirection;
  limit?: number;
  offset?: number;
}

export interface IssueListItem extends IssueRecord {
  comment_count: number;
  last_activity_at: string;
  is_blocked: number;
  is_duplicate: number;
  participant_ids: string[];
  labels: IssueLabelRecord[];
  assignee_ids: string[];
}

export interface IssueListMeta {
  total: number;
  open: number;
  closed: number;
  limit: number;
  offset: number;
}

export interface IssueListResult {
  data: IssueListItem[];
  pinned: IssueListItem[];
  meta: IssueListMeta;
}

export interface PotentialDuplicateIssue {
  id: number;
  issue_number: number;
  title: string;
  status: string;
  updated_at: string;
  last_activity_at: string;
  score: number;
  matched_in: "title" | "body" | "title,body";
}

export interface IssueCommentRecord {
  id: number;
  issue_id: number;
  body: string;
  author_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  pinned_at: string | null;
  pinned_by: string | null;
  minimized_at: string | null;
  minimized_by: string | null;
  minimized_reason: IssueCommentMinimizedReason | null;
  revision_count?: number;
}

export const ISSUE_COMMENT_MINIMIZED_REASONS = ["abuse", "off-topic", "outdated", "resolved", "duplicate", "spam"] as const;
export type IssueCommentMinimizedReason = (typeof ISSUE_COMMENT_MINIMIZED_REASONS)[number];

export function isIssueCommentMinimizedReason(value: unknown): value is IssueCommentMinimizedReason {
  return typeof value === "string" && (ISSUE_COMMENT_MINIMIZED_REASONS as readonly string[]).includes(value);
}

export type IssueRevisionTargetType = "issue" | "comment";

export interface IssueRevisionRecord {
  id: number;
  issue_id: number;
  target_type: IssueRevisionTargetType;
  target_id: number;
  editor_id: string;
  title: string | null;
  body: string;
  fields_json: string;
  created_at: string;
}

export interface IssueEventRecord {
  id: number;
  issue_id: number;
  actor_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface IssueAttachmentRecord {
  id: string;
  page_path: string;
  issue_id: number | null;
  comment_id: number | null;
  draft_id: string;
  uploader_id: string;
  storage_key: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  bound_at: string | null;
  deleted_at: string | null;
}

export interface IssueLabelRecord {
  id: string;
  name: string;
  color: string;
  description: string;
  built_in: number;
  created_at: string;
  updated_at: string;
}

export interface IssueMilestoneRecord {
  id: number;
  title: string;
  description: string;
  due_on: string | null;
  state: "open" | "closed";
  created_by: string;
  created_at: string;
  updated_at: string;
  open_issues: number;
  closed_issues: number;
}

export interface IssueCollaborationMetadata {
  labels: IssueLabelRecord[];
  assignee_ids: string[];
  subscriber_ids: string[];
  participant_ids: string[];
}

export interface IssueSubIssueItem extends IssueRecord {
  position: number;
  added_by: string;
  relation_created_at: string;
  assignee_ids: string[];
  child_count: number;
  completed_child_count: number;
  child_percent: number;
}

export interface IssueSubIssueSummary {
  total: number;
  completed: number;
  percent: number;
}

export interface IssueSubIssueListResult {
  items: IssueSubIssueItem[];
  summary: IssueSubIssueSummary;
}

export interface IssueDependencyItem extends IssueRecord {
  added_by: string;
  relation_created_at: string;
  assignee_ids: string[];
}

export interface IssueDependencySummary {
  blockedBy: number;
  blocking: number;
  unresolvedBlockers: number;
  isBlocked: boolean;
}

export interface IssueDuplicateItem extends IssueRecord {
  marked_by: string;
  comment_id: number;
  relation_created_at: string;
}

export interface IssueCrossReferenceRecord {
  id: number;
  target_issue_id: number;
  source_issue_id: number;
  source_issue_number: number;
  source_issue_title: string;
  source_issue_status: string;
  source_type: "issue" | "comment";
  source_id: number;
  source_comment_id: number | null;
  actor_id: string;
  excerpt: string;
  created_at: string;
  updated_at: string;
}

export const ISSUE_REACTION_CONTENTS = ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"] as const;
export type IssueReactionContent = typeof ISSUE_REACTION_CONTENTS[number];

export interface IssueReactionRecord {
  issue_id: number;
  comment_id: number;
  user_id: string;
  content: IssueReactionContent;
  created_at: string;
}

export function isIssueReactionContent(value: unknown): value is IssueReactionContent {
  return typeof value === "string" && (ISSUE_REACTION_CONTENTS as readonly string[]).includes(value);
}

export type IssueTimelineItem =
  | { kind: "comment"; comment: IssueCommentRecord }
  | { kind: "event"; event: IssueEventRecord }
  | { kind: "cross_reference"; crossReference: IssueCrossReferenceRecord };

export interface IssueDetail {
  issue: IssueRecord;
  timeline: IssueTimelineItem[];
  attachments: IssueAttachmentRecord[];
  collaboration: IssueCollaborationMetadata;
  reactions: IssueReactionRecord[];
  parent: IssueRecord | null;
  subIssues: IssueSubIssueItem[];
  subIssueSummary: IssueSubIssueSummary;
  blockedBy: IssueDependencyItem[];
  blocking: IssueDependencyItem[];
  dependencySummary: IssueDependencySummary;
  duplicateOf: IssueDuplicateItem | null;
  duplicates: IssueDuplicateItem[];
}

export async function ensureIssueTables(dbPath: string): Promise<void> {
  const db = await getConnection(dbPath);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      state_reason TEXT,
      label TEXT NOT NULL DEFAULT 'task',
      issue_type TEXT NOT NULL DEFAULT 'task',
      reporter_id TEXT NOT NULL,
      locked_at TEXT,
      locked_by TEXT,
      lock_reason TEXT,
      milestone_id INTEGER,
      pinned_at TEXT,
      pinned_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const issueColumns = db.exec("PRAGMA table_info(_issues)")[0]?.values.map((row) => String(row[1])) ?? [];
  if (!issueColumns.includes("issue_type")) {
    db.run("ALTER TABLE _issues ADD COLUMN issue_type TEXT NOT NULL DEFAULT 'task'");
    db.run("UPDATE _issues SET issue_type = CASE WHEN label = 'feature' THEN 'feature' WHEN label = 'bug' THEN 'bug' ELSE 'task' END");
  }
  if (!issueColumns.includes("state_reason")) {
    db.run("ALTER TABLE _issues ADD COLUMN state_reason TEXT");
    db.run("UPDATE _issues SET state_reason = 'completed' WHERE status = 'closed' AND state_reason IS NULL");
  }
  if (!issueColumns.includes("locked_at")) db.run("ALTER TABLE _issues ADD COLUMN locked_at TEXT");
  if (!issueColumns.includes("locked_by")) db.run("ALTER TABLE _issues ADD COLUMN locked_by TEXT");
  if (!issueColumns.includes("lock_reason")) db.run("ALTER TABLE _issues ADD COLUMN lock_reason TEXT");
  if (!issueColumns.includes("milestone_id")) db.run("ALTER TABLE _issues ADD COLUMN milestone_id INTEGER");
  if (!issueColumns.includes("pinned_at")) db.run("ALTER TABLE _issues ADD COLUMN pinned_at TEXT");
  if (!issueColumns.includes("pinned_by")) db.run("ALTER TABLE _issues ADD COLUMN pinned_by TEXT");
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      author_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      pinned_at TEXT,
      pinned_by TEXT,
      minimized_at TEXT,
      minimized_by TEXT,
      minimized_reason TEXT
    )
  `);
  const commentColumns = db.exec("PRAGMA table_info(_issue_comments)")[0]?.values.map((row) => String(row[1])) ?? [];
  if (!commentColumns.includes("pinned_at")) db.run("ALTER TABLE _issue_comments ADD COLUMN pinned_at TEXT");
  if (!commentColumns.includes("pinned_by")) db.run("ALTER TABLE _issue_comments ADD COLUMN pinned_by TEXT");
  if (!commentColumns.includes("minimized_at")) db.run("ALTER TABLE _issue_comments ADD COLUMN minimized_at TEXT");
  if (!commentColumns.includes("minimized_by")) db.run("ALTER TABLE _issue_comments ADD COLUMN minimized_by TEXT");
  if (!commentColumns.includes("minimized_reason")) db.run("ALTER TABLE _issue_comments ADD COLUMN minimized_reason TEXT");
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      actor_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_attachments (
      id TEXT PRIMARY KEY,
      page_path TEXT NOT NULL DEFAULT '',
      issue_id INTEGER,
      comment_id INTEGER,
      draft_id TEXT NOT NULL,
      uploader_id TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      bound_at TEXT,
      deleted_at TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      built_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      due_on TEXT,
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_label_links (
      issue_id INTEGER NOT NULL,
      label_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (issue_id, label_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_assignees (
      issue_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      assigned_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (issue_id, user_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_subscriptions (
      issue_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (issue_id, user_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_sub_issues (
      parent_issue_id INTEGER NOT NULL,
      child_issue_id INTEGER NOT NULL UNIQUE,
      position INTEGER NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (parent_issue_id, child_issue_id),
      CHECK (parent_issue_id <> child_issue_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_dependencies (
      blocked_issue_id INTEGER NOT NULL,
      blocking_issue_id INTEGER NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (blocked_issue_id, blocking_issue_id),
      CHECK (blocked_issue_id <> blocking_issue_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_duplicates (
      duplicate_issue_id INTEGER PRIMARY KEY,
      canonical_issue_id INTEGER NOT NULL,
      marked_by TEXT NOT NULL,
      comment_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (duplicate_issue_id <> canonical_issue_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_cross_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_issue_id INTEGER NOT NULL,
      source_issue_id INTEGER NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('issue', 'comment')),
      source_id INTEGER NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (source_type, source_id, target_issue_id),
      CHECK (source_issue_id <> target_issue_id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_issue_cross_references_target ON _issue_cross_references(target_issue_id, created_at, id)");
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_mentions (
      issue_id INTEGER NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('issue', 'comment')),
      target_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (target_type, target_id, user_id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_issue_mentions_user ON _issue_mentions(user_id, issue_id)");
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_reactions (
      issue_id INTEGER NOT NULL,
      comment_id INTEGER NOT NULL DEFAULT 0,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (issue_id, comment_id, user_id, content)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('issue', 'comment')),
      target_id INTEGER NOT NULL,
      editor_id TEXT NOT NULL,
      title TEXT,
      body TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS _issue_saved_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      query_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, name)
    )
  `);
  db.run(`CREATE TRIGGER IF NOT EXISTS _issue_revisions_no_update
    BEFORE UPDATE ON _issue_revisions
    BEGIN SELECT RAISE(ABORT, 'Issue revisions are immutable'); END`);
  db.run("DROP TRIGGER IF EXISTS _issue_revisions_no_delete");
  db.run(`CREATE TRIGGER _issue_revisions_no_delete
    BEFORE DELETE ON _issue_revisions
    WHEN EXISTS (SELECT 1 FROM _issues WHERE id = OLD.issue_id)
    BEGIN SELECT RAISE(ABORT, 'Issue revisions are immutable'); END`);
  const attachmentColumns = db.exec("PRAGMA table_info(_issue_attachments)")[0]?.values.map((row) => String(row[1])) ?? [];
  if (!attachmentColumns.includes("page_path")) {
    db.run("ALTER TABLE _issue_attachments ADD COLUMN page_path TEXT NOT NULL DEFAULT ''");
  }
  db.run("CREATE INDEX IF NOT EXISTS _issues_list_idx ON _issues(status, label, created_at)");
  db.run("CREATE INDEX IF NOT EXISTS _issues_reporter_idx ON _issues(reporter_id)");
  db.run("CREATE INDEX IF NOT EXISTS _issues_milestone_idx ON _issues(milestone_id, status)");
  db.run("CREATE INDEX IF NOT EXISTS _issues_pinned_idx ON _issues(pinned_at DESC, issue_number DESC) WHERE pinned_at IS NOT NULL");
  db.run("CREATE INDEX IF NOT EXISTS _issue_comments_list_idx ON _issue_comments(issue_id, deleted_at, created_at)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_comments_issue_idx ON _issue_comments(issue_id, created_at)");
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS _issue_comments_one_pin_idx ON _issue_comments(issue_id) WHERE pinned_at IS NOT NULL AND deleted_at IS NULL");
  db.run("CREATE INDEX IF NOT EXISTS _issue_events_issue_idx ON _issue_events(issue_id, created_at)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_attachments_issue_idx ON _issue_attachments(issue_id, comment_id)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_attachments_draft_idx ON _issue_attachments(draft_id, uploader_id)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_label_links_label_idx ON _issue_label_links(label_id, issue_id)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_assignees_user_idx ON _issue_assignees(user_id, issue_id)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_subscriptions_user_idx ON _issue_subscriptions(user_id, issue_id)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_sub_issues_parent_idx ON _issue_sub_issues(parent_issue_id, position, child_issue_id)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_dependencies_blocking_idx ON _issue_dependencies(blocking_issue_id, blocked_issue_id)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_duplicates_canonical_idx ON _issue_duplicates(canonical_issue_id, duplicate_issue_id)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_reactions_target_idx ON _issue_reactions(issue_id, comment_id, content)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_revisions_target_idx ON _issue_revisions(issue_id, target_type, target_id, created_at)");
  db.run("CREATE INDEX IF NOT EXISTS _issue_saved_views_user_idx ON _issue_saved_views(user_id, id)");
  db.run("DELETE FROM _issue_label_links WHERE label_id IN (SELECT id FROM _issue_labels WHERE built_in = 1 AND id IN ('bug', 'feature'))");
  db.run("DELETE FROM _issue_labels WHERE built_in = 1 AND id IN ('bug', 'feature')");
  markDirty(dbPath);
  saveConnection(dbPath);
}

export async function listIssueLabels(dbPath: string): Promise<IssueLabelRecord[]> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const stmt = db.prepare("SELECT * FROM _issue_labels ORDER BY built_in DESC, id");
  const labels: IssueLabelRecord[] = [];
  while (stmt.step()) labels.push(stmt.getAsObject() as unknown as IssueLabelRecord);
  stmt.free();
  return labels;
}

export async function createIssueLabel(
  dbPath: string,
  input: { id: string; name: string; color: string; description?: string },
): Promise<IssueLabelRecord> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO _issue_labels (id, name, color, description, built_in, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [input.id, input.name, input.color, input.description ?? "", now, now],
  );
  markDirty(dbPath);
  saveConnection(dbPath);
  return (await getIssueLabel(dbPath, input.id))!;
}

async function getIssueLabel(dbPath: string, labelId: string): Promise<IssueLabelRecord | null> {
  const db = await getConnection(dbPath);
  const stmt = db.prepare("SELECT * FROM _issue_labels WHERE id = ?");
  stmt.bind([labelId]);
  const label = stmt.step() ? stmt.getAsObject() as unknown as IssueLabelRecord : null;
  stmt.free();
  return label;
}

export async function updateIssueLabel(
  dbPath: string,
  labelId: string,
  updates: { name?: string; color?: string; description?: string },
): Promise<IssueLabelRecord | null> {
  await ensureIssueTables(dbPath);
  const existing = await getIssueLabel(dbPath, labelId);
  if (!existing) return null;
  if (existing.built_in) throw new Error("Built-in Issue labels cannot be edited");
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  for (const field of ["name", "color", "description"] as const) {
    if (updates[field] === undefined) continue;
    clauses.push(`${field} = ?`);
    params.push(updates[field]!);
  }
  if (clauses.length === 0) return getIssueLabel(dbPath, labelId);
  clauses.push("updated_at = ?");
  params.push(new Date().toISOString(), labelId);
  const db = await getConnection(dbPath);
  db.run(`UPDATE _issue_labels SET ${clauses.join(", ")} WHERE id = ?`, params);
  markDirty(dbPath);
  saveConnection(dbPath);
  return getIssueLabel(dbPath, labelId);
}

export async function deleteIssueLabel(dbPath: string, labelId: string): Promise<boolean> {
  await ensureIssueTables(dbPath);
  const label = await getIssueLabel(dbPath, labelId);
  if (!label) return false;
  if (label.built_in) throw new Error("Built-in Issue labels cannot be deleted");
  const db = await getConnection(dbPath);
  db.run("DELETE FROM _issue_label_links WHERE label_id = ?", [labelId]);
  db.run("DELETE FROM _issue_labels WHERE id = ?", [labelId]);
  markDirty(dbPath);
  saveConnection(dbPath);
  return true;
}

export async function listIssueMilestones(dbPath: string): Promise<IssueMilestoneRecord[]> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const stmt = db.prepare(`
    SELECT m.*,
      SUM(CASE WHEN i.status = 'open' THEN 1 ELSE 0 END) AS open_issues,
      SUM(CASE WHEN i.status = 'closed' THEN 1 ELSE 0 END) AS closed_issues
    FROM _issue_milestones m
    LEFT JOIN _issues i ON i.milestone_id = m.id
    GROUP BY m.id
    ORDER BY CASE WHEN m.state = 'open' THEN 0 ELSE 1 END, m.due_on IS NULL, m.due_on, m.id`);
  const milestones: IssueMilestoneRecord[] = [];
  while (stmt.step()) milestones.push(stmt.getAsObject() as unknown as IssueMilestoneRecord);
  stmt.free();
  return milestones;
}

export async function createIssueMilestone(
  dbPath: string,
  input: { title: string; description?: string; dueOn?: string | null; createdBy: string },
): Promise<IssueMilestoneRecord> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO _issue_milestones (title, description, due_on, state, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?)`,
    [input.title, input.description ?? "", input.dueOn ?? null, input.createdBy, now, now],
  );
  const id = Number(db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] ?? 0);
  markDirty(dbPath);
  saveConnection(dbPath);
  return (await listIssueMilestones(dbPath)).find((milestone) => milestone.id === id)!;
}

export async function updateIssueMilestone(
  dbPath: string,
  milestoneId: number,
  updates: { title?: string; description?: string; dueOn?: string | null; state?: "open" | "closed" },
): Promise<IssueMilestoneRecord | null> {
  await ensureIssueTables(dbPath);
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  const fieldValues = { title: updates.title, description: updates.description, due_on: updates.dueOn, state: updates.state };
  for (const [field, value] of Object.entries(fieldValues)) {
    if (value === undefined) continue;
    clauses.push(`${field} = ?`);
    params.push(value);
  }
  if (clauses.length === 0) return (await listIssueMilestones(dbPath)).find(({ id }) => id === milestoneId) ?? null;
  clauses.push("updated_at = ?");
  params.push(new Date().toISOString(), milestoneId);
  const db = await getConnection(dbPath);
  db.run(`UPDATE _issue_milestones SET ${clauses.join(", ")} WHERE id = ?`, params);
  if (db.getRowsModified() === 0) return null;
  markDirty(dbPath);
  saveConnection(dbPath);
  return (await listIssueMilestones(dbPath)).find(({ id }) => id === milestoneId) ?? null;
}

export async function deleteIssueMilestone(dbPath: string, milestoneId: number): Promise<boolean> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  db.run("UPDATE _issues SET milestone_id = NULL WHERE milestone_id = ?", [milestoneId]);
  db.run("DELETE FROM _issue_milestones WHERE id = ?", [milestoneId]);
  if (db.getRowsModified() === 0) return false;
  markDirty(dbPath);
  saveConnection(dbPath);
  return true;
}

export async function setIssueMilestone(dbPath: string, issueId: number, milestoneId: number | null): Promise<void> {
  await ensureIssueTables(dbPath);
  await assertIssueExists(dbPath, issueId);
  const db = await getConnection(dbPath);
  if (milestoneId !== null) {
    const stmt = db.prepare("SELECT 1 FROM _issue_milestones WHERE id = ?");
    stmt.bind([milestoneId]);
    const exists = stmt.step();
    stmt.free();
    if (!exists) throw new Error("Unknown Issue milestone");
  }
  db.run("UPDATE _issues SET milestone_id = ?, updated_at = ? WHERE id = ?", [milestoneId, new Date().toISOString(), issueId]);
  markDirty(dbPath);
  saveConnection(dbPath);
}

async function assertIssueExists(dbPath: string, issueId: number): Promise<void> {
  if (!await getIssueById(dbPath, issueId)) throw new Error(`Issue ${issueId} not found`);
}

export async function replaceIssueLabels(dbPath: string, issueId: number, labelIds: string[]): Promise<void> {
  await ensureIssueTables(dbPath);
  await assertIssueExists(dbPath, issueId);
  const ids = Array.from(new Set(labelIds));
  const db = await getConnection(dbPath);
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = db.prepare(`SELECT id FROM _issue_labels WHERE id IN (${placeholders})`);
    stmt.bind(ids);
    let known = 0;
    while (stmt.step()) known += 1;
    stmt.free();
    if (known !== ids.length) throw new Error("Unknown Issue label");
  }
  db.run("DELETE FROM _issue_label_links WHERE issue_id = ?", [issueId]);
  const now = new Date().toISOString();
  for (const labelId of ids) {
    db.run("INSERT INTO _issue_label_links (issue_id, label_id, created_at) VALUES (?, ?, ?)", [issueId, labelId, now]);
  }
  markDirty(dbPath);
  saveConnection(dbPath);
}

export async function replaceIssueAssignees(
  dbPath: string,
  issueId: number,
  userIds: string[],
  assignedBy: string,
): Promise<void> {
  await ensureIssueTables(dbPath);
  await assertIssueExists(dbPath, issueId);
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  const db = await getConnection(dbPath);
  db.run("DELETE FROM _issue_assignees WHERE issue_id = ?", [issueId]);
  const now = new Date().toISOString();
  for (const userId of ids) {
    db.run(
      "INSERT INTO _issue_assignees (issue_id, user_id, assigned_by, created_at) VALUES (?, ?, ?, ?)",
      [issueId, userId, assignedBy, now],
    );
  }
  markDirty(dbPath);
  saveConnection(dbPath);
}

export async function setIssueSubscription(
  dbPath: string,
  issueId: number,
  userId: string,
  subscribed: boolean,
): Promise<void> {
  await ensureIssueTables(dbPath);
  await assertIssueExists(dbPath, issueId);
  const db = await getConnection(dbPath);
  if (subscribed) {
    db.run(
      "INSERT OR IGNORE INTO _issue_subscriptions (issue_id, user_id, created_at) VALUES (?, ?, ?)",
      [issueId, userId, new Date().toISOString()],
    );
  } else {
    db.run("DELETE FROM _issue_subscriptions WHERE issue_id = ? AND user_id = ?", [issueId, userId]);
  }
  markDirty(dbPath);
  saveConnection(dbPath);
}

export async function getIssueCollaborationMetadata(
  dbPath: string,
  issueId: number,
): Promise<IssueCollaborationMetadata> {
  await ensureIssueTables(dbPath);
  const issue = await getIssueById(dbPath, issueId);
  if (!issue) throw new Error(`Issue ${issueId} not found`);
  const db = await getConnection(dbPath);
  const labels: IssueLabelRecord[] = [];
  const labelStmt = db.prepare(
    `SELECT l.* FROM _issue_labels l
     INNER JOIN _issue_label_links link ON link.label_id = l.id
     WHERE link.issue_id = ? ORDER BY l.id`,
  );
  labelStmt.bind([issueId]);
  while (labelStmt.step()) labels.push(labelStmt.getAsObject() as unknown as IssueLabelRecord);
  labelStmt.free();

  const readUserIds = (table: "_issue_assignees" | "_issue_subscriptions"): string[] => {
    const stmt = db.prepare(`SELECT user_id FROM ${table} WHERE issue_id = ? ORDER BY user_id`);
    stmt.bind([issueId]);
    const ids: string[] = [];
    while (stmt.step()) ids.push(String((stmt.getAsObject() as { user_id: string }).user_id));
    stmt.free();
    return ids;
  };
  const assigneeIds = readUserIds("_issue_assignees");
  const subscriberIds = readUserIds("_issue_subscriptions");
  const participantStmt = db.prepare(`
    SELECT participant_id FROM (
      SELECT reporter_id AS participant_id FROM _issues WHERE id = ?
      UNION SELECT author_id FROM _issue_comments WHERE issue_id = ? AND deleted_at IS NULL
      UNION SELECT actor_id FROM _issue_events WHERE issue_id = ? AND event_type NOT IN ('subscribed', 'unsubscribed')
      UNION SELECT user_id FROM _issue_assignees WHERE issue_id = ?
    ) ORDER BY participant_id`);
  participantStmt.bind([issueId, issueId, issueId, issueId]);
  const participantIds: string[] = [];
  while (participantStmt.step()) participantIds.push(String((participantStmt.getAsObject() as { participant_id: string }).participant_id));
  participantStmt.free();
  return { labels, assignee_ids: assigneeIds, subscriber_ids: subscriberIds, participant_ids: participantIds };
}

export async function getNextIssueNumber(dbPath: string): Promise<number> {
  const db = await getConnection(dbPath);
  const stmt = db.prepare("SELECT COALESCE(MAX(issue_number), 0) + 1 as next_num FROM _issues");
  let num = 1;
  if (stmt.step()) {
    num = (stmt.getAsObject() as { next_num: number }).next_num;
  }
  stmt.free();
  return num;
}

export async function insertIssue(
  dbPath: string,
  title: string,
  description: string,
  issueType: IssueType,
  reporterId: string,
): Promise<{ id: number; issueNumber: number }> {
  if (!isIssueType(issueType)) throw new Error("Invalid Issue type");
  await ensureIssueTables(dbPath);
  const issueNumber = await getNextIssueNumber(dbPath);
  const db = await getConnection(dbPath);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO _issues (issue_number, title, description, status, label, issue_type, reporter_id, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    [issueNumber, title, description, issueType, issueType, reporterId, now, now],
  );
  const lastId = (db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] as number) ?? 0;
  markDirty(dbPath);
  saveConnection(dbPath);
  return { id: lastId, issueNumber };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalizePotentialDuplicateText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function potentialDuplicateTokens(value: string): Set<string> {
  const normalized = normalizePotentialDuplicateText(value);
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-z0-9]+/gu)) {
    const token = match[0];
    if (/^[a-z0-9]+$/.test(token)) {
      if (token.length >= 2) tokens.add(token);
      continue;
    }
    const characters = Array.from(token);
    if (characters.length === 1) tokens.add(characters[0]);
    else for (let index = 0; index < characters.length - 1; index += 1) tokens.add(`${characters[index]}${characters[index + 1]}`);
  }
  return tokens;
}

function potentialDuplicateCoverage(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.min(left.size, right.size);
}

export async function listPotentialDuplicateIssues(
  dbPath: string,
  title: string,
  body: string,
  limit = 3,
): Promise<PotentialDuplicateIssue[]> {
  const normalizedTitle = normalizePotentialDuplicateText(title);
  if (!normalizedTitle || Array.from(body).length < 100) return [];
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const statement = db.prepare("SELECT id, issue_number, title, description, status, updated_at FROM _issues ORDER BY updated_at DESC, issue_number DESC LIMIT 1000");
  const queryTitleTokens = potentialDuplicateTokens(title);
  const queryBodyTokens = potentialDuplicateTokens(body);
  const candidates: Array<PotentialDuplicateIssue & { sort_updated_at: string }> = [];
  while (statement.step()) {
    const row = statement.getAsObject() as unknown as Pick<IssueRecord, "id" | "issue_number" | "title" | "description" | "status" | "updated_at">;
    const normalizedCandidateTitle = normalizePotentialDuplicateText(row.title);
    const candidateTitleTokens = potentialDuplicateTokens(row.title);
    const candidateBodyTokens = potentialDuplicateTokens(`${row.title} ${row.description}`);
    const titleCoverage = potentialDuplicateCoverage(queryTitleTokens, candidateTitleTokens);
    const bodyCoverage = potentialDuplicateCoverage(queryBodyTokens, candidateBodyTokens);
    const titleContainment = normalizedCandidateTitle === normalizedTitle
      ? 1
      : normalizedCandidateTitle.includes(normalizedTitle) || normalizedTitle.includes(normalizedCandidateTitle) ? 0.9 : 0;
    const score = Math.min(1, Math.max(titleContainment, titleCoverage * 0.75 + bodyCoverage * 0.25));
    if (score < 0.18) continue;
    const activityStmt = db.prepare(`
      SELECT MAX(activity_at) AS last_activity_at FROM (
        SELECT updated_at AS activity_at FROM _issues WHERE id = ?
        UNION ALL SELECT created_at FROM _issue_comments WHERE issue_id = ? AND deleted_at IS NULL
        UNION ALL SELECT created_at FROM _issue_events WHERE issue_id = ? AND event_type NOT IN ('subscribed', 'unsubscribed')
      )`);
    activityStmt.bind([row.id, row.id, row.id]);
    const lastActivityAt = activityStmt.step() ? String(activityStmt.getAsObject().last_activity_at ?? row.updated_at) : row.updated_at;
    activityStmt.free();
    const matchedIn = titleCoverage > 0 || titleContainment > 0
      ? bodyCoverage > 0 ? "title,body" as const : "title" as const
      : "body" as const;
    candidates.push({
      id: row.id,
      issue_number: row.issue_number,
      title: row.title,
      status: row.status,
      updated_at: row.updated_at,
      last_activity_at: lastActivityAt,
      score: Number(score.toFixed(4)),
      matched_in: matchedIn,
      sort_updated_at: row.updated_at,
    });
  }
  statement.free();
  return candidates
    .sort((left, right) => right.score - left.score || right.sort_updated_at.localeCompare(left.sort_updated_at) || right.issue_number - left.issue_number)
    .slice(0, Math.min(Math.max(limit, 1), 3))
    .map(({ sort_updated_at: _sortUpdatedAt, ...candidate }) => candidate);
}

export async function listIssues(
  dbPath: string,
  options: IssueListOptions = {},
): Promise<IssueListResult> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const conditions: string[] = [];
  const filterParams: SqlValue[] = [];
  const lifecycleCountConditions: string[] = [];
  const lifecycleCountParams: SqlValue[] = [];
  const addFilter = (condition: string, params: SqlValue[] = [], includeInLifecycleCounts = true) => {
    conditions.push(condition);
    filterParams.push(...params);
    if (includeInLifecycleCounts) {
      lifecycleCountConditions.push(condition);
      lifecycleCountParams.push(...params);
    }
  };

  if (options.q) {
    const pattern = `%${escapeLikePattern(options.q)}%`;
    const scopes = options.searchIn?.length ? options.searchIn : ISSUE_SEARCH_SCOPES;
    const searchConditions: string[] = [];
    const searchParams: SqlValue[] = [];
    if (scopes.includes("title")) {
      searchConditions.push(`i.title LIKE ? ESCAPE '\\'`);
      searchParams.push(pattern);
    }
    if (scopes.includes("body")) {
      searchConditions.push(`i.description LIKE ? ESCAPE '\\'`);
      searchParams.push(pattern);
    }
    if (scopes.includes("comments")) {
      searchConditions.push(`EXISTS (
        SELECT 1 FROM _issue_comments search_comment
        WHERE search_comment.issue_id = i.id
          AND search_comment.deleted_at IS NULL
          AND search_comment.body LIKE ? ESCAPE '\\'
      )`);
      searchParams.push(pattern);
    }
    addFilter(`(${searchConditions.join(" OR ")})`, searchParams);
  }
  if (options.status) {
    addFilter("i.status = ?", [options.status], false);
  }
  if (options.label === "none") {
    addFilter("NOT EXISTS (SELECT 1 FROM _issue_label_links link WHERE link.issue_id = i.id)");
  } else if (options.label) {
    addFilter("EXISTS (SELECT 1 FROM _issue_label_links link WHERE link.issue_id = i.id AND link.label_id = ?)", [options.label]);
  }
  if (options.issueType) addFilter("i.issue_type = ?", [options.issueType]);
  if (options.author) {
    addFilter("i.reporter_id = ?", [options.author]);
  }
  if (options.participant) {
    addFilter(`(
      i.reporter_id = ?
      OR EXISTS (SELECT 1 FROM _issue_comments c WHERE c.issue_id = i.id AND c.deleted_at IS NULL AND c.author_id = ?)
      OR EXISTS (SELECT 1 FROM _issue_events e WHERE e.issue_id = i.id AND e.actor_id = ? AND e.event_type NOT IN ('subscribed', 'unsubscribed'))
      OR EXISTS (SELECT 1 FROM _issue_assignees a WHERE a.issue_id = i.id AND a.user_id = ?)
    )`, [options.participant, options.participant, options.participant, options.participant]);
  }
  if (options.assignee === "none") {
    addFilter("NOT EXISTS (SELECT 1 FROM _issue_assignees assignee WHERE assignee.issue_id = i.id)");
  } else if (options.assignee) {
    addFilter("EXISTS (SELECT 1 FROM _issue_assignees assignee WHERE assignee.issue_id = i.id AND assignee.user_id = ?)", [options.assignee]);
  }
  if (options.milestone === "none") {
    addFilter("i.milestone_id IS NULL");
  } else if (options.milestone !== undefined) {
    addFilter("i.milestone_id = ?", [options.milestone]);
  }
  if (options.reason === "completed") {
    addFilter("(i.state_reason = 'completed' OR i.state_reason IS NULL)");
  } else if (options.reason === "not_planned") {
    addFilter("i.state_reason = 'not_planned'");
  }
  if (options.subscriberId) {
    addFilter("EXISTS (SELECT 1 FROM _issue_subscriptions subscription WHERE subscription.issue_id = i.id AND subscription.user_id = ?)", [options.subscriberId]);
  }
  if (options.mentionedUserId) {
    addFilter("EXISTS (SELECT 1 FROM _issue_mentions mention WHERE mention.issue_id = i.id AND mention.user_id = ?)", [options.mentionedUserId]);
  }
  if (options.locked !== undefined) addFilter(options.locked ? "i.locked_at IS NOT NULL" : "i.locked_at IS NULL");

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const lifecycleWhere = lifecycleCountConditions.length > 0 ? `${lifecycleCountConditions.join(" AND ")} AND ` : "";
  const sortExpressions: Record<IssueListSort, string> = {
    activity: "activities.last_activity_at",
    created: "i.created_at",
    updated: "i.updated_at",
    comments: "COALESCE(comment_counts.comment_count, 0)",
  };
  const sort = options.sort && options.sort in sortExpressions ? options.sort : "activity";
  const direction = options.direction === "asc" ? "ASC" : "DESC";
  const limit = Number.isInteger(options.limit)
    ? Math.min(Math.max(options.limit!, 1), 100)
    : 25;
  const offset = Number.isInteger(options.offset) && options.offset! >= 0 ? options.offset! : 0;
  const aggregateCtes = `
    WITH comment_counts AS (
      SELECT issue_id, COUNT(*) AS comment_count
      FROM _issue_comments
      WHERE deleted_at IS NULL
      GROUP BY issue_id
    ), activities AS (
      SELECT i.id AS issue_id,
        COALESCE(MAX(activity.activity_at), i.updated_at, i.created_at) AS last_activity_at
      FROM _issues i
      LEFT JOIN (
        SELECT id AS issue_id, updated_at AS activity_at FROM _issues
        UNION ALL
        SELECT issue_id, created_at AS activity_at FROM _issue_comments WHERE deleted_at IS NULL
        UNION ALL
        SELECT issue_id, created_at AS activity_at FROM _issue_events WHERE event_type NOT IN ('subscribed', 'unsubscribed')
      ) activity ON activity.issue_id = i.id
      GROUP BY i.id
    )`;

  const listStmt = db.prepare(`${aggregateCtes}
    SELECT i.*, COALESCE(comment_counts.comment_count, 0) AS comment_count, activities.last_activity_at,
      EXISTS (
        SELECT 1 FROM _issue_dependencies dependency
        INNER JOIN _issues blocker ON blocker.id = dependency.blocking_issue_id
        WHERE dependency.blocked_issue_id = i.id AND blocker.status = 'open'
      ) AS is_blocked,
      EXISTS (SELECT 1 FROM _issue_duplicates duplicate WHERE duplicate.duplicate_issue_id = i.id) AS is_duplicate
    FROM _issues i
    LEFT JOIN comment_counts ON comment_counts.issue_id = i.id
    LEFT JOIN activities ON activities.issue_id = i.id
    ${where}
    ORDER BY ${sortExpressions[sort]} ${direction}, i.issue_number DESC
    LIMIT ? OFFSET ?`);
  listStmt.bind([...filterParams, limit, offset]);
  const data: IssueListItem[] = [];
  while (listStmt.step()) {
    data.push({
      ...listStmt.getAsObject() as unknown as Omit<IssueListItem, "participant_ids" | "labels" | "assignee_ids">,
      participant_ids: [],
      labels: [],
      assignee_ids: [],
    });
  }
  listStmt.free();

  const pinnedStmt = db.prepare(`${aggregateCtes}
    SELECT i.*, COALESCE(comment_counts.comment_count, 0) AS comment_count, activities.last_activity_at,
      EXISTS (
        SELECT 1 FROM _issue_dependencies dependency
        INNER JOIN _issues blocker ON blocker.id = dependency.blocking_issue_id
        WHERE dependency.blocked_issue_id = i.id AND blocker.status = 'open'
      ) AS is_blocked,
      EXISTS (SELECT 1 FROM _issue_duplicates duplicate WHERE duplicate.duplicate_issue_id = i.id) AS is_duplicate
    FROM _issues i
    LEFT JOIN comment_counts ON comment_counts.issue_id = i.id
    LEFT JOIN activities ON activities.issue_id = i.id
    WHERE i.pinned_at IS NOT NULL
    ORDER BY i.pinned_at DESC, i.issue_number DESC
    LIMIT 3`);
  const pinned: IssueListItem[] = [];
  while (pinnedStmt.step()) {
    pinned.push({
      ...pinnedStmt.getAsObject() as unknown as Omit<IssueListItem, "participant_ids" | "labels" | "assignee_ids">,
      participant_ids: [],
      labels: [],
      assignee_ids: [],
    });
  }
  pinnedStmt.free();

  const countStmt = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM _issues i ${where}) AS total,
      (SELECT COUNT(*) FROM _issues i WHERE ${lifecycleWhere}i.status = 'open') AS open,
      (SELECT COUNT(*) FROM _issues i WHERE ${lifecycleWhere}i.status = 'closed') AS closed`);
  const countParams = [...filterParams, ...lifecycleCountParams, ...lifecycleCountParams];
  if (countParams.length > 0) countStmt.bind(countParams);
  const count = countStmt.step()
    ? countStmt.getAsObject() as { total: number; open: number; closed: number }
    : { total: 0, open: 0, closed: 0 };
  countStmt.free();

  const hydrated = [...data, ...pinned.filter((issue) => !data.some((item) => item.id === issue.id))];
  if (hydrated.length > 0) {
    const issueIds = hydrated.map((issue) => issue.id);
    const placeholders = issueIds.map(() => "?").join(", ");
    const participantStmt = db.prepare(`
      SELECT issue_id, participant_id FROM (
        SELECT id AS issue_id, reporter_id AS participant_id FROM _issues WHERE id IN (${placeholders})
        UNION
        SELECT issue_id, author_id AS participant_id FROM _issue_comments WHERE issue_id IN (${placeholders}) AND deleted_at IS NULL
        UNION
        SELECT issue_id, actor_id AS participant_id FROM _issue_events WHERE issue_id IN (${placeholders}) AND event_type NOT IN ('subscribed', 'unsubscribed')
        UNION
        SELECT issue_id, user_id AS participant_id FROM _issue_assignees WHERE issue_id IN (${placeholders})
      ) ORDER BY issue_id, participant_id`);
    participantStmt.bind([...issueIds, ...issueIds, ...issueIds, ...issueIds]);
    const participantsByIssue = new Map(hydrated.map((issue) => [issue.id, issue.participant_ids]));
    while (participantStmt.step()) {
      const row = participantStmt.getAsObject() as { issue_id: number; participant_id: string };
      participantsByIssue.get(row.issue_id)?.push(row.participant_id);
    }
    participantStmt.free();

    const labelStmt = db.prepare(`
      SELECT link.issue_id, l.* FROM _issue_label_links link
      INNER JOIN _issue_labels l ON l.id = link.label_id
      WHERE link.issue_id IN (${placeholders}) ORDER BY link.issue_id, l.id`);
    labelStmt.bind(issueIds);
    const labelsByIssue = new Map(hydrated.map((issue) => [issue.id, issue.labels]));
    while (labelStmt.step()) {
      const row = labelStmt.getAsObject() as unknown as IssueLabelRecord & { issue_id: number };
      const { issue_id: issueId, ...label } = row;
      labelsByIssue.get(issueId)?.push(label);
    }
    labelStmt.free();

    const assigneeStmt = db.prepare(`
      SELECT issue_id, user_id FROM _issue_assignees
      WHERE issue_id IN (${placeholders}) ORDER BY issue_id, user_id`);
    assigneeStmt.bind(issueIds);
    const assigneesByIssue = new Map(hydrated.map((issue) => [issue.id, issue.assignee_ids]));
    while (assigneeStmt.step()) {
      const row = assigneeStmt.getAsObject() as { issue_id: number; user_id: string };
      assigneesByIssue.get(row.issue_id)?.push(row.user_id);
    }
    assigneeStmt.free();
  }
  for (const pinnedIssue of pinned) {
    const listedIssue = data.find((issue) => issue.id === pinnedIssue.id);
    if (!listedIssue) continue;
    pinnedIssue.participant_ids = [...listedIssue.participant_ids];
    pinnedIssue.labels = [...listedIssue.labels];
    pinnedIssue.assignee_ids = [...listedIssue.assignee_ids];
  }

  return {
    data,
    pinned,
    meta: { total: count.total, open: count.open, closed: count.closed, limit, offset },
  };
}

export async function getIssueById(dbPath: string, id: number): Promise<IssueRecord | null> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const stmt = db.prepare("SELECT * FROM _issues WHERE id = ?");
  stmt.bind([id]);
  let row: IssueRecord | null = null;
  if (stmt.step()) {
    row = stmt.getAsObject() as unknown as IssueRecord;
  }
  stmt.free();
  return row;
}

export async function getIssueByNumber(dbPath: string, issueNumber: number): Promise<IssueRecord | null> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const stmt = db.prepare("SELECT * FROM _issues WHERE issue_number = ?");
  stmt.bind([issueNumber]);
  const row = stmt.step() ? stmt.getAsObject() as unknown as IssueRecord : null;
  stmt.free();
  return row;
}

export async function updateIssue(
  dbPath: string,
  id: number,
  updates: { status?: string; stateReason?: "completed" | "not_planned" | null; label?: string; issueType?: IssueType; title?: string; description?: string },
): Promise<boolean> {
  const existing = await getIssueById(dbPath, id);
  if (!existing) return false;
  const db = await getConnection(dbPath);
  const setClauses: string[] = [];
  const params: SqlValue[] = [];
  if (updates.status) {
    setClauses.push("status = ?");
    params.push(updates.status);
  }
  if (updates.stateReason !== undefined) {
    setClauses.push("state_reason = ?");
    params.push(updates.stateReason);
  }
  if (updates.label) {
    setClauses.push("label = ?");
    params.push(updates.label);
  }
  if (updates.issueType !== undefined) {
    if (!isIssueType(updates.issueType)) throw new Error("Invalid Issue type");
    setClauses.push("issue_type = ?", "label = ?");
    params.push(updates.issueType, updates.issueType);
  }
  if (updates.title !== undefined) {
    setClauses.push("title = ?");
    params.push(updates.title);
  }
  if (updates.description !== undefined) {
    setClauses.push("description = ?");
    params.push(updates.description);
  }
  if (setClauses.length === 0) return true;
  setClauses.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);
  db.run(`UPDATE _issues SET ${setClauses.join(", ")} WHERE id = ?`, params);
  markDirty(dbPath);
  saveConnection(dbPath);
  return true;
}

export async function getIssueComment(dbPath: string, commentId: number): Promise<IssueCommentRecord | null> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const stmt = db.prepare("SELECT * FROM _issue_comments WHERE id = ?");
  stmt.bind([commentId]);
  const row = stmt.step() ? stmt.getAsObject() as unknown as IssueCommentRecord : null;
  stmt.free();
  return row;
}

export async function setIssueLock(dbPath: string, issueId: number, lockedBy: string | null, reason: IssueLockReason | null = null): Promise<boolean> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const now = new Date().toISOString();
  db.run(
    "UPDATE _issues SET locked_at = ?, locked_by = ?, lock_reason = ?, updated_at = ? WHERE id = ?",
    [lockedBy === null ? null : now, lockedBy, lockedBy === null ? null : reason, now, issueId],
  );
  if (db.getRowsModified() === 0) return false;
  markDirty(dbPath);
  saveConnection(dbPath);
  return true;
}

export type IssuePinResult = "updated" | "unchanged" | "not_found" | "limit";

export async function setIssuePin(dbPath: string, issueId: number, actorId: string, pinned: boolean): Promise<IssuePinResult> {
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    const issue = await getIssueById(dbPath, issueId);
    if (!issue) return "not_found";
    if ((issue.pinned_at !== null) === pinned) return "unchanged";
    const db = await getConnection(dbPath);
    if (pinned) {
      const count = Number(db.exec("SELECT COUNT(*) FROM _issues WHERE pinned_at IS NOT NULL")[0]?.values[0]?.[0] ?? 0);
      if (count >= 3) return "limit";
    }
    const now = new Date().toISOString();
    db.run(
      "UPDATE _issues SET pinned_at = ?, pinned_by = ?, updated_at = ? WHERE id = ?",
      [pinned ? now : null, pinned ? actorId : null, now, issueId],
    );
    await insertIssueEvent(dbPath, issueId, actorId, pinned ? "pinned" : "unpinned", {});
    return "updated";
  });
}

export const MAX_ISSUE_SUB_ISSUES = 100;
export const MAX_ISSUE_SUB_ISSUE_DEPTH = 8;
export type AddIssueSubIssueResult =
  | "added"
  | "not_found"
  | "self_reference"
  | "duplicate"
  | "has_parent"
  | "cycle"
  | "limit"
  | "depth";

export async function addIssueSubIssue(
  dbPath: string,
  parentIssueId: number,
  childIssueId: number,
  actorId: string,
  options: { joinTransaction?: boolean } = {},
): Promise<AddIssueSubIssueResult> {
  await ensureIssueTables(dbPath);
  const execute = async (): Promise<AddIssueSubIssueResult> => {
    if (parentIssueId === childIssueId) return "self_reference";
    const parent = await getIssueById(dbPath, parentIssueId);
    const child = await getIssueById(dbPath, childIssueId);
    if (!parent || !child) return "not_found";
    const db = await getConnection(dbPath);
    const rows = db.exec("SELECT parent_issue_id, child_issue_id FROM _issue_sub_issues")[0]?.values ?? [];
    const parentByChild = new Map<number, number>();
    const childrenByParent = new Map<number, number[]>();
    for (const row of rows) {
      const existingParentId = Number(row[0]);
      const existingChildId = Number(row[1]);
      parentByChild.set(existingChildId, existingParentId);
      childrenByParent.set(existingParentId, [...(childrenByParent.get(existingParentId) ?? []), existingChildId]);
    }
    const existingParent = parentByChild.get(childIssueId);
    if (existingParent === parentIssueId) return "duplicate";
    if (existingParent !== undefined) return "has_parent";

    const ancestorIds = new Set<number>();
    let ancestor: number | undefined = parentIssueId;
    while (ancestor !== undefined && !ancestorIds.has(ancestor)) {
      ancestorIds.add(ancestor);
      ancestor = parentByChild.get(ancestor);
    }
    if (ancestorIds.has(childIssueId)) return "cycle";
    if ((childrenByParent.get(parentIssueId)?.length ?? 0) >= MAX_ISSUE_SUB_ISSUES) return "limit";

    const subtreeHeight = (issueId: number, visiting = new Set<number>()): number => {
      if (visiting.has(issueId)) return MAX_ISSUE_SUB_ISSUE_DEPTH + 1;
      const children = childrenByParent.get(issueId) ?? [];
      if (children.length === 0) return 1;
      const nextVisiting = new Set(visiting).add(issueId);
      return 1 + Math.max(...children.map((id) => subtreeHeight(id, nextVisiting)));
    };
    if (ancestorIds.size + subtreeHeight(childIssueId) > MAX_ISSUE_SUB_ISSUE_DEPTH) return "depth";

    const nextPosition = Number(db.exec(
      `SELECT COALESCE(MAX(position), -1) + 1 FROM _issue_sub_issues WHERE parent_issue_id = ${parentIssueId}`,
    )[0]?.values[0]?.[0] ?? 0);
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO _issue_sub_issues (parent_issue_id, child_issue_id, position, added_by, created_at) VALUES (?, ?, ?, ?, ?)",
      [parentIssueId, childIssueId, nextPosition, actorId, now],
    );
    db.run("UPDATE _issues SET updated_at = ? WHERE id IN (?, ?)", [now, parentIssueId, childIssueId]);
    await insertIssueEvent(dbPath, parentIssueId, actorId, "sub_issue_added", { childIssueId, childIssueNumber: child.issue_number });
    await insertIssueEvent(dbPath, childIssueId, actorId, "parent_added", { parentIssueId, parentIssueNumber: parent.issue_number });
    return "added";
  };
  return options.joinTransaction ? execute() : runDbTransaction(dbPath, execute);
}

export async function removeIssueSubIssue(
  dbPath: string,
  parentIssueId: number,
  childIssueId: number,
  actorId: string,
): Promise<"removed" | "not_found"> {
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    const parent = await getIssueById(dbPath, parentIssueId);
    const child = await getIssueById(dbPath, childIssueId);
    if (!parent || !child) return "not_found";
    const db = await getConnection(dbPath);
    db.run("DELETE FROM _issue_sub_issues WHERE parent_issue_id = ? AND child_issue_id = ?", [parentIssueId, childIssueId]);
    if (db.getRowsModified() === 0) return "not_found";
    const remaining = db.exec(`SELECT child_issue_id FROM _issue_sub_issues WHERE parent_issue_id = ${parentIssueId} ORDER BY position, child_issue_id`)[0]?.values ?? [];
    const compact = db.prepare("UPDATE _issue_sub_issues SET position = ? WHERE parent_issue_id = ? AND child_issue_id = ?");
    try { remaining.forEach((row, position) => compact.run([position, parentIssueId, Number(row[0])])); }
    finally { compact.free(); }
    const now = new Date().toISOString();
    db.run("UPDATE _issues SET updated_at = ? WHERE id IN (?, ?)", [now, parentIssueId, childIssueId]);
    await insertIssueEvent(dbPath, parentIssueId, actorId, "sub_issue_removed", { childIssueId, childIssueNumber: child.issue_number });
    await insertIssueEvent(dbPath, childIssueId, actorId, "parent_removed", { parentIssueId, parentIssueNumber: parent.issue_number });
    return "removed";
  });
}

export type ReprioritizeIssueSubIssueResult = "reordered" | "unchanged" | "parent_not_found" | "child_not_found" | "after_not_found" | "self_after";

export async function reprioritizeIssueSubIssue(
  dbPath: string,
  parentIssueId: number,
  childIssueId: number,
  afterIssueId: number | null,
  actorId: string,
): Promise<ReprioritizeIssueSubIssueResult> {
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    if (childIssueId === afterIssueId) return "self_after";
    if (!await getIssueById(dbPath, parentIssueId)) return "parent_not_found";
    const db = await getConnection(dbPath);
    const rows = db.exec(`
      SELECT child_issue_id FROM _issue_sub_issues
      WHERE parent_issue_id = ${parentIssueId}
      ORDER BY position, child_issue_id
    `)[0]?.values ?? [];
    const current = rows.map((row) => Number(row[0]));
    const currentIndex = current.indexOf(childIssueId);
    if (currentIndex < 0) return "child_not_found";
    const afterIndex = afterIssueId === null ? -1 : current.indexOf(afterIssueId);
    if (afterIssueId !== null && afterIndex < 0) return "after_not_found";

    const previousAfterIssueId = currentIndex === 0 ? null : current[currentIndex - 1];
    if (previousAfterIssueId === afterIssueId) return "unchanged";
    const reordered = current.filter((id) => id !== childIssueId);
    const insertionIndex = afterIssueId === null ? 0 : reordered.indexOf(afterIssueId) + 1;
    reordered.splice(insertionIndex, 0, childIssueId);
    const update = db.prepare("UPDATE _issue_sub_issues SET position = ? WHERE parent_issue_id = ? AND child_issue_id = ?");
    try {
      reordered.forEach((id, position) => { update.run([position, parentIssueId, id]); });
    } finally { update.free(); }
    const now = new Date().toISOString();
    db.run("UPDATE _issues SET updated_at = ? WHERE id = ?", [now, parentIssueId]);
    await insertIssueEvent(dbPath, parentIssueId, actorId, "sub_issue_reordered", { childIssueId, afterIssueId, previousAfterIssueId, position: insertionIndex });
    return "reordered";
  });
}

export async function listIssueAncestorIds(dbPath: string, issueId: number): Promise<number[]> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const ancestors: number[] = [];
  const visited = new Set<number>([issueId]);
  let childId = issueId;
  for (let depth = 0; depth < MAX_ISSUE_SUB_ISSUE_DEPTH; depth += 1) {
    const statement = db.prepare("SELECT parent_issue_id FROM _issue_sub_issues WHERE child_issue_id = ?");
    statement.bind([childId]);
    const parentId = statement.step() ? Number(statement.getAsObject().parent_issue_id) : null;
    statement.free();
    if (parentId === null || visited.has(parentId)) break;
    ancestors.push(parentId);
    visited.add(parentId);
    childId = parentId;
  }
  return ancestors;
}

export async function listIssueSubIssues(dbPath: string, parentIssueId: number): Promise<IssueSubIssueListResult> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const items: IssueSubIssueItem[] = [];
  const statement = db.prepare(`
    SELECT i.*, relation.position, relation.added_by, relation.created_at AS relation_created_at,
      COUNT(children.child_issue_id) AS child_count,
      COALESCE(SUM(CASE WHEN child_issue.status = 'closed' THEN 1 ELSE 0 END), 0) AS completed_child_count
    FROM _issue_sub_issues relation
    INNER JOIN _issues i ON i.id = relation.child_issue_id
    LEFT JOIN _issue_sub_issues children ON children.parent_issue_id = i.id
    LEFT JOIN _issues child_issue ON child_issue.id = children.child_issue_id
    WHERE relation.parent_issue_id = ?
    GROUP BY relation.parent_issue_id, relation.child_issue_id
    ORDER BY relation.position, i.issue_number`);
  statement.bind([parentIssueId]);
  while (statement.step()) {
    const item = statement.getAsObject() as unknown as IssueSubIssueItem;
    item.child_count = Number(item.child_count ?? 0);
    item.completed_child_count = Number(item.completed_child_count ?? 0);
    item.child_percent = item.child_count === 0 ? 0 : Math.round(item.completed_child_count / item.child_count * 100);
    const assignees = db.prepare("SELECT user_id FROM _issue_assignees WHERE issue_id = ? ORDER BY user_id");
    assignees.bind([item.id]);
    item.assignee_ids = [];
    while (assignees.step()) item.assignee_ids.push(String(assignees.getAsObject().user_id));
    assignees.free();
    items.push(item);
  }
  statement.free();
  const completed = items.filter((item) => item.status === "closed").length;
  return { items, summary: { total: items.length, completed, percent: items.length === 0 ? 0 : Math.round(completed / items.length * 100) } };
}

export type ConvertIssueTaskToSubIssueResult =
  | { status: "converted"; childIssueId: number; childIssueNumber: number; title: string; addedTargetIssueIds: number[]; removedTargetIssueIds: number[] }
  | { status: "not_found" | "content_conflict" | "task_not_found" | "task_not_convertible" | "title_invalid" }
  | { status: "relation_conflict"; reason: Exclude<AddIssueSubIssueResult, "added" | "not_found"> };

class IssueTaskConversionAbort extends Error {
  constructor(readonly result: ConvertIssueTaskToSubIssueResult) {
    super(result.status);
  }
}

export async function convertIssueTaskToSubIssue(
  dbPath: string,
  input: {
    parentIssueId: number;
    taskIndex: number;
    expectedUpdatedAt: string;
    actorId: string;
    title?: string;
    resolveMentionUserIds?: (markdown: string) => Promise<string[]>;
  },
): Promise<ConvertIssueTaskToSubIssueResult> {
  await ensureIssueTables(dbPath);
  try {
    return await runDbTransaction(dbPath, async () => {
      const parent = await getIssueById(dbPath, input.parentIssueId);
      if (!parent) return { status: "not_found" };
      if (parent.updated_at !== input.expectedUpdatedAt) return { status: "content_conflict" };
      const task = collectConvertibleIssueTasks(parent.description)[input.taskIndex];
      if (!task) return { status: "task_not_found" };
      if (!task.convertible) return { status: "task_not_convertible" };
      const title = (input.title ?? task.title).trim();
      if (!title || Array.from(title).length > 256) return { status: "title_invalid" };

      const child = await insertIssue(dbPath, title, "", "feature", input.actorId);
      await insertIssueEvent(dbPath, child.id, input.actorId, "opened", {});
      await setIssueSubscription(dbPath, child.id, input.actorId, true);
      const relation = await addIssueSubIssue(dbPath, input.parentIssueId, child.id, input.actorId, { joinTransaction: true });
      if (relation !== "added") {
        const result: ConvertIssueTaskToSubIssueResult = relation === "not_found"
          ? { status: "not_found" }
          : { status: "relation_conflict", reason: relation };
        throw new IssueTaskConversionAbort(result);
      }

      const description = replaceIssueTaskContent(parent.description, input.taskIndex, `#${child.issueNumber}`);
      await insertIssueRevision(dbPath, {
        issueId: parent.id,
        targetType: "issue",
        targetId: parent.id,
        editorId: input.actorId,
        title: parent.title,
        body: parent.description,
        fields: ["description"],
      });
      await updateIssue(dbPath, parent.id, { description });
      const crossReferences = await reconcileIssueCrossReferences(dbPath, {
        sourceIssueId: parent.id,
        sourceType: "issue",
        sourceId: parent.id,
        actorId: input.actorId,
        markdown: description,
      });
      if (input.resolveMentionUserIds) {
        await replaceIssueMentions(dbPath, {
          issueId: parent.id,
          targetType: "issue",
          targetId: parent.id,
          userIds: await input.resolveMentionUserIds(`${parent.title}\n\n${description}`),
        });
      }
      await insertIssueEvent(dbPath, parent.id, input.actorId, "task_converted_to_sub_issue", {
        taskIndex: input.taskIndex,
        childIssueId: child.id,
        childIssueNumber: child.issueNumber,
      });
      return {
        status: "converted",
        childIssueId: child.id,
        childIssueNumber: child.issueNumber,
        title,
        addedTargetIssueIds: crossReferences.addedTargetIssueIds,
        removedTargetIssueIds: crossReferences.removedTargetIssueIds,
      };
    });
  } catch (error) {
    if (error instanceof IssueTaskConversionAbort) return error.result;
    throw error;
  }
}

export const MAX_ISSUE_DEPENDENCIES = 100;
export type AddIssueDependencyResult = "added" | "not_found" | "self_reference" | "duplicate" | "cycle" | "limit";

export async function addIssueDependency(
  dbPath: string,
  blockedIssueId: number,
  blockingIssueId: number,
  actorId: string,
): Promise<AddIssueDependencyResult> {
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    if (blockedIssueId === blockingIssueId) return "self_reference";
    const blockedIssue = await getIssueById(dbPath, blockedIssueId);
    const blockingIssue = await getIssueById(dbPath, blockingIssueId);
    if (!blockedIssue || !blockingIssue) return "not_found";
    const db = await getConnection(dbPath);
    const rows = db.exec("SELECT blocked_issue_id, blocking_issue_id FROM _issue_dependencies")[0]?.values ?? [];
    const blockedByBlocking = new Map<number, number[]>();
    for (const row of rows) {
      const existingBlockedId = Number(row[0]);
      const existingBlockingId = Number(row[1]);
      if (existingBlockedId === blockedIssueId && existingBlockingId === blockingIssueId) return "duplicate";
      blockedByBlocking.set(existingBlockingId, [...(blockedByBlocking.get(existingBlockingId) ?? []), existingBlockedId]);
    }
    const reachesBlockingIssue = (issueId: number, visited = new Set<number>()): boolean => {
      if (issueId === blockingIssueId) return true;
      if (visited.has(issueId)) return false;
      const nextVisited = new Set(visited).add(issueId);
      return (blockedByBlocking.get(issueId) ?? []).some((nextId) => reachesBlockingIssue(nextId, nextVisited));
    };
    if (reachesBlockingIssue(blockedIssueId)) return "cycle";
    const blockedByCount = rows.filter((row) => Number(row[0]) === blockedIssueId).length;
    const blockingCount = rows.filter((row) => Number(row[1]) === blockingIssueId).length;
    if (blockedByCount >= MAX_ISSUE_DEPENDENCIES || blockingCount >= MAX_ISSUE_DEPENDENCIES) return "limit";

    const now = new Date().toISOString();
    db.run(
      "INSERT INTO _issue_dependencies (blocked_issue_id, blocking_issue_id, added_by, created_at) VALUES (?, ?, ?, ?)",
      [blockedIssueId, blockingIssueId, actorId, now],
    );
    db.run("UPDATE _issues SET updated_at = ? WHERE id IN (?, ?)", [now, blockedIssueId, blockingIssueId]);
    await insertIssueEvent(dbPath, blockedIssueId, actorId, "dependency_blocked_by_added", {
      blockingIssueId,
      blockingIssueNumber: blockingIssue.issue_number,
    });
    await insertIssueEvent(dbPath, blockingIssueId, actorId, "dependency_blocking_added", {
      blockedIssueId,
      blockedIssueNumber: blockedIssue.issue_number,
    });
    return "added";
  });
}

export async function removeIssueDependency(
  dbPath: string,
  blockedIssueId: number,
  blockingIssueId: number,
  actorId: string,
): Promise<"removed" | "not_found"> {
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    const blockedIssue = await getIssueById(dbPath, blockedIssueId);
    const blockingIssue = await getIssueById(dbPath, blockingIssueId);
    if (!blockedIssue || !blockingIssue) return "not_found";
    const db = await getConnection(dbPath);
    db.run("DELETE FROM _issue_dependencies WHERE blocked_issue_id = ? AND blocking_issue_id = ?", [blockedIssueId, blockingIssueId]);
    if (db.getRowsModified() === 0) return "not_found";
    const now = new Date().toISOString();
    db.run("UPDATE _issues SET updated_at = ? WHERE id IN (?, ?)", [now, blockedIssueId, blockingIssueId]);
    await insertIssueEvent(dbPath, blockedIssueId, actorId, "dependency_blocked_by_removed", {
      blockingIssueId,
      blockingIssueNumber: blockingIssue.issue_number,
    });
    await insertIssueEvent(dbPath, blockingIssueId, actorId, "dependency_blocking_removed", {
      blockedIssueId,
      blockedIssueNumber: blockedIssue.issue_number,
    });
    return "removed";
  });
}

export function parseIssueDuplicateReference(body: string): number | null {
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*duplicate of #(\d+)\s*$/i);
    if (!match) continue;
    const issueNumber = Number(match[1]);
    if (Number.isSafeInteger(issueNumber) && issueNumber > 0) return issueNumber;
  }
  return null;
}

export type InsertIssueDuplicateResult =
  | "created"
  | "not_found"
  | "self_reference"
  | "already_marked"
  | "canonical_is_duplicate"
  | "has_duplicates";

export async function insertIssueDuplicateComment(
  dbPath: string,
  input: { duplicateIssueId: number; canonicalIssueNumber: number; actorId: string; body: string },
): Promise<{ status: InsertIssueDuplicateResult; comment?: IssueCommentRecord }> {
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    const duplicate = await getIssueById(dbPath, input.duplicateIssueId);
    const canonical = await getIssueByNumber(dbPath, input.canonicalIssueNumber);
    if (!duplicate || !canonical) return { status: "not_found" };
    if (duplicate.id === canonical.id) return { status: "self_reference" };
    const db = await getConnection(dbPath);
    const existing = db.prepare("SELECT canonical_issue_id FROM _issue_duplicates WHERE duplicate_issue_id = ?");
    existing.bind([duplicate.id]);
    const alreadyMarked = existing.step();
    existing.free();
    if (alreadyMarked) return { status: "already_marked" };
    const canonicalRelation = db.prepare("SELECT 1 FROM _issue_duplicates WHERE duplicate_issue_id = ?");
    canonicalRelation.bind([canonical.id]);
    const canonicalIsDuplicate = canonicalRelation.step();
    canonicalRelation.free();
    if (canonicalIsDuplicate) return { status: "canonical_is_duplicate" };
    const reverseRelation = db.prepare("SELECT 1 FROM _issue_duplicates WHERE canonical_issue_id = ?");
    reverseRelation.bind([duplicate.id]);
    const hasDuplicates = reverseRelation.step();
    reverseRelation.free();
    if (hasDuplicates) return { status: "has_duplicates" };

    const comment = await insertIssueComment(dbPath, duplicate.id, input.body, input.actorId);
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO _issue_duplicates (duplicate_issue_id, canonical_issue_id, marked_by, comment_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [duplicate.id, canonical.id, input.actorId, comment.id, now],
    );
    db.run("UPDATE _issues SET updated_at = ? WHERE id IN (?, ?)", [now, duplicate.id, canonical.id]);
    const payload = {
      duplicateIssueId: duplicate.id,
      duplicateIssueNumber: duplicate.issue_number,
      canonicalIssueId: canonical.id,
      canonicalIssueNumber: canonical.issue_number,
      commentId: comment.id,
    };
    await insertIssueEvent(dbPath, duplicate.id, input.actorId, "marked_as_duplicate", payload);
    await insertIssueEvent(dbPath, canonical.id, input.actorId, "marked_as_duplicate", payload);
    return { status: "created", comment };
  });
}

export async function markIssueDuplicateWithComment(
  dbPath: string,
  input: { duplicateIssueId: number; canonicalIssueNumber: number; actorId: string; commentId: number },
): Promise<InsertIssueDuplicateResult> {
  await ensureIssueTables(dbPath);
  const duplicate = await getIssueById(dbPath, input.duplicateIssueId);
  const canonical = await getIssueByNumber(dbPath, input.canonicalIssueNumber);
  if (!duplicate || !canonical) return "not_found";
  if (duplicate.id === canonical.id) return "self_reference";
  const db = await getConnection(dbPath);
  const hasRow = (sql: string, value: number) => {
    const stmt = db.prepare(sql); stmt.bind([value]); const found = stmt.step(); stmt.free(); return found;
  };
  if (hasRow("SELECT 1 FROM _issue_duplicates WHERE duplicate_issue_id = ?", duplicate.id)) return "already_marked";
  if (hasRow("SELECT 1 FROM _issue_duplicates WHERE duplicate_issue_id = ?", canonical.id)) return "canonical_is_duplicate";
  if (hasRow("SELECT 1 FROM _issue_duplicates WHERE canonical_issue_id = ?", duplicate.id)) return "has_duplicates";
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO _issue_duplicates (duplicate_issue_id, canonical_issue_id, marked_by, comment_id, created_at) VALUES (?, ?, ?, ?, ?)",
    [duplicate.id, canonical.id, input.actorId, input.commentId, now],
  );
  db.run("UPDATE _issues SET updated_at = ? WHERE id IN (?, ?)", [now, duplicate.id, canonical.id]);
  const payload = {
    duplicateIssueId: duplicate.id,
    duplicateIssueNumber: duplicate.issue_number,
    canonicalIssueId: canonical.id,
    canonicalIssueNumber: canonical.issue_number,
    commentId: input.commentId,
  };
  await insertIssueEvent(dbPath, duplicate.id, input.actorId, "marked_as_duplicate", payload);
  await insertIssueEvent(dbPath, canonical.id, input.actorId, "marked_as_duplicate", payload);
  return "created";
}

export async function unmarkIssueDuplicate(
  dbPath: string,
  duplicateIssueId: number,
  canonicalIssueId: number,
  actorId: string,
): Promise<"removed" | "not_found"> {
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    const duplicate = await getIssueById(dbPath, duplicateIssueId);
    const canonical = await getIssueById(dbPath, canonicalIssueId);
    if (!duplicate || !canonical) return "not_found";
    const db = await getConnection(dbPath);
    db.run("DELETE FROM _issue_duplicates WHERE duplicate_issue_id = ? AND canonical_issue_id = ?", [duplicateIssueId, canonicalIssueId]);
    if (db.getRowsModified() === 0) return "not_found";
    const now = new Date().toISOString();
    db.run("UPDATE _issues SET updated_at = ? WHERE id IN (?, ?)", [now, duplicateIssueId, canonicalIssueId]);
    const payload = {
      duplicateIssueId,
      duplicateIssueNumber: duplicate.issue_number,
      canonicalIssueId,
      canonicalIssueNumber: canonical.issue_number,
    };
    await insertIssueEvent(dbPath, duplicateIssueId, actorId, "unmarked_as_duplicate", payload);
    await insertIssueEvent(dbPath, canonicalIssueId, actorId, "unmarked_as_duplicate", payload);
    return "removed";
  });
}

export async function insertIssueComment(
  dbPath: string,
  issueId: number,
  body: string,
  authorId: string,
): Promise<IssueCommentRecord> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO _issue_comments (issue_id, body, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [issueId, body, authorId, now, now],
  );
  const id = (db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] as number) ?? 0;
  markDirty(dbPath);
  saveConnection(dbPath);
  return (await getIssueComment(dbPath, id))!;
}

export function extractIssueReferenceNumbers(markdown: string): number[] {
  const withoutFencedCode = markdown.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\n|$)/g, "$1");
  const withoutInlineCode = withoutFencedCode.replace(/`+[^`\n]*`+/g, "");
  const references = new Set<number>();
  for (const match of withoutInlineCode.matchAll(/(^|[^\\\p{L}\p{N}_])#([1-9]\d*)\b/gu)) {
    const issueNumber = Number(match[2]);
    if (Number.isSafeInteger(issueNumber)) references.add(issueNumber);
  }
  return [...references];
}

export interface ReconcileIssueCrossReferencesResult {
  addedTargetIssueIds: number[];
  removedTargetIssueIds: number[];
}

export async function reconcileIssueCrossReferences(
  dbPath: string,
  input: {
    sourceIssueId: number;
    sourceType: "issue" | "comment";
    sourceId: number;
    actorId: string;
    markdown: string;
  },
): Promise<ReconcileIssueCrossReferencesResult> {
  await ensureIssueTables(dbPath);
  const sourceIssue = await getIssueById(dbPath, input.sourceIssueId);
  if (!sourceIssue || (input.sourceType === "issue" && input.sourceId !== input.sourceIssueId)) throw new Error("Issue cross-reference source not found");
  if (input.sourceType === "comment") {
    const comment = await getIssueComment(dbPath, input.sourceId);
    if (!comment || comment.issue_id !== input.sourceIssueId || comment.deleted_at) throw new Error("Issue cross-reference source not found");
  }

  const desiredTargetIds = new Set<number>();
  for (const issueNumber of extractIssueReferenceNumbers(input.markdown)) {
    const target = await getIssueByNumber(dbPath, issueNumber);
    if (target && target.id !== input.sourceIssueId) desiredTargetIds.add(target.id);
  }

  const db = await getConnection(dbPath);
  const existingTargetIds = new Set<number>();
  const existingStmt = db.prepare("SELECT target_issue_id FROM _issue_cross_references WHERE source_type = ? AND source_id = ?");
  existingStmt.bind([input.sourceType, input.sourceId]);
  while (existingStmt.step()) existingTargetIds.add(Number(existingStmt.getAsObject().target_issue_id));
  existingStmt.free();

  const addedTargetIssueIds = [...desiredTargetIds].filter((id) => !existingTargetIds.has(id)).sort((a, b) => a - b);
  const removedTargetIssueIds = [...existingTargetIds].filter((id) => !desiredTargetIds.has(id)).sort((a, b) => a - b);
  const now = new Date().toISOString();
  for (const targetIssueId of removedTargetIssueIds) {
    db.run("DELETE FROM _issue_cross_references WHERE source_type = ? AND source_id = ? AND target_issue_id = ?", [input.sourceType, input.sourceId, targetIssueId]);
  }
  for (const targetIssueId of addedTargetIssueIds) {
    db.run(
      `INSERT OR IGNORE INTO _issue_cross_references
        (target_issue_id, source_issue_id, source_type, source_id, actor_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [targetIssueId, input.sourceIssueId, input.sourceType, input.sourceId, input.actorId, now, now],
    );
  }
  if (addedTargetIssueIds.length > 0 || removedTargetIssueIds.length > 0) {
    markDirty(dbPath);
    saveConnection(dbPath);
  }
  return { addedTargetIssueIds, removedTargetIssueIds };
}

export async function updateIssueComment(
  dbPath: string,
  commentId: number,
  body: string,
  authorId: string,
): Promise<IssueCommentRecord | null> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  db.run(
    "UPDATE _issue_comments SET body = ?, updated_at = ? WHERE id = ? AND author_id = ? AND deleted_at IS NULL",
    [body, new Date().toISOString(), commentId, authorId],
  );
  if (db.getRowsModified() === 0) return null;
  markDirty(dbPath);
  saveConnection(dbPath);
  return getIssueComment(dbPath, commentId);
}

export type IssueCommentPinResult = "pinned" | "unpinned" | "unchanged" | "conflict" | "not_found";

export async function setIssueCommentPin(
  dbPath: string,
  issueId: number,
  commentId: number,
  actorId: string,
  pinned: boolean,
): Promise<IssueCommentPinResult> {
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    const db = await getConnection(dbPath);
    const comment = await getIssueComment(dbPath, commentId);
    if (!comment || comment.issue_id !== issueId || comment.deleted_at) return "not_found";
    if (pinned && comment.pinned_at) return "unchanged";
    if (!pinned && !comment.pinned_at) return "unchanged";

    if (pinned) {
      const pinnedStmt = db.prepare(
        "SELECT id FROM _issue_comments WHERE issue_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL LIMIT 1",
      );
      pinnedStmt.bind([issueId]);
      const existingPinnedId = pinnedStmt.step() ? Number(pinnedStmt.getAsObject().id) : null;
      pinnedStmt.free();
      if (existingPinnedId !== null && existingPinnedId !== commentId) return "conflict";
    }

    const now = new Date().toISOString();
    db.run(
      "UPDATE _issue_comments SET pinned_at = ?, pinned_by = ? WHERE id = ? AND issue_id = ? AND deleted_at IS NULL",
      [pinned ? now : null, pinned ? actorId : null, commentId, issueId],
    );
    if (db.getRowsModified() === 0) return "not_found";
    await insertIssueEvent(dbPath, issueId, actorId, pinned ? "comment_pinned" : "comment_unpinned", { commentId });
    db.run("UPDATE _issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    markDirty(dbPath);
    saveConnection(dbPath);
    return pinned ? "pinned" : "unpinned";
  });
}

export type IssueCommentMinimizedResult = "minimized" | "unminimized" | "unchanged" | "pinned_conflict" | "invalid_reason" | "not_found";

export async function setIssueCommentMinimized(
  dbPath: string,
  issueId: number,
  commentId: number,
  actorId: string,
  reason: IssueCommentMinimizedReason | null,
): Promise<IssueCommentMinimizedResult> {
  await ensureIssueTables(dbPath);
  if (reason !== null && !isIssueCommentMinimizedReason(reason)) return "invalid_reason";
  return runDbTransaction(dbPath, async () => {
    const db = await getConnection(dbPath);
    const comment = await getIssueComment(dbPath, commentId);
    if (!comment || comment.issue_id !== issueId || comment.deleted_at) return "not_found";
    if (reason !== null && comment.pinned_at) return "pinned_conflict";
    if (reason !== null && comment.minimized_at && comment.minimized_reason === reason) return "unchanged";
    if (reason === null && !comment.minimized_at) return "unchanged";

    const now = new Date().toISOString();
    db.run(
      "UPDATE _issue_comments SET minimized_at = ?, minimized_by = ?, minimized_reason = ? WHERE id = ? AND issue_id = ? AND deleted_at IS NULL",
      [reason === null ? null : now, reason === null ? null : actorId, reason, commentId, issueId],
    );
    if (db.getRowsModified() === 0) return "not_found";
    await insertIssueEvent(dbPath, issueId, actorId, reason === null ? "comment_unminimized" : "comment_minimized", {
      commentId,
      ...(reason === null ? {} : { reason }),
    });
    db.run("UPDATE _issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    markDirty(dbPath);
    saveConnection(dbPath);
    return reason === null ? "unminimized" : "minimized";
  });
}

export async function insertIssueRevision(
  dbPath: string,
  input: {
    issueId: number;
    targetType: IssueRevisionTargetType;
    targetId: number;
    editorId: string;
    title?: string | null;
    body: string;
    fields: string[];
  },
): Promise<IssueRevisionRecord> {
  await ensureIssueTables(dbPath);
  const issue = await getIssueById(dbPath, input.issueId);
  if (!issue || (input.targetType === "issue" && input.targetId !== input.issueId)) {
    throw new Error("Issue revision target not found");
  }
  if (input.targetType === "comment") {
    const comment = await getIssueComment(dbPath, input.targetId);
    if (!comment || comment.issue_id !== input.issueId) throw new Error("Issue revision target not found");
  }
  const fields = [...new Set(input.fields)].filter(Boolean);
  if (fields.length === 0) throw new Error("Issue revision fields are required");
  const db = await getConnection(dbPath);
  db.run(
    `INSERT INTO _issue_revisions
      (issue_id, target_type, target_id, editor_id, title, body, fields_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.issueId, input.targetType, input.targetId, input.editorId, input.title ?? null, input.body, JSON.stringify(fields), new Date().toISOString()],
  );
  const id = (db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] as number) ?? 0;
  const stmt = db.prepare("SELECT * FROM _issue_revisions WHERE id = ?");
  stmt.bind([id]);
  const revision = stmt.step() ? stmt.getAsObject() as unknown as IssueRevisionRecord : null;
  stmt.free();
  markDirty(dbPath);
  saveConnection(dbPath);
  return revision!;
}

export async function listIssueRevisions(
  dbPath: string,
  issueId: number,
  targetType: IssueRevisionTargetType,
  targetId: number,
): Promise<IssueRevisionRecord[]> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const stmt = db.prepare(
    `SELECT * FROM _issue_revisions
     WHERE issue_id = ? AND target_type = ? AND target_id = ?
     ORDER BY created_at DESC, id DESC`,
  );
  stmt.bind([issueId, targetType, targetId]);
  const revisions: IssueRevisionRecord[] = [];
  while (stmt.step()) revisions.push(stmt.getAsObject() as unknown as IssueRevisionRecord);
  stmt.free();
  return revisions;
}

export async function deleteIssueComment(
  dbPath: string,
  commentId: number,
  authorId: string,
): Promise<boolean> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const now = new Date().toISOString();
  db.run(
    "UPDATE _issue_comments SET body = '', deleted_at = ?, updated_at = ?, pinned_at = NULL, pinned_by = NULL, minimized_at = NULL, minimized_by = NULL, minimized_reason = NULL WHERE id = ? AND author_id = ? AND deleted_at IS NULL",
    [now, now, commentId, authorId],
  );
  const changed = db.getRowsModified() > 0;
  if (changed) {
    db.run("DELETE FROM _issue_mentions WHERE target_type = 'comment' AND target_id = ?", [commentId]);
    markDirty(dbPath);
    saveConnection(dbPath);
  }
  return changed;
}

export async function deleteIssue(dbPath: string, issueId: number): Promise<IssueAttachmentRecord[] | null> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const issue = await getIssueById(dbPath, issueId);
  if (!issue) return null;
  const attachmentStmt = db.prepare("SELECT * FROM _issue_attachments WHERE issue_id = ? AND deleted_at IS NULL ORDER BY created_at, id");
  attachmentStmt.bind([issueId]);
  const attachments: IssueAttachmentRecord[] = [];
  while (attachmentStmt.step()) attachments.push(attachmentStmt.getAsObject() as unknown as IssueAttachmentRecord);
  attachmentStmt.free();

  db.run("DELETE FROM _issues WHERE id = ?", [issueId]);
  for (const table of [
    "_issue_comments", "_issue_events", "_issue_attachments", "_issue_label_links",
    "_issue_assignees", "_issue_subscriptions", "_issue_mentions", "_issue_reactions", "_issue_revisions",
  ]) db.run(`DELETE FROM ${table} WHERE issue_id = ?`, [issueId]);
  db.run("DELETE FROM _issue_sub_issues WHERE parent_issue_id = ? OR child_issue_id = ?", [issueId, issueId]);
  db.run("DELETE FROM _issue_dependencies WHERE blocked_issue_id = ? OR blocking_issue_id = ?", [issueId, issueId]);
  db.run("DELETE FROM _issue_duplicates WHERE duplicate_issue_id = ? OR canonical_issue_id = ?", [issueId, issueId]);
  db.run("DELETE FROM _issue_cross_references WHERE source_issue_id = ? OR target_issue_id = ?", [issueId, issueId]);
  markDirty(dbPath);
  saveConnection(dbPath);
  return attachments;
}

export async function replaceIssueMentions(
  dbPath: string,
  input: {
    issueId: number;
    targetType: "issue" | "comment";
    targetId: number;
    userIds: string[];
  },
): Promise<void> {
  await ensureIssueTables(dbPath);
  const issue = await getIssueById(dbPath, input.issueId);
  if (!issue || (input.targetType === "issue" && input.targetId !== input.issueId)) throw new Error("Issue mention target not found");
  if (input.targetType === "comment") {
    const comment = await getIssueComment(dbPath, input.targetId);
    if (!comment || comment.issue_id !== input.issueId || comment.deleted_at) throw new Error("Issue mention target not found");
  }
  const userIds = [...new Set(input.userIds.map((userId) => userId.trim()).filter(Boolean))];
  const db = await getConnection(dbPath);
  db.run("DELETE FROM _issue_mentions WHERE target_type = ? AND target_id = ?", [input.targetType, input.targetId]);
  const now = new Date().toISOString();
  for (const userId of userIds) {
    db.run(
      "INSERT INTO _issue_mentions (issue_id, target_type, target_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [input.issueId, input.targetType, input.targetId, userId, now],
    );
  }
  markDirty(dbPath);
  saveConnection(dbPath);
}

export async function setIssueReaction(
  dbPath: string,
  input: {
    issueId: number;
    commentId?: number;
    userId: string;
    content: IssueReactionContent;
    reacted: boolean;
  },
): Promise<"changed" | "unchanged" | "target_not_found"> {
  if (!isIssueReactionContent(input.content)) throw new RangeError("Invalid Issue reaction content");
  const issue = await getIssueById(dbPath, input.issueId);
  if (!issue) return "target_not_found";
  const commentId = input.commentId ?? 0;
  if (commentId !== 0) {
    const comment = await getIssueComment(dbPath, commentId);
    if (!comment || comment.issue_id !== input.issueId || comment.deleted_at !== null) return "target_not_found";
  }
  const db = await getConnection(dbPath);
  if (input.reacted) {
    db.run(
      `INSERT OR IGNORE INTO _issue_reactions (issue_id, comment_id, user_id, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [input.issueId, commentId, input.userId, input.content, new Date().toISOString()],
    );
  } else {
    db.run(
      "DELETE FROM _issue_reactions WHERE issue_id = ? AND comment_id = ? AND user_id = ? AND content = ?",
      [input.issueId, commentId, input.userId, input.content],
    );
  }
  if (db.getRowsModified() === 0) return "unchanged";
  markDirty(dbPath);
  saveConnection(dbPath);
  return "changed";
}

export async function insertIssueEvent(
  dbPath: string,
  issueId: number,
  actorId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<IssueEventRecord> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  db.run(
    "INSERT INTO _issue_events (issue_id, actor_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    [issueId, actorId, eventType, JSON.stringify(payload), new Date().toISOString()],
  );
  const id = (db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] as number) ?? 0;
  const stmt = db.prepare("SELECT * FROM _issue_events WHERE id = ?");
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() as unknown as IssueEventRecord : null;
  stmt.free();
  markDirty(dbPath);
  saveConnection(dbPath);
  return row!;
}

export const MAX_ISSUE_DRAFT_ATTACHMENTS = 20;

export class IssueAttachmentDraftLimitError extends Error {
  constructor() {
    super(`Each Issue draft supports at most ${MAX_ISSUE_DRAFT_ATTACHMENTS} attachments`);
    this.name = "IssueAttachmentDraftLimitError";
  }
}

export async function insertIssueAttachment(
  dbPath: string,
  input: {
    id: string;
    pagePath: string;
    draftId: string;
    uploaderId: string;
    storageKey: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  },
): Promise<IssueAttachmentRecord> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS count FROM _issue_attachments
     WHERE page_path = ? AND draft_id = ? AND uploader_id = ?
       AND issue_id IS NULL AND comment_id IS NULL AND bound_at IS NULL AND deleted_at IS NULL`,
  );
  countStmt.bind([input.pagePath, input.draftId, input.uploaderId]);
  const count = countStmt.step() ? Number(countStmt.getAsObject().count ?? 0) : 0;
  countStmt.free();
  if (count >= MAX_ISSUE_DRAFT_ATTACHMENTS) throw new IssueAttachmentDraftLimitError();
  db.run(
    `INSERT INTO _issue_attachments
      (id, page_path, draft_id, uploader_id, storage_key, file_name, mime_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.pagePath, input.draftId, input.uploaderId, input.storageKey, input.fileName, input.mimeType, input.sizeBytes, new Date().toISOString()],
  );
  markDirty(dbPath);
  saveConnection(dbPath);
  return (await getIssueAttachment(dbPath, input.id))!;
}

export async function getIssueAttachment(dbPath: string, attachmentId: string): Promise<IssueAttachmentRecord | null> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const stmt = db.prepare("SELECT * FROM _issue_attachments WHERE id = ? AND deleted_at IS NULL");
  stmt.bind([attachmentId]);
  const row = stmt.step() ? stmt.getAsObject() as unknown as IssueAttachmentRecord : null;
  stmt.free();
  return row;
}

export async function listExpiredUnboundIssueAttachments(
  dbPath: string,
  createdBefore: string,
): Promise<IssueAttachmentRecord[]> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const stmt = db.prepare(
    `SELECT * FROM _issue_attachments
     WHERE issue_id IS NULL AND bound_at IS NULL AND deleted_at IS NULL AND created_at < ?
     ORDER BY created_at, id`,
  );
  stmt.bind([createdBefore]);
  const attachments: IssueAttachmentRecord[] = [];
  while (stmt.step()) attachments.push(stmt.getAsObject() as unknown as IssueAttachmentRecord);
  stmt.free();
  return attachments;
}

export async function deleteIssueAttachmentMetadata(dbPath: string, attachmentId: string): Promise<boolean> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  db.run(
    "UPDATE _issue_attachments SET deleted_at = ? WHERE id = ? AND issue_id IS NULL AND deleted_at IS NULL",
    [new Date().toISOString(), attachmentId],
  );
  const changed = db.getRowsModified() > 0;
  if (changed) {
    markDirty(dbPath);
    saveConnection(dbPath);
  }
  return changed;
}

export async function releaseUnboundIssueAttachment(
  dbPath: string,
  input: { attachmentId: string; pagePath: string; draftId: string; uploaderId: string },
): Promise<IssueAttachmentRecord | null> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const stmt = db.prepare(
    `SELECT * FROM _issue_attachments
     WHERE id = ? AND page_path = ? AND draft_id = ? AND uploader_id = ?
       AND issue_id IS NULL AND comment_id IS NULL AND bound_at IS NULL AND deleted_at IS NULL`,
  );
  stmt.bind([input.attachmentId, input.pagePath, input.draftId, input.uploaderId]);
  const attachment = stmt.step() ? stmt.getAsObject() as unknown as IssueAttachmentRecord : null;
  stmt.free();
  if (!attachment) return null;
  const deletedAt = new Date().toISOString();
  db.run(
    `UPDATE _issue_attachments SET deleted_at = ?
     WHERE id = ? AND page_path = ? AND draft_id = ? AND uploader_id = ?
       AND issue_id IS NULL AND comment_id IS NULL AND bound_at IS NULL AND deleted_at IS NULL`,
    [deletedAt, input.attachmentId, input.pagePath, input.draftId, input.uploaderId],
  );
  if (db.getRowsModified() === 0) return null;
  markDirty(dbPath);
  saveConnection(dbPath);
  return { ...attachment, deleted_at: deletedAt };
}

export async function restoreReleasedIssueAttachment(
  dbPath: string,
  input: { attachmentId: string; pagePath: string; draftId: string; uploaderId: string; releaseDeletedAt: string },
): Promise<boolean> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  db.run(
    `UPDATE _issue_attachments SET deleted_at = NULL
     WHERE id = ? AND page_path = ? AND draft_id = ? AND uploader_id = ? AND deleted_at = ?
       AND issue_id IS NULL AND comment_id IS NULL AND bound_at IS NULL`,
    [input.attachmentId, input.pagePath, input.draftId, input.uploaderId, input.releaseDeletedAt],
  );
  const changed = db.getRowsModified() > 0;
  if (changed) {
    markDirty(dbPath);
    saveConnection(dbPath);
  }
  return changed;
}

export async function deleteBoundIssueAttachments(
  dbPath: string,
  input: { attachmentIds: string[]; issueId: number; commentId: number | null },
): Promise<boolean> {
  const attachmentIds = Array.from(new Set(input.attachmentIds));
  if (attachmentIds.length === 0) return true;
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const deletedAt = new Date().toISOString();
  let changed = 0;
  for (const attachmentId of attachmentIds) {
    db.run(
      "UPDATE _issue_attachments SET deleted_at = ? WHERE id = ? AND issue_id = ? AND comment_id IS ? AND deleted_at IS NULL",
      [deletedAt, attachmentId, input.issueId, input.commentId],
    );
    changed += db.getRowsModified();
  }
  if (changed > 0) {
    markDirty(dbPath);
    saveConnection(dbPath);
  }
  return changed === attachmentIds.length;
}

export async function bindIssueAttachments(
  dbPath: string,
  input: {
    attachmentIds: string[];
    draftId: string;
    uploaderId: string;
    issueId: number;
    commentId?: number;
    pagePath?: string;
  },
): Promise<IssueAttachmentRecord[]> {
  if (input.attachmentIds.length === 0) return [];
  const attachmentIds = [...new Set(input.attachmentIds)];
  if (attachmentIds.length !== input.attachmentIds.length) return [];
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  const placeholders = attachmentIds.map(() => "?").join(", ");
  const pagePathCondition = input.pagePath === undefined ? "" : " AND page_path = ?";
  const eligibleStmt = db.prepare(
    `SELECT id FROM _issue_attachments
     WHERE id IN (${placeholders}) AND draft_id = ? AND uploader_id = ?${pagePathCondition} AND issue_id IS NULL AND deleted_at IS NULL`,
  );
  eligibleStmt.bind([...attachmentIds, input.draftId, input.uploaderId, ...(input.pagePath === undefined ? [] : [input.pagePath])]);
  const eligibleIds: string[] = [];
  while (eligibleStmt.step()) eligibleIds.push(String(eligibleStmt.getAsObject().id));
  eligibleStmt.free();
  if (eligibleIds.length !== attachmentIds.length) return [];

  const now = new Date().toISOString();
  db.run(
    `UPDATE _issue_attachments SET issue_id = ?, comment_id = ?, bound_at = ?
     WHERE id IN (${placeholders}) AND draft_id = ? AND uploader_id = ?${pagePathCondition} AND issue_id IS NULL AND deleted_at IS NULL`,
    [input.issueId, input.commentId ?? null, now, ...attachmentIds, input.draftId, input.uploaderId, ...(input.pagePath === undefined ? [] : [input.pagePath])],
  );
  markDirty(dbPath);
  saveConnection(dbPath);
  const bound: IssueAttachmentRecord[] = [];
  for (const attachmentId of attachmentIds) {
    const attachment = await getIssueAttachment(dbPath, attachmentId);
    if (attachment?.issue_id === input.issueId && attachment.uploader_id === input.uploaderId) bound.push(attachment);
  }
  return bound;
}

export async function getIssueDetail(dbPath: string, issueId: number): Promise<IssueDetail | null> {
  const issue = await getIssueById(dbPath, issueId);
  if (!issue) return null;
  const db = await getConnection(dbPath);
  const issueRevisionStmt = db.prepare(
    "SELECT COUNT(*) AS revision_count FROM _issue_revisions WHERE issue_id = ? AND target_type = 'issue' AND target_id = ?",
  );
  issueRevisionStmt.bind([issueId, issueId]);
  issue.revision_count = issueRevisionStmt.step() ? Number(issueRevisionStmt.getAsObject().revision_count ?? 0) : 0;
  issueRevisionStmt.free();
  const comments: IssueCommentRecord[] = [];
  const commentStmt = db.prepare(`
    SELECT c.*, (
      SELECT COUNT(*) FROM _issue_revisions r
      WHERE r.issue_id = c.issue_id AND r.target_type = 'comment' AND r.target_id = c.id
    ) AS revision_count
    FROM _issue_comments c WHERE c.issue_id = ? ORDER BY c.created_at, c.id`);
  commentStmt.bind([issueId]);
  while (commentStmt.step()) comments.push(commentStmt.getAsObject() as unknown as IssueCommentRecord);
  commentStmt.free();

  const events: IssueEventRecord[] = [];
  const eventStmt = db.prepare("SELECT * FROM _issue_events WHERE issue_id = ? ORDER BY created_at, id");
  eventStmt.bind([issueId]);
  while (eventStmt.step()) events.push(eventStmt.getAsObject() as unknown as IssueEventRecord);
  eventStmt.free();

  const crossReferences: IssueCrossReferenceRecord[] = [];
  const crossReferenceStmt = db.prepare(`
    SELECT relation.id, relation.target_issue_id, relation.source_issue_id,
      source.issue_number AS source_issue_number, source.title AS source_issue_title,
      source.status AS source_issue_status, relation.source_type, relation.source_id,
      CASE WHEN relation.source_type = 'comment' THEN relation.source_id ELSE NULL END AS source_comment_id,
      relation.actor_id,
      CASE WHEN relation.source_type = 'comment' THEN comment.body ELSE source.description END AS source_markdown,
      relation.created_at, relation.updated_at
    FROM _issue_cross_references relation
    INNER JOIN _issues source ON source.id = relation.source_issue_id
    LEFT JOIN _issue_comments comment
      ON relation.source_type = 'comment' AND comment.id = relation.source_id AND comment.deleted_at IS NULL
    WHERE relation.target_issue_id = ?
      AND (relation.source_type = 'issue' OR comment.id IS NOT NULL)
    ORDER BY relation.created_at, relation.id`);
  crossReferenceStmt.bind([issueId]);
  while (crossReferenceStmt.step()) {
    const row = crossReferenceStmt.getAsObject() as Record<string, SqlValue>;
    const sourceMarkdown = String(row.source_markdown ?? "").replace(/\s+/g, " ").trim();
    crossReferences.push({
      id: Number(row.id),
      target_issue_id: Number(row.target_issue_id),
      source_issue_id: Number(row.source_issue_id),
      source_issue_number: Number(row.source_issue_number),
      source_issue_title: String(row.source_issue_title),
      source_issue_status: String(row.source_issue_status),
      source_type: row.source_type as "issue" | "comment",
      source_id: Number(row.source_id),
      source_comment_id: row.source_comment_id === null ? null : Number(row.source_comment_id),
      actor_id: String(row.actor_id),
      excerpt: Array.from(sourceMarkdown).slice(0, 180).join(""),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    });
  }
  crossReferenceStmt.free();

  const attachments: IssueAttachmentRecord[] = [];
  const attachmentStmt = db.prepare(
    "SELECT * FROM _issue_attachments WHERE issue_id = ? AND deleted_at IS NULL ORDER BY created_at, id",
  );
  attachmentStmt.bind([issueId]);
  while (attachmentStmt.step()) attachments.push(attachmentStmt.getAsObject() as unknown as IssueAttachmentRecord);
  attachmentStmt.free();

  const reactions: IssueReactionRecord[] = [];
  const reactionStmt = db.prepare(
    `SELECT r.* FROM _issue_reactions r
     LEFT JOIN _issue_comments c ON c.id = r.comment_id
     WHERE r.issue_id = ? AND (r.comment_id = 0 OR (c.issue_id = ? AND c.deleted_at IS NULL))
     ORDER BY r.comment_id, r.content, r.user_id`,
  );
  reactionStmt.bind([issueId, issueId]);
  while (reactionStmt.step()) reactions.push(reactionStmt.getAsObject() as unknown as IssueReactionRecord);
  reactionStmt.free();

  const parentStmt = db.prepare(`
    SELECT i.* FROM _issue_sub_issues relation
    INNER JOIN _issues i ON i.id = relation.parent_issue_id
    WHERE relation.child_issue_id = ?`);
  parentStmt.bind([issueId]);
  const parent = parentStmt.step() ? parentStmt.getAsObject() as unknown as IssueRecord : null;
  parentStmt.free();

  const { items: subIssues, summary: subIssueSummary } = await listIssueSubIssues(dbPath, issueId);

  const readDependencyItems = (column: "blocked_issue_id" | "blocking_issue_id", targetColumn: "blocked_issue_id" | "blocking_issue_id"): IssueDependencyItem[] => {
    const items: IssueDependencyItem[] = [];
    const statement = db.prepare(`
      SELECT i.*, relation.added_by, relation.created_at AS relation_created_at
      FROM _issue_dependencies relation
      INNER JOIN _issues i ON i.id = relation.${targetColumn}
      WHERE relation.${column} = ?
      ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, i.issue_number`);
    statement.bind([issueId]);
    while (statement.step()) {
      const item = statement.getAsObject() as unknown as IssueDependencyItem;
      const assigneeStmt = db.prepare("SELECT user_id FROM _issue_assignees WHERE issue_id = ? ORDER BY user_id");
      assigneeStmt.bind([item.id]);
      item.assignee_ids = [];
      while (assigneeStmt.step()) item.assignee_ids.push(String(assigneeStmt.getAsObject().user_id));
      assigneeStmt.free();
      items.push(item);
    }
    statement.free();
    return items;
  };
  const blockedBy = readDependencyItems("blocked_issue_id", "blocking_issue_id");
  const blocking = readDependencyItems("blocking_issue_id", "blocked_issue_id");
  const unresolvedBlockers = blockedBy.filter((item) => item.status === "open").length;
  const dependencySummary: IssueDependencySummary = {
    blockedBy: blockedBy.length,
    blocking: blocking.length,
    unresolvedBlockers,
    isBlocked: unresolvedBlockers > 0,
  };

  const duplicateOfStmt = db.prepare(`
    SELECT i.*, relation.marked_by, relation.comment_id, relation.created_at AS relation_created_at
    FROM _issue_duplicates relation
    INNER JOIN _issues i ON i.id = relation.canonical_issue_id
    WHERE relation.duplicate_issue_id = ?`);
  duplicateOfStmt.bind([issueId]);
  const duplicateOf = duplicateOfStmt.step() ? duplicateOfStmt.getAsObject() as unknown as IssueDuplicateItem : null;
  duplicateOfStmt.free();
  const duplicates: IssueDuplicateItem[] = [];
  const duplicatesStmt = db.prepare(`
    SELECT i.*, relation.marked_by, relation.comment_id, relation.created_at AS relation_created_at
    FROM _issue_duplicates relation
    INNER JOIN _issues i ON i.id = relation.duplicate_issue_id
    WHERE relation.canonical_issue_id = ? ORDER BY i.issue_number`);
  duplicatesStmt.bind([issueId]);
  while (duplicatesStmt.step()) duplicates.push(duplicatesStmt.getAsObject() as unknown as IssueDuplicateItem);
  duplicatesStmt.free();

  const timeline: IssueTimelineItem[] = [
    ...comments.map((comment) => ({ kind: "comment" as const, comment })),
    ...events.map((event) => ({ kind: "event" as const, event })),
    ...crossReferences.map((crossReference) => ({ kind: "cross_reference" as const, crossReference })),
  ].sort((left, right) => {
    const leftTime = left.kind === "comment" ? left.comment.created_at : left.kind === "event" ? left.event.created_at : left.crossReference.created_at;
    const rightTime = right.kind === "comment" ? right.comment.created_at : right.kind === "event" ? right.event.created_at : right.crossReference.created_at;
    const byTime = leftTime.localeCompare(rightTime);
    if (byTime !== 0) return byTime;
    if (left.kind !== right.kind) {
      const rank = { comment: 0, event: 1, cross_reference: 2 } as const;
      return rank[left.kind] - rank[right.kind];
    }
    const leftId = left.kind === "comment" ? left.comment.id : left.kind === "event" ? left.event.id : left.crossReference.id;
    const rightId = right.kind === "comment" ? right.comment.id : right.kind === "event" ? right.event.id : right.crossReference.id;
    return leftId - rightId;
  });

  const collaboration = await getIssueCollaborationMetadata(dbPath, issueId);
  return { issue, timeline, attachments, collaboration, reactions, parent, subIssues, subIssueSummary, blockedBy, blocking, dependencySummary, duplicateOf, duplicates };
}

export async function getIssueDetailByNumber(dbPath: string, issueNumber: number): Promise<IssueDetail | null> {
  const issue = await getIssueByNumber(dbPath, issueNumber);
  return issue ? getIssueDetail(dbPath, issue.id) : null;
}
