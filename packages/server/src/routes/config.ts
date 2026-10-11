import { FastifyInstance } from "fastify";
import type { ApplicationDevelopment } from "@localapp/dsh-app-development" with { "resolution-mode": "import" };

export async function configRoutes(app: FastifyInstance, options: {development: ApplicationDevelopment}) {
  return options.development.registerConfiguration(app, app.config);
}
