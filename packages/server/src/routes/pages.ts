import type { FastifyInstance } from "fastify";
import { registerApplicationPages, type ApplicationPagesHost } from "@localapp/dsh-app-platform/pages-routes";
import { deleteAppObjects } from "../lib/s3-client.js";

export function createApplicationPagesHost(app: FastifyInstance): ApplicationPagesHost {
  return {
    dataDir: app.config.dataDir,
    deleteAppObjects: (owner, name) => deleteAppObjects(owner, name),
    userId: request => (request as { userId: string }).userId,
  };
}

export async function pagesRoutes(app: FastifyInstance) {
  await registerApplicationPages(app, createApplicationPagesHost(app));
}
