import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import fs from "node:fs";
import { initMetaDb } from "../lib/meta-sqlite.js";
import { loadConfig, type ServerConfig } from "../lib/config.js";

export * from "@localapp/dsh-app-platform/page-storage";

declare module "fastify" {
  interface FastifyInstance {
    config: ServerConfig;
  }
}

async function storage(app: FastifyInstance, options: { schema?: "accounts" | "platform" }) {
  const config = app.hasDecorator("config") ? app.config : await loadConfig();
  if (!app.hasDecorator("config")) app.decorate("config", config);
  fs.mkdirSync(config.dataDir, { recursive: true });
  await initMetaDb(config.dataDir, { schema: options.schema });
}

export const storagePlugin = fp(storage, { name: "storage" });
