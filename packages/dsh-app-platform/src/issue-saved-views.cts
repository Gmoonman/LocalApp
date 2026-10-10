import { ensureIssueTables, getConnection, runDbTransaction } from "./app-db.cjs";

export const MAX_ISSUE_SAVED_VIEWS = 25;

export interface IssueSavedViewQuery {
  q?: string;
  searchIn?: Array<"title" | "body" | "comments">;
  status?: "open" | "closed";
  label?: string;
  author?: string;
  participant?: string;
  assignee?: string;
  milestone?: string;
  reason?: "completed" | "not_planned";
  subscribed?: boolean;
  mentioned?: boolean;
  locked?: "locked" | "unlocked";
  sort?: "activity" | "created" | "updated" | "comments";
  direction?: "asc" | "desc";
  limit?: number;
  offset: 0;
}

export interface IssueSavedViewRecord {
  id: number;
  user_id: string;
  name: string;
  description: string;
  query: IssueSavedViewQuery;
  created_at: string;
  updated_at: string;
}

export interface IssueSavedViewInput {
  name: string;
  description?: string;
  query: unknown;
}

export class IssueSavedViewLimitError extends Error {
  constructor() {
    super(`Each user can save at most ${MAX_ISSUE_SAVED_VIEWS} Issue views per application`);
    this.name = "IssueSavedViewLimitError";
  }
}

const QUERY_FIELDS = new Set(["q", "searchIn", "status", "label", "author", "participant", "assignee", "milestone", "reason", "subscribed", "mentioned", "locked", "sort", "direction", "limit", "offset"]);
const SEARCH_SCOPES = ["title", "body", "comments"] as const;
const TEXT_LIMITS: Record<string, number> = { q: 200, label: 100, author: 100, participant: 100, assignee: 100, milestone: 100 };

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validateText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`Invalid saved view ${field}`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (codePointLength(normalized) > max) throw new RangeError(`Invalid saved view ${field}`);
  return normalized;
}

export function normalizeIssueSavedViewQuery(input: unknown): IssueSavedViewQuery {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid saved view query");
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).find((field) => !QUERY_FIELDS.has(field));
  if (unknown) throw new TypeError(`Unknown saved view query field: ${unknown}`);
  const query: IssueSavedViewQuery = { offset: 0 };
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    const value = validateText(raw[field], field, max);
    if (value !== undefined) (query as unknown as Record<string, unknown>)[field] = value;
  }
  if (raw.searchIn !== undefined) {
    const searchIn = raw.searchIn;
    if (!Array.isArray(searchIn) || searchIn.length === 0 || searchIn.some((scope, index) => !SEARCH_SCOPES.includes(scope) || searchIn.indexOf(scope) !== index)) {
      throw new TypeError("Invalid saved view search scopes");
    }
    const requested = searchIn as unknown[];
    const canonical = SEARCH_SCOPES.filter((scope) => requested.includes(scope));
    if (canonical.length !== requested.length || canonical.some((scope, index) => requested[index] !== scope)) throw new TypeError("Invalid saved view search scopes");
    query.searchIn = canonical;
  }
  const enums: Array<[keyof IssueSavedViewQuery, readonly unknown[]]> = [
    ["status", ["open", "closed"]], ["reason", ["completed", "not_planned"]],
    ["locked", ["locked", "unlocked"]], ["sort", ["activity", "created", "updated", "comments"]],
    ["direction", ["asc", "desc"]],
  ];
  for (const [field, values] of enums) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!values.includes(value)) throw new TypeError(`Invalid saved view ${field}`);
    (query as unknown as Record<string, unknown>)[field] = value;
  }
  for (const field of ["subscribed", "mentioned"] as const) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "boolean") throw new TypeError(`Invalid saved view ${field}`);
    query[field] = raw[field];
  }
  if (raw.limit !== undefined) {
    if (!Number.isSafeInteger(raw.limit) || Number(raw.limit) < 1 || Number(raw.limit) > 100) throw new RangeError("Invalid saved view limit");
    query.limit = Number(raw.limit);
  }
  return query;
}

function normalizeInput(input: IssueSavedViewInput): { name: string; description: string; query: IssueSavedViewQuery } {
  if (!input || typeof input !== "object") throw new TypeError("Invalid saved view");
  if (typeof input.name !== "string" || !input.name.trim()) throw new TypeError("Saved view name is required");
  const name = input.name.trim();
  if (codePointLength(name) > 50) throw new RangeError("Saved view name is too long");
  if (input.description !== undefined && typeof input.description !== "string") throw new TypeError("Invalid saved view description");
  const description = input.description?.trim() ?? "";
  if (codePointLength(description) > 200) throw new RangeError("Saved view description is too long");
  return { name, description, query: normalizeIssueSavedViewQuery(input.query) };
}

