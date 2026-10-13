import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "sql.js";
import { canonicalizeDeviceActionPermissions, deviceActionPermissionsDigest, type DeviceActionPermissionSet } from "@localapp/dsh-device-services/device-action-types";


export const DESKTOP_ACTION_SCRIPT_MAX_BYTES = 256 * 1024;

export const DESKTOP_ACTION_INPUT_MAX_BYTES = 1024 * 1024;

export const DESKTOP_ACTION_RESULT_MAX_BYTES = 1024 * 1024;

export const DESKTOP_ACTION_ERROR_MAX_BYTES = 64 * 1024;

export const DESKTOP_ACTION_ERROR_CODE_MAX_BYTES = 256;

export const DESKTOP_ACTION_MAX_DEPENDENCIES = 64;

export const DESKTOP_ACTION_PENDING_TTL_MS = 10 * 60 * 1000;

export const DESKTOP_ACTION_DEFAULT_TIMEOUT_SECONDS = 300;

export const DESKTOP_ACTION_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const DESKTOP_ACTION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;


export type DesktopActionStatus =
  | "pending"
  | "claimed"
  | "awaiting_trust"
  | "preparing"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "interrupted";


export type DesktopActionTerminalStatus = Extract<
  DesktopActionStatus,
  "succeeded" | "failed" | "cancelled" | "expired" | "interrupted"
>;


export interface CreateDesktopActionInput {
  userId: string;
  serverOrigin: string;
  appOwner: string;
  appName: string;
  appVersion?: string | null;
  publisherUserId: string;
  publisherDisplayName?: string | null;
  title: string;
  description?: string | null;
  script: string;
  dependencies?: Record<string, string>;
  input?: unknown;
  timeoutSeconds?: number;
  permissions?: DeviceActionPermissionSet;
}


export interface DesktopActionError {
  message: string;
  code?: string;
}


export interface DesktopActionRecord {
  id: string;
  userId: string;
  serverOrigin: string;
  appOwner: string;
  appName: string;
  appVersion: string | null;
  publisherUserId: string;
  publisherDisplayName: string | null;
  title: string;
  description: string | null;
  script: string;
  dependencies: Record<string, string>;
  input: unknown;
  timeoutSeconds: number;
  permissions: DeviceActionPermissionSet;
  permissionsDigest: string;
  nonce: string;
  installationId: string | null;
  status: DesktopActionStatus;
  result: unknown;
  error: DesktopActionError | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}


export type DesktopActionSnapshot = Omit<
  DesktopActionRecord,
  "script" | "dependencies" | "input" | "nonce" | "installationId"
>;


export type RecoverableDesktopAction = Omit<DesktopActionRecord, "nonce" | "installationId">;


export interface PendingDesktopAction {
  id: string;
  nonce: string;
  serverOrigin: string;
  appOwner: string;
  appName: string;
  appVersion: string | null;
  publisherUserId: string;
  publisherDisplayName: string | null;
  title: string;
  description: string | null;
  createdAt: string;
  expiresAt: string;
  permissions: DeviceActionPermissionSet;
  permissionsDigest: string;
}


type DesktopActionRow = Record<string, unknown>;


export type ClaimDesktopActionResult =
  | { outcome: "claimed"; action: DesktopActionRecord; idempotent: boolean }
  | { outcome: "conflict" | "expired" | "invalid_nonce" | "not_found" };


export type ClaimDeviceActionResult =
  | { outcome: "claimed"; action: DesktopActionRecord; idempotent: boolean }
  | { outcome: "conflict" | "expired" | "invalid_nonce" | "not_found" };


export interface TransitionDesktopActionInput {
  userId: string;
  id: string;
  installationId: string;
  status: DesktopActionStatus;
  result?: unknown;
  error?: DesktopActionError | null;
}


export type TransitionDesktopActionResult =
  | { outcome: "updated"; action: DesktopActionSnapshot; changed: boolean }
  | { outcome: "invalid_transition" | "terminal_conflict" | "not_found" };

export interface DeviceActionPersistence { database(): Database; flush(): void; }
export function createDeviceActionStore(host: DeviceActionPersistence) {
  const getDb = host.database;
  const flushMetaDb = host.flush;


const TERMINAL_STATUSES = new Set<DesktopActionStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "interrupted",
]);


