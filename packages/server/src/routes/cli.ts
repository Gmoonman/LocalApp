import type { FastifyInstance } from "fastify";
import { createCliRoutes as createRoutes, type CliRouteOptions } from "@localapp/dsh-app-development/cli-routes";
import { authPlugin } from "../plugins/auth.js";
type Options = Omit<CliRouteOptions, "manifestUrl">;
export function createCliRoutes(options: Options = {}) {
  return async (app: FastifyInstance) => createRoutes({ ...options, manifestUrl: app.config.releaseManifestUrl })(app);
}
export function createAuthenticatedCliRoutes(options: Options = {}) {
  return async (app: FastifyInstance) => {
    await authPlugin(app);
    app.register(createCliRoutes(options));
  };
}
export const cliRoutes = createCliRoutes();
export const authenticatedCliRoutes = createAuthenticatedCliRoutes();
