import type { FastifyInstance } from "fastify";
import type { LlmRoutesHost } from "@localapp/dsh-multiuser/llm-routes";
import type MultiuserRuntime from "@localapp/dsh-multiuser" with { "resolution-mode": "import" };
import { createAgentSettingsOptions } from "../lib/agent-settings.js";
export function createLlmRoutesHost(app: FastifyInstance, multiuser: Pick<MultiuserRuntime, "createSettings">): LlmRoutesHost {
  return { settings: multiuser.createSettings(...createAgentSettingsOptions(app.config.dataDir)), userId: request => request.userId };
}
