export type TaskKind = "build" | "test" | "git" | "agent";
export type TaskStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";

export interface TaskRecord {
  id: string;
  workspaceId: string;
  kind: TaskKind;
  executable: string;
  args: string[];
  timeoutMs: number;
  requestedBy: string;
  status: TaskStatus;
  pid: number | null;
  processIdentity: string | null;
  exitCode: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

