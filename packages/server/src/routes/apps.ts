import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApplicationInstallHost } from "@localapp/dsh-app-platform/install-routes";
import { findUserById } from "../lib/meta-sqlite.js";

export function createApplicationInstallHost(app: FastifyInstance): ApplicationInstallHost {
  return {
    dataDir: app.config.dataDir,
    userId: request => (request as FastifyRequest).userId,
    user: findUserById,
  };
}
