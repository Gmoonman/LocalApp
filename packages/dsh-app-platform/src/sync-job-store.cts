import { randomUUID } from "node:crypto";
import type { Database } from "sql.js";
export interface SyncJobPersistence { database(): Database; flush(): void; }

export const SYNC_JOB_STATES = [
  "queued", "staging", "validating", "backing-up", "installing", "activating",
  "completed", "rolled-back", "failed", "recovery-required",
] as const;
export type SyncJobStatus = typeof SYNC_JOB_STATES[number];
export type SyncJobHistoryEntry = { status: SyncJobStatus; at: string; error?: string; backupId?: string };

export interface SyncJobRecord {
  id: string;
  ownerId: string;
  appName: string;
  peerId: string;
  syncId: string;
  withData: boolean;
  appVersion: string | null;
  packageDigest: string | null;
  packageSize: number | null;
  dataDigest: string | null;
  dataSize: number | null;
  backupId: string | null;
  status: SyncJobStatus;
  history: SyncJobHistoryEntry[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const TERMINAL = new Set<SyncJobStatus>(["completed", "rolled-back", "failed", "recovery-required"]);

export class SyncJobStore {
  constructor(private readonly persistence: SyncJobPersistence) {}
  create(input: { ownerId: string; appName: string; peerId: string; syncId: string; withData: boolean }): SyncJobRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const history: SyncJobHistoryEntry[] = [{ status: "queued", at: now }];
    this.persistence.database().run(
      `INSERT INTO sync_jobs (id, owner_id, app_name, peer_id, sync_id, with_data, app_version, package_digest, package_size, data_digest, data_size, status, history_json, error, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'queued', ?, NULL, ?, ?, NULL)`,
      [id, input.ownerId, input.appName, input.peerId, input.syncId, input.withData ? 1 : 0, JSON.stringify(history), now, now],
    );
    this.persistence.flush();
    return this.get(id)!;
  }

  get(id: string): SyncJobRecord | null {
    const statement = this.persistence.database().prepare("SELECT * FROM sync_jobs WHERE id = ?");
    statement.bind([id]);
    const value = statement.step() ? fromRow(statement.getAsObject()) : null;
    statement.free();
    return value;
  }

  getOwned(id: string, ownerId: string): SyncJobRecord | null {
    const job = this.get(id);
    return job?.ownerId === ownerId ? job : null;
  }

  list(ownerId: string): SyncJobRecord[] {
    const statement = this.persistence.database().prepare("SELECT * FROM sync_jobs WHERE owner_id = ? ORDER BY created_at DESC, id DESC");
    statement.bind([ownerId]);
    const jobs: SyncJobRecord[] = [];
    while (statement.step()) jobs.push(fromRow(statement.getAsObject()));
    statement.free();
    return jobs;
  }

  setPackage(id: string, input: { appVersion: string; packageDigest: string; packageSize: number }): SyncJobRecord {
    const now = new Date().toISOString();
    this.persistence.database().run(
      "UPDATE sync_jobs SET app_version = ?, package_digest = ?, package_size = ?, updated_at = ? WHERE id = ?",
      [input.appVersion, input.packageDigest, input.packageSize, now, id],
    );
    this.persistence.flush();
    return required(this.get(id));
  }

  setData(id: string, input: { dataDigest: string; dataSize: number }): SyncJobRecord {
    const now = new Date().toISOString();
    this.persistence.database().run(
      "UPDATE sync_jobs SET data_digest = ?, data_size = ?, updated_at = ? WHERE id = ?",
      [input.dataDigest, input.dataSize, now, id],
    );
    this.persistence.flush();
    return required(this.get(id));
  }

  transition(id: string, status: SyncJobStatus, error?: string, backupId?: string): SyncJobRecord {
    const current = required(this.get(id));
    if (TERMINAL.has(current.status)) return current;
    const now = new Date().toISOString();
    const history = [...current.history, { status, at: now, ...(error ? { error } : {}), ...(backupId ? { backupId } : {}) }];
    this.persistence.database().run(
      "UPDATE sync_jobs SET status = ?, history_json = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?",
      [status, JSON.stringify(history), error ?? null, now, TERMINAL.has(status) ? now : null, id],
    );
    this.persistence.flush();
    return required(this.get(id));
  }

  reconcileInterrupted(): number {
    const statement = this.persistence.database().prepare("SELECT id, status FROM sync_jobs WHERE status NOT IN ('completed','rolled-back','failed','recovery-required')");
    const interrupted: Array<{ id: string; status: SyncJobStatus }> = [];
    while (statement.step()) {
      const row = statement.getAsObject();
      interrupted.push({ id: String(row.id), status: String(row.status) as SyncJobStatus });
    }
    statement.free();
    for (const job of interrupted) {
      this.transition(
        job.id,
        job.status === "activating" || job.status === "installing" || job.status === "backing-up" ? "recovery-required" : "failed",
        "Server restarted during synchronization",
      );
    }
    return interrupted.length;
  }
}

function required(value: SyncJobRecord | null): SyncJobRecord {
  if (!value) throw new Error("SYNC_JOB_NOT_FOUND");
  return value;
}

function fromRow(row: Record<string, unknown>): SyncJobRecord {
  let history: SyncJobHistoryEntry[] = [];
  try { history = JSON.parse(String(row.history_json)) as SyncJobHistoryEntry[]; } catch { /* retained corrupt history stays readable */ }
  return {
    id: String(row.id), ownerId: String(row.owner_id), appName: String(row.app_name), peerId: String(row.peer_id),
    syncId: String(row.sync_id), withData: Number(row.with_data) === 1,
    appVersion: row.app_version == null ? null : String(row.app_version),
    packageDigest: row.package_digest == null ? null : String(row.package_digest),
    packageSize: row.package_size == null ? null : Number(row.package_size),
    dataDigest: row.data_digest == null ? null : String(row.data_digest),
    dataSize: row.data_size == null ? null : Number(row.data_size),
    backupId: [...history].reverse().find((entry) => entry.backupId)?.backupId ?? null,
    status: String(row.status) as SyncJobStatus, history, error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}
