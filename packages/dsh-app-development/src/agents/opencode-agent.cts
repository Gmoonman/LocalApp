import type { TaskRunner } from "../task-runner.cjs";
import type { AgentAdapter, AgentCapability, StartAgentInput } from "./types.cjs";

export class OpenCodeAgent implements AgentAdapter {
  readonly kind = "opencode" as const;

  constructor(private readonly taskRunner: TaskRunner, private readonly executablePath: string | null) {
    if (executablePath) taskRunner.setAllowedExecutable(this.kind, executablePath);
  }

  capability(): AgentCapability {
    return { kind: this.kind, executable: "opencode", available: this.executablePath !== null, supportsContinuation: false };
  }

  async start(input: Omit<StartAgentInput, "agent">) {
    if (!this.executablePath) throw new Error("opencode executable is unavailable");
    return await this.taskRunner.start({
      workspaceId: input.workspaceId,
      kind: "agent",
      executable: this.kind,
      args: ["run", "--format", "json", input.prompt],
      timeoutMs: input.timeoutMs,
      requestedBy: input.requestedBy,
      logParser: parseOpenCodeLog,
    });
  }

  async send(): Promise<void> {
    throw new Error("opencode continuation is unavailable");
  }

  cancel(id: string) { return this.taskRunner.cancel(id); }
  logs(id: string, cursor: number) { return this.taskRunner.logs(id, cursor); }
}

export function parseOpenCodeLog(message: string): { type: "text"; text: string } {
  try {
    const value = JSON.parse(message) as { type?: string; text?: string; part?: { text?: string } };
    if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
    if (value.type === "text" && typeof value.part?.text === "string") return { type: "text", text: value.part.text };
  } catch {
    // OpenCode also emits plain text depending on its installed version.
  }
  return { type: "text", text: message };
}
