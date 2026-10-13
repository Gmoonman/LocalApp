import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalizeDeviceActionPermissions,
  deviceActionPermissionsDigest,
  type DeviceActionPermissionSet,
  type DeviceActionStatus,
} from "@localapp/dsh-device-services/device-action-types";
import type { DeviceActionRecord as SourceDeviceActionRecord } from "@localapp/dsh-device-services/device-action-record";

export interface LocalDeviceActionRecord {
  requestId: string;
  callbackToken: string;
  installationId: string;
  sourceOrigin: string;
  userId: string;
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
  status: DeviceActionStatus;
  result: unknown;
  error: { message: string; code?: string } | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

export type LocalDeviceActionSnapshot = Omit<
  LocalDeviceActionRecord,
  "callbackToken" | "installationId" | "userId" | "script" | "dependencies" | "input"
>;

export interface DeviceActionLogEntry {
  requestId: string;
  status: DeviceActionStatus;
  message: string;
  createdAt: string;
}

const TERMINAL = new Set<DeviceActionStatus>(["succeeded", "failed", "cancelled", "expired", "interrupted"]);
const TRANSITIONS: Record<DeviceActionStatus, ReadonlySet<DeviceActionStatus>> = {
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

export class DeviceActionLocalStore {
  private readonly filePath: string;
  private readonly installationPath: string;
  private records: LocalDeviceActionRecord[];
  private logs: DeviceActionLogEntry[];

  constructor(dataDir: string) {
    const directory = path.join(dataDir, "device-actions");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filePath = path.join(directory, "actions.json");
    this.installationPath = path.join(directory, "installation-id");
    const loaded = this.load();
    this.records = loaded.records;
    this.logs = loaded.logs;
  }

  installationId(): string {
    if (fs.existsSync(this.installationPath)) {
      const current = fs.readFileSync(this.installationPath, "utf8").trim();
      if (/^[0-9a-f-]{36}$/.test(current)) return current;
    }
    const value = randomUUID();
    fs.writeFileSync(this.installationPath, `${value}\n`, { mode: 0o600 });
    return value;
  }

  claim(source: SourceDeviceActionRecord, callbackToken: string): LocalDeviceActionRecord {
    const current = this.records.find((record) => record.requestId === source.id);
    if (current && current.installationId !== this.installationId()) {
      throw new Error("DEVICE_ACTION_CLAIM_CONFLICT");
    }
    const now = new Date().toISOString();
    const record: LocalDeviceActionRecord = {
      requestId: source.id,
      callbackToken,
      installationId: this.installationId(),
      sourceOrigin: source.serverOrigin,
      // Source user identity is intentionally not synchronized to the target.
      userId: "",
      appOwner: source.appOwner,
      appName: source.appName,
      appVersion: source.appVersion,
      publisherUserId: source.publisherUserId,
      publisherDisplayName: source.publisherDisplayName,
      title: source.title,
      description: source.description,
      script: source.script,
      dependencies: source.dependencies,
      input: source.input,
      timeoutSeconds: source.timeoutSeconds,
      permissions: canonicalizeDeviceActionPermissions(source.permissions),
      permissionsDigest: source.permissionsDigest || deviceActionPermissionsDigest(source.permissions),
      status: current?.status ?? "claimed",
      result: current?.result ?? null,
      error: current?.error ?? null,
      createdAt: source.createdAt,
      updatedAt: now,
      expiresAt: source.expiresAt,
      claimedAt: source.claimedAt ?? now,
      completedAt: current?.completedAt ?? null,
    };
    this.records = [...this.records.filter((candidate) => candidate.requestId !== record.requestId), record];
    this.appendLog(record.requestId, record.status, "action claimed by this Server");
    this.persist();
    return record;
  }

  get(requestId: string): LocalDeviceActionRecord | null {
    return this.records.find((record) => record.requestId === requestId) ?? null;
  }

  snapshot(requestId: string): LocalDeviceActionSnapshot | null {
    const record = this.get(requestId);
    return record ? toSnapshot(record) : null;
  }

  list(): LocalDeviceActionSnapshot[] {
    return this.records.map(toSnapshot).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listPendingTrust(): LocalDeviceActionSnapshot[] {
    return this.list().filter((record) => record.status === "awaiting_trust");
  }

  listRecoverable(): LocalDeviceActionRecord[] {
    return this.records.filter((record) => ["claimed", "awaiting_trust", "preparing", "running"].includes(record.status));
  }

  transition(
    requestId: string,
    status: DeviceActionStatus,
    result?: unknown,
    error?: { message: string; code?: string } | null,
  ): LocalDeviceActionRecord {
    const current = this.get(requestId);
    if (!current) throw new Error("DEVICE_ACTION_NOT_FOUND");
    if (current.status === status) return current;
    if (TERMINAL.has(current.status)) throw new Error("DEVICE_ACTION_TERMINAL_CONFLICT");
    if (!TRANSITIONS[current.status].has(status)) throw new Error("DEVICE_ACTION_INVALID_TRANSITION");
    const now = new Date().toISOString();
    const updated: LocalDeviceActionRecord = {
      ...current,
      status,
      result: result === undefined ? current.result : result,
      error: error === undefined ? current.error : error,
      updatedAt: now,
      completedAt: TERMINAL.has(status) ? now : current.completedAt,
    };
    this.records = this.records.map((record) => record.requestId === requestId ? updated : record);
    this.appendLog(requestId, status, error?.message ?? `action ${status}`);
    this.persist();
    return updated;
  }

  logsFor(requestId?: string): DeviceActionLogEntry[] {
    return this.logs.filter((entry) => requestId === undefined || entry.requestId === requestId);
  }

  private appendLog(requestId: string, status: DeviceActionStatus, message: string): void {
    this.logs.push({ requestId, status, message: message.slice(0, 2048), createdAt: new Date().toISOString() });
    if (this.logs.length > 5000) this.logs = this.logs.slice(-5000);
  }

  private load(): { records: LocalDeviceActionRecord[]; logs: DeviceActionLogEntry[] } {
    if (!fs.existsSync(this.filePath)) return { records: [], logs: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
      const records = Array.isArray(parsed.records) ? parsed.records as LocalDeviceActionRecord[] : [];
      const logs = Array.isArray(parsed.logs) ? parsed.logs as DeviceActionLogEntry[] : [];
      return { records, logs };
    } catch {
      return { records: [], logs: [] };
    }
  }

  private persist(): void {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ records: this.records, logs: this.logs }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}

function toSnapshot(record: LocalDeviceActionRecord): LocalDeviceActionSnapshot {
  const { callbackToken: _callbackToken, installationId: _installationId, userId: _userId, script: _script, dependencies: _dependencies, input: _input, ...snapshot } = record;
  return snapshot;
}
