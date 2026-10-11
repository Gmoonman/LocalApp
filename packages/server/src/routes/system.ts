import type { FastifyInstance } from "fastify";
import { adminAuth } from "../plugins/auth.js";
import path from "node:path";
import fs from "node:fs/promises";
import { writeJsonAtomically } from "../lib/server-config-store.js";
import type { PluginCombination, ServerConfig } from "../lib/config.js";
import type { ServerConfigStore } from "../lib/server-config-store.js";

export type PublicSystemSettings = Pick<ServerConfig,
  "listenHost" | "listenPort" | "publicUrl" | "workspaceDir" | "allowInsecureLan"
>;

export interface RestartController {
  requestRestart(exitCode: 75): void;
}

function publicSettings(config: ServerConfig): PublicSystemSettings {
  return {
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    publicUrl: config.publicUrl,
    workspaceDir: config.workspaceDir,
    allowInsecureLan: config.allowInsecureLan,
  };
}

export async function systemRoutes(
  app: FastifyInstance,
  options: { configStore: ServerConfigStore; restartController: RestartController; pluginCombination?: PluginCombination; pluginCombinationControlled?: boolean; documentsEnabled?: boolean; documentsControlled?: boolean },
): Promise<void> {
  app.get("/api/system/status", async () => ({
    success: true,
    data: { listening: true },
  }));

  await app.register(async (adminScope) => {
    await adminAuth(adminScope);

    adminScope.get("/api/system/settings/plugins", async () => ({
      success: true,
      data: { combination: options.pluginCombination ?? adminScope.config.pluginCombination ?? "full", controlledByEnvironment: options.pluginCombinationControlled ?? false, documentsEnabled: options.documentsEnabled ?? true, documentsControlled: options.documentsControlled ?? false },
    }));
    adminScope.put<{ Body: { combination?: PluginCombination; documentsEnabled?: boolean } }>("/api/system/settings/plugins", async (req, reply) => {
      const combination = req.body?.combination;
      if (!combination || !["multiuser", "platform", "full"].includes(combination)) return reply.code(400).send({ success: false, error: "Invalid plugin combination" });
      if (options.pluginCombinationControlled && combination !== (options.pluginCombination ?? adminScope.config.pluginCombination ?? "full")) return reply.code(409).send({ success: false, error: "Plugin combination is controlled by startup configuration" });
      const documentsEnabled = Object.hasOwn(req.body, "documentsEnabled") ? req.body.documentsEnabled : options.documentsEnabled ?? true;
      if (typeof documentsEnabled !== "boolean") return reply.code(400).send({ success: false, error: "Invalid document extension setting" });
      if (options.documentsControlled && documentsEnabled !== options.documentsEnabled) return reply.code(409).send({ success: false, error: "Document extension is controlled by startup configuration" });
      const filename = path.join(adminScope.config.dataDir, "plugins.json");
      let stored = {};
      try { stored = JSON.parse(await fs.readFile(filename, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await writeJsonAtomically(filename, { ...stored, ...(!options.pluginCombinationControlled ? { combination } : {}), ...(!options.documentsControlled ? { documentsEnabled } : {}) });
      reply.raw.once("finish", () => options.restartController.requestRestart(75));
      return reply.code(202).send({ success: true, data: { restarting: true, combination } });
    });

    adminScope.get("/api/system/settings", async () => ({
      success: true,
      data: publicSettings(adminScope.config),
    }));

    adminScope.put<{ Body: Partial<Pick<PublicSystemSettings, "listenHost" | "listenPort" | "allowInsecureLan">> }>(
      "/api/system/settings/network",
      async (req, reply) => {
        const overridden = options.configStore.getNetworkEnvironmentOverrides();
        if (overridden.length > 0) {
          return reply.status(409).send({
            success: false,
            error: `Network settings are controlled by environment variables: ${overridden.join(", ")}`,
          });
        }
        const candidate = await options.configStore.validate({
          ...adminScope.config,
          listenHost: req.body?.listenHost ?? adminScope.config.listenHost,
          listenPort: req.body?.listenPort ?? adminScope.config.listenPort,
          allowInsecureLan: req.body?.allowInsecureLan ?? adminScope.config.allowInsecureLan,
        });
        await options.configStore.stageNetworkChange(candidate);
        reply.raw.once("finish", () => options.restartController.requestRestart(75));
        return reply.status(202).send({ success: true, data: { restarting: true } });
      },
    );
  });
}
