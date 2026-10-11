import { CodexAgent } from "./agents/codex-agent.cjs";
import { OpenCodeAgent } from "./agents/opencode-agent.cjs";
import type { AgentAdapter, AgentKind, StartAgentInput } from "./agents/types.cjs";
import type { TaskRunner } from "./task-runner.cjs";

export interface AgentRunnerOptions {
  taskRunner: TaskRunner;
  executableResolver?: (name: AgentKind) => string | null;
}

export class AgentRunner {
  private readonly adapters: Map<AgentKind, AgentAdapter>;

  constructor(options: AgentRunnerOptions) {
    const resolve = options.executableResolver ?? ((name: AgentKind) => options.taskRunner.resolveAllowedExecutable(name));
    const adapters: AgentAdapter[] = [
      new CodexAgent(options.taskRunner, resolve("codex")),
      new OpenCodeAgent(options.taskRunner, resolve("opencode")),
    ];
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  capabilities() {
    return (["codex", "opencode"] as const).map((kind) => this.adapters.get(kind)!.capability());
  }

  start(input: StartAgentInput) {
    const adapter = this.requireAdapter(input.agent);
    return adapter.start(input);
  }

  send(id: string, prompt: string, agent: AgentKind) {
    if (!prompt.trim()) throw new Error("Agent prompt is required");
    return this.requireAdapter(agent).send(id, prompt);
  }

  cancel(id: string, agent: AgentKind) {
    return this.requireAdapter(agent).cancel(id);
  }

  logs(id: string, cursor: number, agent: AgentKind) {
    return this.requireAdapter(agent).logs(id, cursor);
  }

  private requireAdapter(kind: AgentKind): AgentAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`Unknown agent: ${kind}`);
    return adapter;
  }
}