const ALLOWED_TRANSITIONS: Record<DesktopActionStatus, ReadonlySet<DesktopActionStatus>> = {
  pending: new Set(["expired"]),
  claimed: new Set(["awaiting_trust", "preparing", "cancelled"]),
  awaiting_trust: new Set(["preparing", "cancelled"]),
  preparing: new Set(["running", "failed", "cancelled", "interrupted"]),
  running: new Set(["succeeded", "failed", "cancelled", "interrupted"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
  interrupted: new Set(),
};


function fail(code: string): never {
  throw new Error(code);
}


function jsonStringify(value: unknown, errorCode: string): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    fail(errorCode);
  }
  if (json === undefined) fail(errorCode);
  return json;
}


function boundedJson(value: unknown, maxBytes: number, tooLargeCode: string, invalidCode: string): string {
  const json = jsonStringify(value, invalidCode);
  if (Buffer.byteLength(json, "utf8") > maxBytes) fail(tooLargeCode);
  return json;
}


function isLegalPackageName(name: string): boolean {
  if (name.length === 0 || name.length > 214 || name !== name.toLowerCase()) return false;
  const segment = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
  return new RegExp(`^(?:${segment}|@${segment}/${segment})$`).test(name);
}


function isExactSemver(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match) return false;
  const prerelease = match[4];
  return !prerelease || prerelease.split(".").every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0"));
}


function validateDependencies(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("DESKTOP_ACTION_INVALID_DEPENDENCIES");
  const entries = Object.entries(value);
  if (entries.length > DESKTOP_ACTION_MAX_DEPENDENCIES) fail("DESKTOP_ACTION_TOO_MANY_DEPENDENCIES");
  for (const [name, version] of entries) {
    if (!isLegalPackageName(name) || typeof version !== "string" || !isExactSemver(version)) {
      fail("DESKTOP_ACTION_INVALID_DEPENDENCY");
    }
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}


function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // A UTF-8 code point straddles the byte boundary.
    }
  }
  return "";
}


function boundDesktopActionError(error: DesktopActionError): DesktopActionError {
  const code = error.code === undefined
    ? undefined
    : truncateUtf8(error.code, DESKTOP_ACTION_ERROR_CODE_MAX_BYTES);
  const build = (message: string): DesktopActionError => ({
    message,
    ...(code === undefined ? {} : { code }),
  });
  if (Buffer.byteLength(JSON.stringify(build(error.message)), "utf8") <= DESKTOP_ACTION_ERROR_MAX_BYTES) {
    return build(error.message);
  }

  const codePoints = Array.from(error.message);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const candidate = build(codePoints.slice(0, midpoint).join(""));
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= DESKTOP_ACTION_ERROR_MAX_BYTES) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return build(codePoints.slice(0, low).join(""));
}


function actionFromRow(row: DesktopActionRow): DesktopActionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    serverOrigin: String(row.server_origin),
    appOwner: String(row.app_owner),
    appName: String(row.app_name),
    appVersion: row.app_version === null ? null : String(row.app_version),
    publisherUserId: String(row.publisher_user_id),
    publisherDisplayName: row.publisher_display_name === null ? null : String(row.publisher_display_name),
    title: String(row.title),
    description: row.description === null ? null : String(row.description),
    script: String(row.script),
    dependencies: JSON.parse(String(row.dependencies_json)) as Record<string, string>,
    input: JSON.parse(String(row.input_json)) as unknown,
    timeoutSeconds: Number(row.timeout_seconds),
    permissions: canonicalizeDeviceActionPermissions(JSON.parse(String(row.permissions_json ?? "{}"))),
    permissionsDigest: String(row.permissions_digest ?? ""),
    nonce: String(row.nonce),
    installationId: row.installation_id === null ? null : String(row.installation_id),
    status: String(row.status) as DesktopActionStatus,
    result: row.result_json === null ? null : JSON.parse(String(row.result_json)),
    error: row.error_message === null
      ? null
      : { message: String(row.error_message), ...(row.error_code === null ? {} : { code: String(row.error_code) }) },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at),
    claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}


