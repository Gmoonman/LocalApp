import { initializeExecutionSchema } from "./execution-schema.cjs";
import { randomUUID } from "node:crypto";
import type { DevelopmentPersistence } from "./projects.cjs";

import type { TaskKind, TaskStatus, TaskRecord } from "./task-types.cjs";
export type { TaskKind, TaskStatus, TaskRecord } from "./task-types.cjs";

export interface CreateTaskInput {
  id?: string;
  workspaceId: string;
  kind: TaskKind;
  executable: string;
  args: string[];
  timeoutMs: number;
  requestedBy: string;
  outputPath: string;
  status?: TaskStatus;
  pid?: number | null;
  processIdentity?: string | null;
}

export class TaskStore {
  constructor(private readonly persistence: DevelopmentPersistence) {
    initializeExecutionSchema(persistence.database());
    persistence.flush();
  }
  create(input: CreateTaskInput): TaskRecord {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const status = input.status ?? "running";
    const startedAt = status === "running" ? now : null;
    const completedAt = status === "running" ? null : now;
    this.persistence.database().run(
      `INSERT INTO tasks (
        id, workspace_id, kind, executable, args_json, timeout_ms, requested_by,
        output_path, status, pid, process_identity, exit_code, error, created_at, started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      [
        id, input.workspaceId, input.kind, input.executable, JSON.stringify(input.args), input.timeoutMs,
        input.requestedBy, input.outputPath, status, input.pid ?? null, input.processIdentity ?? null, now, startedAt, completedAt, now,
      ],
    );
    this.persistence.flush();
    return this.get(id)!;
  }

  get(id: string): TaskRecord | null {
    const statement = this.persistence.database().prepare("SELECT * FROM tasks WHERE id = ?");
    statement.bind([id]);
    const record = statement.step() ? taskFromRow(statement.getAsObject()) : null;
    statement.free();
    return record;
  }

  getOwned(id: string, requestedBy: string): TaskRecord | null {
    const record = this.get(id);
    return record?.requestedBy === requestedBy ? record : null;
  }

  list(requestedBy: string): TaskRecord[] {
    const statement = this.persistence.database().prepare("SELECT * FROM tasks WHERE requested_by = ? ORDER BY created_at DESC, id DESC");
    statement.bind([requestedBy]);
    const records: TaskRecord[] = [];
    while (statement.step()) records.push(taskFromRow(statement.getAsObject()));
    statement.free();
    return records;
  }

  outputPath(id: string): string | null {
    const statement = this.persistence.database().prepare("SELECT output_path FROM tasks WHERE id = ?");
    statement.bind([id]);
    const value = statement.step() ? String(statement.getAsObject().output_path) : null;
    statement.free();
    return value;
  }

  setPid(id: string, pid: number, processIdentity: string): TaskRecord {
    const now = new Date().toISOString();
    this.persistence.database().run("UPDATE tasks SET pid = ?, process_identity = ?, updated_at = ? WHERE id = ? AND status = 'running'", [pid, processIdentity, now, id]);
    this.persistence.flush();
    const record = this.get(id);
    if (!record) throw new Error("TASK_NOT_FOUND");
    return record;
  }

  finish(id: string, status: Exclude<TaskStatus, "running">, input: { exitCode?: number | null; error?: string | null } = {}): TaskRecord {
    const now = new Date().toISOString();
    this.persistence.database().run(
      "UPDATE tasks SET status = ?, exit_code = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      [status, input.exitCode ?? null, input.error ?? null, now, now, id],
    );
    this.persistence.flush();
    const record = this.get(id);
    if (!record) throw new Error("TASK_NOT_FOUND");
    return record;
  }

  listRunning(): TaskRecord[] {
    const statement = this.persistence.database().prepare("SELECT * FROM tasks WHERE status = 'running' ORDER BY created_at, id");
    const records: TaskRecord[] = [];
    while (statement.step()) records.push(taskFromRow(statement.getAsObject()));
    statement.free();
    return records;
  }
}

function taskFromRow(row: Record<string, unknown>): TaskRecord {
  let args: string[] = [];
  try {
    const parsed = JSON.parse(String(row.args_json));
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) args = parsed;
  } catch {
    // A malformed retained record remains readable without executing its arguments.
  }
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: String(row.kind) as TaskKind,
    executable: String(row.executable),
    args,
    timeoutMs: Number(row.timeout_ms),
    requestedBy: String(row.requested_by),
    status: String(row.status) as TaskStatus,
    pid: row.pid === null ? null : Number(row.pid),
    processIdentity: row.process_identity === null || row.process_identity === undefined ? null : String(row.process_identity),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}
