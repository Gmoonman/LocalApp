import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AccessLevel, AppLifecycle, ManifestDb, NotifyConfig, PageAccess, ShellConfig } from "./models.cjs";
import type { PageMeta } from "./page-storage.cjs";
import { validateNotifyConfig } from "./notify-config.cjs";

const SOURCE_MANIFEST_FILE = "manifest.json";
const PLATFORM_MANIFEST_FILE = "manifest.platform.json";
const APP_STATE_TRANSACTION_FILE = ".app-state-transaction.json";
const PLATFORM_MANIFEST_KEYS = new Set(["description", "pageAccess", "shell", "db", "notify", "lifecycle"]);
const ACCESS_LEVELS = new Set<AccessLevel>(["public", "authenticated", "owner", "acl"]);
const DB_MODES = new Set(["crud", "sql"]);

export class PlatformManifestValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "PlatformManifestValidationError";
  }
}

export interface ManifestState {
  sourceKind: "uploaded" | "legacy-projection";
  sourceManifest: Record<string, unknown>;
  platformManifest: Record<string, unknown>;
  effectiveManifest: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path.basename(filePath)} must contain a JSON object`);
  return parsed;
}

function atomicWriteJson(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let renamed = false;
  try {
    const descriptor = fs.openSync(tempPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(tempPath, filePath);
    renamed = true;
    syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (renamed) throw new DurablePublicationError(error);
    throw error;
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

class DurablePublicationError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "DurablePublicationError";
  }
}

function durableRemove(filePath: string): void {
  fs.rmSync(filePath, { force: true });
  syncDirectory(path.dirname(filePath));
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EINVAL", "EPERM", "EISDIR"].includes(code ?? "")) return;
    throw error;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function mergeManifests(
  source: Record<string, unknown>,
  platform: Record<string, unknown>,
): Record<string, unknown> {
  const merged = cloneJson(source);
  for (const [key, value] of Object.entries(platform)) {
    const existing = merged[key];
    merged[key] = isRecord(existing) && isRecord(value)
      ? mergeManifests(existing, value)
      : cloneJson(value);
  }
  return merged;
}

function legacyManifest(meta: PageMeta): Record<string, unknown> {
  return {
    name: meta.name,
    description: meta.description,
    ...(meta.pageAccess ? { pageAccess: meta.pageAccess } : {}),
    ...(meta.shell ? { shell: meta.shell } : {}),
    ...(meta.db ? { db: meta.db } : {}),
    ...(meta.notify ? { notify: meta.notify } : {}),
    ...(meta.lifecycle ? { lifecycle: meta.lifecycle } : {}),
    ...(meta.backend ? { backend: meta.backend } : {}),
    ...(meta.business ? { business: meta.business } : {}),
    ...(meta.collaboration ? { collaboration: meta.collaboration } : {}),
    ...(meta.issues ? { issues: meta.issues } : {}),
  };
}

export function readManifestState(pageDir: string, meta: PageMeta): ManifestState {
  const uploaded = readJsonObject(path.join(pageDir, SOURCE_MANIFEST_FILE));
  const sourceManifest = uploaded ?? legacyManifest(meta);
  const platformManifest = readJsonObject(path.join(pageDir, PLATFORM_MANIFEST_FILE)) ?? {};
  return {
    sourceKind: uploaded ? "uploaded" : "legacy-projection",
    sourceManifest,
    platformManifest,
    effectiveManifest: mergeManifests(sourceManifest, platformManifest),
  };
}

function invalid(field: string, message: string): never {
  throw new PlatformManifestValidationError(field, message);
}

function validateAccessLevel(value: unknown, field: string): asserts value is AccessLevel {
  if (typeof value !== "string" || !ACCESS_LEVELS.has(value as AccessLevel)) {
    invalid(field, "must be public, authenticated, owner, or acl");
  }
}

function validatePageAccess(value: unknown): asserts value is PageAccess {
  if (!isRecord(value)) invalid("pageAccess", "must be an object");
  validateAccessLevel(value.level, "pageAccess.level");
  if (value.acl !== undefined && (!Array.isArray(value.acl) || value.acl.some((entry) => typeof entry !== "string"))) {
    invalid("pageAccess.acl", "must be an array of strings");
  }
}

function validateShell(value: unknown): asserts value is ShellConfig {
  if (!isRecord(value)) invalid("shell", "must be an object");
  if (value.navbar !== undefined && typeof value.navbar !== "boolean") {
    invalid("shell.navbar", "must be a boolean");
  }
  if (value.agentConversation !== undefined && typeof value.agentConversation !== "boolean") {
    invalid("shell.agentConversation", "must be a boolean");
  }
}

function validateDb(value: unknown): asserts value is ManifestDb {
  if (!isRecord(value)) invalid("db", "must be an object");
  if (typeof value.mode !== "string" || !DB_MODES.has(value.mode)) {
    invalid("db.mode", "must be crud or sql");
  }
  if (value.sqlAccess !== undefined) validateAccessLevel(value.sqlAccess, "db.sqlAccess");
  if (value.dangerouslyAllowFrontendSql !== undefined && typeof value.dangerouslyAllowFrontendSql !== "boolean") {
    invalid("db.dangerouslyAllowFrontendSql", "must be a boolean");
  }
  if (value.defaultAccess !== undefined) {
    if (!isRecord(value.defaultAccess)) invalid("db.defaultAccess", "must be an object");
    for (const action of ["read", "create", "update", "delete"] as const) {
      if (value.defaultAccess[action] !== undefined) {
        validateAccessLevel(value.defaultAccess[action], `db.defaultAccess.${action}`);
      }
    }
  }
}

function validateLifecycle(value: unknown): asserts value is AppLifecycle {
  if (!isRecord(value)) invalid("lifecycle", "must be an object");
  if (value.status !== "online" && value.status !== "offline") {
    invalid("lifecycle.status", "must be online or offline");
  }
}

export function validatePlatformManifest(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalid("manifest", "must be an object");
  for (const key of Object.keys(value)) {
    if (!PLATFORM_MANIFEST_KEYS.has(key)) invalid(key, "cannot be overridden by platform settings");
  }
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 5000)) {
    invalid("description", "must be a string no longer than 5000 characters");
  }
  if (value.pageAccess !== undefined) validatePageAccess(value.pageAccess);
  if (value.shell !== undefined) validateShell(value.shell);
  if (value.db !== undefined) validateDb(value.db);
  if (value.notify !== undefined && !validateNotifyConfig(value.notify)) {
    invalid("notify.enabled", "must contain a valid boolean enabled field and permission config");
  }
  if (value.lifecycle !== undefined) validateLifecycle(value.lifecycle);
}

export function writeSourceManifest(pageDir: string, manifest: Record<string, unknown>): void {
  atomicWriteJson(path.join(pageDir, SOURCE_MANIFEST_FILE), manifest);
}

export function commitSourceManifestAndMeta(
  pageDir: string,
  metaPath: string,
  sourceManifest: Record<string, unknown>,
  meta: object,
): void {
  const sourcePath = path.join(pageDir, SOURCE_MANIFEST_FILE);
  const transactionPath = path.join(pageDir, APP_STATE_TRANSACTION_FILE);
  const previousSourceManifest = readJsonObject(sourcePath);
  const previousMeta = readJsonObject(metaPath);
  atomicWriteJson(transactionPath, { sourceManifest, meta });
  try {
    atomicWriteJson(sourcePath, sourceManifest);
    atomicWriteJson(metaPath, meta as Record<string, unknown>);
  } catch (error) {
    if (error instanceof DurablePublicationError) throw error;
    try {
      atomicWriteJson(transactionPath, { sourceManifest: previousSourceManifest, meta: previousMeta });
      publishOptionalJson(sourcePath, previousSourceManifest);
      publishOptionalJson(metaPath, previousMeta);
      durableRemove(transactionPath);
    } catch {
      // The durable journal describes either the new state or the rollback
      // state. A later read completes whichever intent was published last.
    }
    throw error;
  }
  try { durableRemove(transactionPath); }
  catch {
    // Source manifest and metadata are already durable. Replaying the journal
    // is idempotent, so cleanup failure must not roll back a committed state.
  }
}

export function recoverSourceManifestAndMeta(pageDir: string, metaPath: string): void {
  const transactionPath = path.join(pageDir, APP_STATE_TRANSACTION_FILE);
  const transaction = readJsonObject(transactionPath);
  if (!transaction) return;
  const sourceManifest = transaction.sourceManifest;
  const meta = transaction.meta;
  if ((sourceManifest !== null && !isRecord(sourceManifest)) || (meta !== null && !isRecord(meta))) {
    throw new Error("Invalid application state transaction");
  }
  publishOptionalJson(path.join(pageDir, SOURCE_MANIFEST_FILE), sourceManifest);
  publishOptionalJson(metaPath, meta);
  durableRemove(transactionPath);
}

function publishOptionalJson(filePath: string, value: Record<string, unknown> | null): void {
  if (value) atomicWriteJson(filePath, value);
  else durableRemove(filePath);
}

export function writePlatformManifest(pageDir: string, manifest: Record<string, unknown>): void {
  validatePlatformManifest(manifest);
  atomicWriteJson(path.join(pageDir, PLATFORM_MANIFEST_FILE), manifest);
}

export function removePlatformManifest(pageDir: string): void {
  durableRemove(path.join(pageDir, PLATFORM_MANIFEST_FILE));
}

export function materializeManifest(meta: PageMeta, effective: Record<string, unknown>): PageMeta {
  const next = { ...meta };
  next.description = typeof effective.description === "string" ? effective.description : "";
  if (effective.pageAccess == null) delete next.pageAccess;
  else {
    validatePageAccess(effective.pageAccess);
    next.pageAccess = cloneJson(effective.pageAccess);
  }
  if (effective.shell == null) delete next.shell;
  else {
    validateShell(effective.shell);
    next.shell = cloneJson(effective.shell);
  }
  if (effective.db == null) delete next.db;
  else {
    validateDb(effective.db);
    next.db = cloneJson(effective.db);
  }
  if (effective.notify == null) delete next.notify;
  else {
    const notify = validateNotifyConfig(effective.notify);
    if (!notify) invalid("notify", "contains invalid configuration");
    next.notify = cloneJson(notify as NotifyConfig);
  }
  if (effective.lifecycle == null) delete next.lifecycle;
  else {
    validateLifecycle(effective.lifecycle);
    next.lifecycle = cloneJson(effective.lifecycle);
  }
  return next;
}