function selectAction(userId: string, id: string): DesktopActionRecord | null {
  const stmt = getDb().prepare("SELECT * FROM desktop_actions WHERE id = ? AND user_id = ?");
  stmt.bind([id, userId]);
  const action = stmt.step() ? actionFromRow(stmt.getAsObject()) : null;
  stmt.free();
  return action;
}


function selectActionById(id: string): DesktopActionRecord | null {
  const stmt = getDb().prepare("SELECT * FROM desktop_actions WHERE id = ?");
  stmt.bind([id]);
  const action = stmt.step() ? actionFromRow(stmt.getAsObject()) : null;
  stmt.free();
  return action;
}


function toSnapshot(action: DesktopActionRecord): DesktopActionSnapshot {
  const { script: _script, dependencies: _dependencies, input: _input, nonce: _nonce, installationId: _installationId, ...snapshot } = action;
  return snapshot;
}


function toRecoverableAction(action: DesktopActionRecord): RecoverableDesktopAction {
  const { nonce: _nonce, installationId: _installationId, ...recoverable } = action;
  return recoverable;
}


function createDesktopAction(input: CreateDesktopActionInput, now = new Date()): DesktopActionRecord {
  if (typeof input.script !== "string") fail("DESKTOP_ACTION_INVALID_SCRIPT");
  if (Buffer.byteLength(input.script, "utf8") > DESKTOP_ACTION_SCRIPT_MAX_BYTES) fail("DESKTOP_ACTION_SCRIPT_TOO_LARGE");
  const dependencies = validateDependencies(input.dependencies);
  const dependenciesJson = jsonStringify(dependencies, "DESKTOP_ACTION_INVALID_DEPENDENCIES");
  const inputJson = boundedJson(input.input ?? null, DESKTOP_ACTION_INPUT_MAX_BYTES, "DESKTOP_ACTION_INPUT_TOO_LARGE", "DESKTOP_ACTION_INVALID_INPUT");
  let permissions: DeviceActionPermissionSet = {};
  if (input.permissions !== undefined) {
    try {
      permissions = canonicalizeDeviceActionPermissions(input.permissions);
    } catch (error) {
      const code = error instanceof Error ? error.message : "DEVICE_ACTION_INVALID_PERMISSIONS";
      fail(code.replace(/^DEVICE_ACTION_/, "DESKTOP_ACTION_"));
    }
  }
  const permissionsJson = jsonStringify(permissions, "DESKTOP_ACTION_INVALID_PERMISSIONS");
  const permissionsDigest = deviceActionPermissionsDigest(permissions);
  const timeoutSeconds = input.timeoutSeconds ?? DESKTOP_ACTION_DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) fail("DESKTOP_ACTION_INVALID_TIMEOUT");

  const id = randomUUID();
  const nonce = randomBytes(32).toString("base64url");
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + DESKTOP_ACTION_PENDING_TTL_MS).toISOString();
  getDb().run(`
    INSERT INTO desktop_actions (
      id, user_id, server_origin, app_owner, app_name, app_version,
      publisher_user_id, publisher_display_name, title, description, script,
      dependencies_json, input_json, timeout_seconds, nonce, status,
      created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `, [
    id, input.userId, input.serverOrigin, input.appOwner, input.appName, input.appVersion ?? null,
    input.publisherUserId, input.publisherDisplayName ?? null, input.title, input.description ?? null,
    input.script, dependenciesJson, inputJson, timeoutSeconds, nonce, createdAt, createdAt, expiresAt,
  ]);
  getDb().run(
    "UPDATE desktop_actions SET permissions_json = ?, permissions_digest = ? WHERE id = ?",
    [permissionsJson, permissionsDigest, id],
  );
  flushMetaDb();
  return selectAction(input.userId, id)!;
}


function expirePendingDesktopActions(now = new Date()): number {
  const timestamp = now.toISOString();
  const database = getDb();
  database.run(`
    UPDATE desktop_actions
    SET status = 'expired', updated_at = ?, completed_at = ?
    WHERE status = 'pending' AND expires_at <= ?
  `, [timestamp, timestamp, timestamp]);
  const count = database.getRowsModified();
  if (count > 0) flushMetaDb();
  return count;
}


