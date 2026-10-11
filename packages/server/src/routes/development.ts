import { isRequestUserAuthenticated } from "../plugins/auth.js";
import type { FastifyInstance } from "fastify";
import type { registerDevelopmentRoutes } from "@localapp/dsh-app-development/routes";
import type MultiuserRuntime from "@localapp/dsh-multiuser" with { "resolution-mode": "import" };
import { createAgentSettingsOptions } from "../lib/agent-settings.js";
import { readPythonEnvironment } from "../lib/python-environment.js";
import { findUserById } from "../lib/meta-sqlite.js";
import { systemAgentEnvironment } from "../lib/system-agent-environment.js";
export type DevelopmentRouteOptions = Omit<Parameters<typeof registerDevelopmentRoutes>[1], "dataDir" | "user" | "isAuthenticated" | "settings" | "pythonEnvironment" | "createHarness">;
export async function createDevelopmentRoutesHost(app: FastifyInstance, options: Omit<DevelopmentRouteOptions, "projects">, multiuser: Pick<MultiuserRuntime, "createSettings">): Promise<Omit<Parameters<typeof registerDevelopmentRoutes>[1], "projects">> {
  const { DeepSeekHarness } = await import("../lib/deepseek-harness.mjs");
  return {
    ...options,
    dataDir: app.config.dataDir,
    user: request => request.userId,
    isAuthenticated: isRequestUserAuthenticated,
    accountExists: userId => !!findUserById(userId),
    settings: multiuser.createSettings(...createAgentSettingsOptions(app.config.dataDir)),
    pythonEnvironment: () => readPythonEnvironment(app.config.dataDir),
    environment: () => systemAgentEnvironment(app.config.dataDir),
    createHarness: config => new DeepSeekHarness(config),
  };
}
