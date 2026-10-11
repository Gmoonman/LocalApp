import type { TaskRunner } from "../task-runner.cjs";
import type { AgentAdapter, AgentCapability, StartAgentInput } from "./types.cjs";

export class CodexAgent implements AgentAdapter {
  readonly kind = "codex" as const;

  constructor(private readonly taskRunner: TaskRunner, private readonly executablePath: string | null) {
    if (executablePath) taskRunner.setAllowedExecutable(this.kind, executablePath);
  }

  capability(): AgentCapability {
    return { kind: this.kind, executable: "codex", available: this.executablePath !== null, supportsContinuation: false };
  }

  async start(input: Omit<StartAgentInput, "agent">) {
    if (!this.executablePath) throw new Error("codex executable is unavailable");
    return await this.taskRunner.start({
      workspaceId: input.workspaceId,
      kind: "agent",
      executable: this.kind,
      args: ["exec", "--json", input.prompt],
      timeoutMs: input.timeoutMs,
      requestedBy: input.requestedBy,
      logParser: parseCodexLog,
    });
  }

  async send(): Promise<void> {
    throw new Error("codex continuation is unavailable");
  }

  cancel(id: string) { return this.taskRunner.cancel(id); }
  logs(id: string, cursor: number) { return this.taskRunner.logs(id, cursor); }
}

export function parseCodexLog(message: string): { type: "text"; text: string } {
  try {
    const value = JSON.parse(message) as {
      type?: string;
      text?: string;
      item?: { type?: string; text?: string };
    };
    if (typeof value.text === "string") return { type: "text", text: value.text };
    if (value.type === "item.completed" && value.item?.type === "agent_message" && typeof value.item.text === "string") {
      return { type: "text", text: value.item.text };
    }
  } catch {
    // Codex may emit plain text when JSON output is unavailable.
  }
  return { type: "text", text: message };
}