function getDesktopActionSnapshot(userId: string, id: string, now = new Date()): DesktopActionSnapshot | null {
  expirePendingDesktopActions(now);
  const action = selectAction(userId, id);
  return action ? toSnapshot(action) : null;
}


function listPendingDesktopActions(userId: string, now = new Date()): PendingDesktopAction[] {
  expirePendingDesktopActions(now);
  const stmt = getDb().prepare("SELECT * FROM desktop_actions WHERE user_id = ? AND status = 'pending' ORDER BY created_at ASC, id ASC");
  stmt.bind([userId]);
  const pending: PendingDesktopAction[] = [];
  while (stmt.step()) {
    const action = actionFromRow(stmt.getAsObject());
    pending.push({
      id: action.id,
      nonce: action.nonce,
      serverOrigin: action.serverOrigin,
      appOwner: action.appOwner,
      appName: action.appName,
      appVersion: action.appVersion,
      publisherUserId: action.publisherUserId,
      publisherDisplayName: action.publisherDisplayName,
      title: action.title,
      description: action.description,
      createdAt: action.createdAt,
      expiresAt: action.expiresAt,
      permissions: action.permissions,
      permissionsDigest: action.permissionsDigest,
    });
  }
  stmt.free();
  return pending;
}


function listRecoverableDesktopActions(
  userId: string,
  installationId: string,
): RecoverableDesktopAction[] {
  const stmt = getDb().prepare(`
    SELECT * FROM desktop_actions
    WHERE user_id = ? AND installation_id = ?
      AND status IN ('claimed', 'awaiting_trust', 'preparing', 'running')
    ORDER BY created_at ASC, id ASC
  `);
  stmt.bind([userId, installationId]);
  const actions: RecoverableDesktopAction[] = [];
  while (stmt.step()) {
    actions.push(toRecoverableAction(actionFromRow(stmt.getAsObject())));
  }
  stmt.free();
  return actions;
}


function claimDesktopAction(
  userId: string,
  id: string,
  nonce: string,
  installationId: string,
  now = new Date(),
): ClaimDesktopActionResult {
  expirePendingDesktopActions(now);
  const existing = selectAction(userId, id);
  if (!existing) return { outcome: "not_found" };
  if (existing.nonce !== nonce) return { outcome: "invalid_nonce" };
  if (existing.status === "expired") return { outcome: "expired" };
  if (existing.installationId !== null) {
    return existing.installationId === installationId
      ? { outcome: "claimed", action: existing, idempotent: true }
      : { outcome: "conflict" };
  }
  if (existing.status !== "pending") return { outcome: "conflict" };

  const timestamp = now.toISOString();
  const database = getDb();
  database.run(`
    UPDATE desktop_actions
    SET installation_id = ?, status = 'claimed', claimed_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND nonce = ? AND status = 'pending'
      AND installation_id IS NULL AND expires_at > ?
  `, [installationId, timestamp, timestamp, id, userId, nonce, timestamp]);
  if (database.getRowsModified() === 0) {
    const winner = selectAction(userId, id);
    if (winner?.installationId === installationId) return { outcome: "claimed", action: winner, idempotent: true };
    return winner?.status === "expired" ? { outcome: "expired" } : { outcome: "conflict" };
  }
  flushMetaDb();
  return { outcome: "claimed", action: selectAction(userId, id)!, idempotent: false };
}


/** Claim using the high-entropy activation nonce, without copying source identity. */
function claimDeviceAction(
  id: string,
  nonce: string,
  installationId: string,
  expectedServerOrigin?: string,
  now = new Date(),
): ClaimDeviceActionResult {
  expirePendingDesktopActions(now);
  const existing = selectActionById(id);
  if (!existing) return { outcome: "not_found" };
  if (expectedServerOrigin !== undefined && existing.serverOrigin !== expectedServerOrigin) {
    return { outcome: "not_found" };
  }
  if (existing.nonce !== nonce) return { outcome: "invalid_nonce" };
  if (existing.status === "expired") return { outcome: "expired" };
  if (existing.installationId !== null) {
    return existing.installationId === installationId
      ? { outcome: "claimed", action: existing, idempotent: true }
      : { outcome: "conflict" };
  }
  if (existing.status !== "pending") return { outcome: "conflict" };

  const timestamp = now.toISOString();
  const database = getDb();
  database.run(`
    UPDATE desktop_actions
    SET installation_id = ?, status = 'claimed', claimed_at = ?, updated_at = ?
    WHERE id = ? AND nonce = ? AND status = 'pending'
      AND installation_id IS NULL AND expires_at > ?
  `, [installationId, timestamp, timestamp, id, nonce, timestamp]);
  if (database.getRowsModified() === 0) {
    const winner = selectActionById(id);
    if (winner?.installationId === installationId) return { outcome: "claimed", action: winner, idempotent: true };
    return winner?.status === "expired" ? { outcome: "expired" } : { outcome: "conflict" };
  }
  flushMetaDb();
  return { outcome: "claimed", action: selectActionById(id)!, idempotent: false };
}


