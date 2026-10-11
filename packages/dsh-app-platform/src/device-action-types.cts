import { createHash } from "node:crypto";
import path from "node:path";

export const DEVICE_ACTION_PROTOCOL_VERSION = 2;
export const DEVICE_ACTION_SCRIPT_MAX_BYTES = 256 * 1024;
export const DEVICE_ACTION_INPUT_MAX_BYTES = 1024 * 1024;
export const DEVICE_ACTION_RESULT_MAX_BYTES = 1024 * 1024;
export const DEVICE_ACTION_ERROR_MAX_BYTES = 64 * 1024;
export const DEVICE_ACTION_MAX_DEPENDENCIES = 64;
export const DEVICE_ACTION_DEFAULT_TIMEOUT_SECONDS = 300;

export type DeviceActionStatus =
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

export type DeviceActionTerminalStatus = Extract<
  DeviceActionStatus,
  "succeeded" | "failed" | "cancelled" | "expired" | "interrupted"
>;

export interface DeviceActionPermissionSet {
  filesystemRead?: string[];
  filesystemWrite?: string[];
  network?: boolean;
  childProcess?: boolean;
}

export interface DeviceActionRequest {
  title: string;
  description?: string;
  script: string;
  dependencies?: Record<string, string>;
  input?: unknown;
  permissions: DeviceActionPermissionSet;
  timeoutSeconds?: number;
}

export interface DeviceActionSnapshot<TResult = unknown> {
  requestId: string;
  status: DeviceActionStatus;
  result: TResult | null;
  error: { message: string; code?: string } | null;
  title?: string;
  description?: string | null;
  appOwner?: string;
  appName?: string;
  appVersion?: string | null;
  publisherUserId?: string;
  publisherDisplayName?: string | null;
  permissions?: DeviceActionPermissionSet;
  permissionsDigest?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  claimedAt?: string | null;
  completedAt?: string | null;
}

export interface DeviceActionIdentity {
  sourceOrigin: string;
  appOwner: string;
  appName: string;
  publisherUserId: string;
  publisherDisplayName?: string | null;
}

export interface DeviceActivationTicket {
  protocolVersion: typeof DEVICE_ACTION_PROTOCOL_VERSION;
  sourceOrigin: string;
  actionId: string;
  nonce: string;
}

export class DeviceActionPolicyError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "DeviceActionPolicyError";
  }
}

const ACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PACKAGE_NAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?|@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)$/;
const EXACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isDeviceActionId(value: string): boolean {
  return ACTION_ID_PATTERN.test(value);
}

export function isDeviceActionNonce(value: string): boolean {
  return NONCE_PATTERN.test(value);
}

export function normalizeDeviceActionOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_ORIGIN");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_ORIGIN");
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_ORIGIN");
  }
  return parsed.origin;
}

export function normalizeDeviceActionIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) {
    throw new DeviceActionPolicyError(code);
  }
  return value;
}

function normalizeFilesystemRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
    throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_FILESYSTEM_PERMISSION");
  }
  if (!path.isAbsolute(value)) throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_FILESYSTEM_PERMISSION");
  const normalized = path.normalize(value);
  if (!path.isAbsolute(normalized)) throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_FILESYSTEM_PERMISSION");
  return normalized.length > 1 ? normalized.replace(/[\\/]$/, "") : normalized;
}

function normalizeRoots(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_FILESYSTEM_PERMISSION");
  const roots = [...new Set(value.map(normalizeFilesystemRoot))].sort((left, right) => left.localeCompare(right));
  return roots.length > 0 ? roots : undefined;
}

export function canonicalizeDeviceActionPermissions(value: unknown): DeviceActionPermissionSet {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_PERMISSIONS");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["filesystemRead", "filesystemWrite", "network", "childProcess"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_PERMISSIONS");
  }
  const filesystemRead = normalizeRoots(input.filesystemRead);
  const filesystemWrite = normalizeRoots(input.filesystemWrite);
  if (input.network !== undefined && typeof input.network !== "boolean") {
    throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_PERMISSIONS");
  }
  if (input.childProcess !== undefined && typeof input.childProcess !== "boolean") {
    throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_PERMISSIONS");
  }
  return {
    ...(filesystemRead ? { filesystemRead } : {}),
    ...(filesystemWrite ? { filesystemWrite } : {}),
    ...(input.network === true ? { network: true } : {}),
    ...(input.childProcess === true ? { childProcess: true } : {}),
  };
}

