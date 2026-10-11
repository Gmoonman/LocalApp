import type { TaskLogChunk, TaskRecord } from "../task-runner.cjs";

export type AgentKind = "codex" | "opencode";

export interface AgentCapability {
  kind: AgentKind;
  executable: string;
  available: boolean;
  supportsContinuation: boolean;
}

export interface StartAgentInput {
  workspaceId: string;
  agent: AgentKind;
  prompt: string;
  timeoutMs: number;
  requestedBy: string;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  capability(): AgentCapability;
  start(input: Omit<StartAgentInput, "agent">): Promise<TaskRecord>;
  send(id: string, prompt: string): Promise<void>;
  cancel(id: string): Promise<TaskRecord>;
  logs(id: string, cursor: number): TaskLogChunk;
}
