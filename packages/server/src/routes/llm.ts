import type { FastifyInstance } from "fastify";
import type { LlmRoutesHost } from "@localapp/dsh-agent-runtime/llm-routes";
import type AgentSettings from "@localapp/dsh-agent-settings" with { "resolution-mode": "import" };
import { createAgentSettingsOptions } from "../lib/agent-settings.js";
export function createLlmRoutesHost(app: FastifyInstance, multiuser: Pick<AgentSettings, "createStore">): LlmRoutesHost {
  return { settings: multiuser.createStore(...createAgentSettingsOptions(app.config.dataDir)), userId: request => request.userId };
}
