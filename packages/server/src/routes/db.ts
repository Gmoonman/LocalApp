import type { FastifyInstance } from "fastify";
import type { ApplicationDatabaseHost } from "@localapp/dsh-app-platform/db-routes";
export function createApplicationDatabaseHost(app: FastifyInstance): ApplicationDatabaseHost {
  return { dataDir: app.config.dataDir, userId: req => req.userId };
}