export function deviceActionPermissionsDigest(permissions: DeviceActionPermissionSet): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeDeviceActionPermissions(permissions))).digest("hex");
}

export function isPermissionPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function deviceActionPermissionsContain(
  granted: DeviceActionPermissionSet,
  requested: DeviceActionPermissionSet,
): boolean {
  const covers = (grantedRoots: string[] | undefined, requestedRoots: string[] | undefined): boolean =>
    (requestedRoots ?? []).every((requestedRoot) => (grantedRoots ?? []).some((root) => isPermissionPathWithin(root, requestedRoot)));
  return covers(granted.filesystemRead, requested.filesystemRead)
    && covers(granted.filesystemWrite, requested.filesystemWrite)
    && (!requested.network || granted.network === true)
    && (!requested.childProcess || granted.childProcess === true);
}

export function isExactDeviceActionDependencyVersion(value: string): boolean {
  const match = EXACT_VERSION_PATTERN.exec(value);
  if (!match) return false;
  const prerelease = match[4];
  return !prerelease || prerelease.split(".").every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0"));
}

function canonicalizeDependencies(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_DEPENDENCIES");
  }
  const entries = Object.entries(value);
  if (entries.length > DEVICE_ACTION_MAX_DEPENDENCIES) throw new DeviceActionPolicyError("DEVICE_ACTION_TOO_MANY_DEPENDENCIES");
  for (const [name, version] of entries) {
    if (name.length > 214 || !PACKAGE_NAME_PATTERN.test(name) || typeof version !== "string" || !isExactDeviceActionDependencyVersion(version)) {
      throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_DEPENDENCY");
    }
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function boundedJson(value: unknown, maxBytes: number, code: string): unknown {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new DeviceActionPolicyError(code); }
  if (json === undefined || Buffer.byteLength(json, "utf8") > maxBytes) throw new DeviceActionPolicyError(code);
  return JSON.parse(json);
}

export function canonicalizeDeviceActionRequest(value: unknown): DeviceActionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_PAYLOAD");
  const input = value as Record<string, unknown>;
  if (typeof input.title !== "string" || input.title.trim().length === 0 || input.title.length > 256) {
    throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_TITLE");
  }
  if (input.description !== undefined && input.description !== null
    && (typeof input.description !== "string" || input.description.length > 4096)) {
    throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_DESCRIPTION");
  }
  if (typeof input.script !== "string") throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_SCRIPT");
  if (Buffer.byteLength(input.script, "utf8") > DEVICE_ACTION_SCRIPT_MAX_BYTES) throw new DeviceActionPolicyError("DEVICE_ACTION_SCRIPT_TOO_LARGE");
  if (!("permissions" in input)) throw new DeviceActionPolicyError("DEVICE_ACTION_PERMISSIONS_REQUIRED");
  const permissions = canonicalizeDeviceActionPermissions(input.permissions);
  const timeoutCandidate = input.timeoutSeconds;
  const timeoutSeconds = timeoutCandidate === undefined ? DEVICE_ACTION_DEFAULT_TIMEOUT_SECONDS : timeoutCandidate;
  if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new DeviceActionPolicyError("DEVICE_ACTION_INVALID_TIMEOUT");
  return {
    title: input.title.trim(),
    ...(input.description === undefined || input.description === null ? {} : { description: input.description }),
    script: input.script,
    dependencies: canonicalizeDependencies(input.dependencies),
    input: boundedJson(input.input ?? null, DEVICE_ACTION_INPUT_MAX_BYTES, "DEVICE_ACTION_INPUT_TOO_LARGE"),
    permissions,
    timeoutSeconds,
  };
}

export function assertDeviceActionIdentity(identity: DeviceActionIdentity): DeviceActionIdentity {
  return {
    sourceOrigin: normalizeDeviceActionOrigin(identity.sourceOrigin),
    appOwner: normalizeDeviceActionIdentifier(identity.appOwner, "DEVICE_ACTION_INVALID_APP_OWNER"),
    appName: normalizeDeviceActionIdentifier(identity.appName, "DEVICE_ACTION_INVALID_APP_NAME"),
    publisherUserId: normalizeDeviceActionIdentifier(identity.publisherUserId, "DEVICE_ACTION_INVALID_PUBLISHER"),
    ...(identity.publisherDisplayName == null ? {} : { publisherDisplayName: String(identity.publisherDisplayName).slice(0, 256) }),
  };
}