function rowToSavedView(row: Record<string, unknown>): IssueSavedViewRecord {
  return {
    id: Number(row.id), user_id: String(row.user_id), name: String(row.name), description: String(row.description),
    query: normalizeIssueSavedViewQuery(JSON.parse(String(row.query_json))), created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

function readRows(db: Awaited<ReturnType<typeof getConnection>>, sql: string, params: unknown[]): IssueSavedViewRecord[] {
  const statement = db.prepare(sql);
  statement.bind(params as never[]);
  const rows: IssueSavedViewRecord[] = [];
  while (statement.step()) rows.push(rowToSavedView(statement.getAsObject()));
  statement.free();
  return rows;
}

function isUniqueNameError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: _issue_saved_views\.user_id, _issue_saved_views\.name/.test(error.message);
}

export async function listIssueSavedViews(dbPath: string, userId: string): Promise<IssueSavedViewRecord[]> {
  await ensureIssueTables(dbPath);
  const db = await getConnection(dbPath);
  return readRows(db, "SELECT * FROM _issue_saved_views WHERE user_id = ? ORDER BY id", [userId]);
}

async function assertCapacity(db: Awaited<ReturnType<typeof getConnection>>, userId: string): Promise<void> {
  const statement = db.prepare("SELECT COUNT(*) AS count FROM _issue_saved_views WHERE user_id = ?");
  statement.bind([userId]);
  const count = statement.step() ? Number(statement.getAsObject().count) : 0;
  statement.free();
  if (count >= MAX_ISSUE_SAVED_VIEWS) throw new IssueSavedViewLimitError();
}

export async function createIssueSavedView(dbPath: string, userId: string, input: IssueSavedViewInput): Promise<IssueSavedViewRecord> {
  const normalized = normalizeInput(input);
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    const db = await getConnection(dbPath);
    await assertCapacity(db, userId);
    const now = new Date().toISOString();
    try { db.run("INSERT INTO _issue_saved_views (user_id, name, description, query_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [userId, normalized.name, normalized.description, JSON.stringify(normalized.query), now, now]); }
    catch (error) { if (isUniqueNameError(error)) throw new Error("Saved view name already exists"); throw error; }
    return readRows(db, "SELECT * FROM _issue_saved_views WHERE id = last_insert_rowid()", [])[0];
  });
}

export async function updateIssueSavedView(dbPath: string, userId: string, id: number, input: Partial<IssueSavedViewInput>): Promise<IssueSavedViewRecord | null> {
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    const db = await getConnection(dbPath);
    const current = readRows(db, "SELECT * FROM _issue_saved_views WHERE id = ? AND user_id = ?", [id, userId])[0];
    if (!current) return null;
    const normalized = normalizeInput({ name: input.name ?? current.name, description: input.description ?? current.description, query: input.query ?? current.query });
    try { db.run("UPDATE _issue_saved_views SET name = ?, description = ?, query_json = ?, updated_at = ? WHERE id = ? AND user_id = ?", [normalized.name, normalized.description, JSON.stringify(normalized.query), new Date().toISOString(), id, userId]); }
    catch (error) { if (isUniqueNameError(error)) throw new Error("Saved view name already exists"); throw error; }
    return readRows(db, "SELECT * FROM _issue_saved_views WHERE id = ? AND user_id = ?", [id, userId])[0] ?? null;
  });
}

export async function duplicateIssueSavedView(dbPath: string, userId: string, id: number): Promise<IssueSavedViewRecord | null> {
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    const db = await getConnection(dbPath);
    const current = readRows(db, "SELECT * FROM _issue_saved_views WHERE id = ? AND user_id = ?", [id, userId])[0];
    if (!current) return null;
    await assertCapacity(db, userId);
    let name = `${current.name} copy`;
    let suffix = 2;
    const existing = new Set(readRows(db, "SELECT * FROM _issue_saved_views WHERE user_id = ?", [userId]).map((view) => view.name));
    while (existing.has(name)) name = `${current.name} copy ${suffix++}`;
    if (codePointLength(name) > 50) name = `${Array.from(current.name).slice(0, 43).join("")} copy`;
    const now = new Date().toISOString();
    db.run("INSERT INTO _issue_saved_views (user_id, name, description, query_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [userId, name, current.description, JSON.stringify(current.query), now, now]);
    return readRows(db, "SELECT * FROM _issue_saved_views WHERE id = last_insert_rowid()", [])[0];
  });
}

export async function deleteIssueSavedView(dbPath: string, userId: string, id: number): Promise<boolean> {
  await ensureIssueTables(dbPath);
  return runDbTransaction(dbPath, async () => {
    const db = await getConnection(dbPath);
    const exists = readRows(db, "SELECT * FROM _issue_saved_views WHERE id = ? AND user_id = ?", [id, userId]).length > 0;
    if (exists) db.run("DELETE FROM _issue_saved_views WHERE id = ? AND user_id = ?", [id, userId]);
    return exists;
  });
}