function transitionDesktopAction(
  input: TransitionDesktopActionInput,
  now = new Date(),
): TransitionDesktopActionResult {
  expirePendingDesktopActions(now);
  const existing = selectAction(input.userId, input.id);
  if (!existing || existing.installationId === null || existing.installationId !== input.installationId) {
    return { outcome: "not_found" };
  }
  if (existing.status === input.status) {
    return { outcome: "updated", action: toSnapshot(existing), changed: false };
  }
  if (TERMINAL_STATUSES.has(existing.status)) {
    return { outcome: "terminal_conflict" };
  }
  if (!ALLOWED_TRANSITIONS[existing.status].has(input.status)) return { outcome: "invalid_transition" };

  const resultJson = input.result === undefined
    ? null
    : boundedJson(input.result, DESKTOP_ACTION_RESULT_MAX_BYTES, "DESKTOP_ACTION_RESULT_TOO_LARGE", "DESKTOP_ACTION_INVALID_RESULT");
  const boundedError = input.error ? boundDesktopActionError(input.error) : null;
  const errorMessage = boundedError?.message ?? null;
  const errorCode = boundedError?.code ?? null;
  const timestamp = now.toISOString();
  const completedAt = TERMINAL_STATUSES.has(input.status) ? timestamp : null;
  const database = getDb();
  database.run(`
    UPDATE desktop_actions
    SET status = ?, result_json = ?, error_message = ?, error_code = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND user_id = ? AND installation_id = ? AND status = ?
  `, [input.status, resultJson, errorMessage, errorCode, timestamp, completedAt, input.id, input.userId, input.installationId, existing.status]);
  if (database.getRowsModified() === 0) {
    const current = selectAction(input.userId, input.id);
    if (current?.installationId === input.installationId && current.status === input.status) {
      return { outcome: "updated", action: toSnapshot(current), changed: false };
    }
    return current && TERMINAL_STATUSES.has(current.status) ? { outcome: "terminal_conflict" } : { outcome: "invalid_transition" };
  }
  flushMetaDb();
  return { outcome: "updated", action: toSnapshot(selectAction(input.userId, input.id)!), changed: true };
}


function transitionDeviceAction(input: {
  id: string;
  callbackToken: string;
  installationId: string;
  status: DesktopActionStatus;
  result?: unknown;
  error?: DesktopActionError | null;
}, now = new Date()): TransitionDesktopActionResult {
  const existing = selectActionById(input.id);
  if (!existing || existing.nonce !== input.callbackToken) return { outcome: "not_found" };
  return transitionDesktopAction({
    userId: existing.userId,
    id: input.id,
    installationId: input.installationId,
    status: input.status,
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.error === undefined ? {} : { error: input.error }),
  }, now);
}


function cleanupDesktopActions(completedBefore: Date): number {
  const database = getDb();
  database.run("DELETE FROM desktop_actions WHERE completed_at IS NOT NULL AND completed_at < ?", [completedBefore.toISOString()]);
  const count = database.getRowsModified();
  if (count > 0) flushMetaDb();
  return count;
}

return { isExactSemver, createDesktopAction, expirePendingDesktopActions, getDesktopActionSnapshot, listPendingDesktopActions, listRecoverableDesktopActions, claimDesktopAction, claimDeviceAction, transitionDesktopAction, transitionDeviceAction, cleanupDesktopActions };
}
