import type { FastifyInstance } from "fastify";
import { registerApplicationSchemas, type ApplicationSchemaHost } from "@localapp/dsh-app-platform/schemas-routes";
export function createApplicationSchemaHost(app: FastifyInstance): ApplicationSchemaHost {
  return { dataDir: app.config.dataDir, userId: req => req.userId };
}
export async function schemasRoutes(app: FastifyInstance) {
  await registerApplicationSchemas(app, createApplicationSchemaHost(app));
}
