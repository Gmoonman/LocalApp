import { isRequestUserAuthenticated } from "../plugins/auth.js";
import { nativeClientAssets } from "../lib/native-client-resources.js";
import type { Context as DshContext } from "@deepseek-ai/cordis" with { "resolution-mode": "import" };
import type { FastifyInstance } from "fastify";
import { createAgentSettingsOptions, AGENT_CAPABILITIES } from "../lib/agent-settings.js";
import { systemAgentEnvironment } from "../lib/system-agent-environment.js";
import { findUserById } from "../lib/meta-sqlite.js";
import type { AgentRoutesHost } from "@localapp/dsh-agent-runtime/agent-routes" with { "resolution-mode": "import" };

export async function createAgentRoutesHost(app: FastifyInstance, context: DshContext): Promise<AgentRoutesHost> {
  const { DeepSeekHarness } = await import("../lib/deepseek-harness.mjs");
  const settings = context.localappAgentSettings.createStore(...createAgentSettingsOptions(app.config.dataDir));
  return {
    dataDir: app.config.dataDir, publicUrl: app.config.publicUrl, settings, runtimes: context.localappAgentRuntime,
    registerSettings:context.localappAgentSettings.registerRoutes.bind(context.localappAgentSettings),
    userId: request => request.userId,
    isAuthenticated: isRequestUserAuthenticated,
    documents: () => context.get("localappDocuments"),
    resolveApp: (userId, appId) => {
      if (!findUserById(userId)) throw new Error("Agent account is unavailable");
      const platform = context.get("localappApps");
      if (platform) return platform.resolveAgentApp(userId, appId);
      if (appId && appId !== "platform") throw new Error("Application platform plugin is not enabled");
      return { id: "platform", capabilities: [...AGENT_CAPABILITIES] };
    },
    environment: () => systemAgentEnvironment(app.config.dataDir),
    clientAssets: () => nativeClientAssets(context),
    createHarness: config => new DeepSeekHarness(config),
  };
}
