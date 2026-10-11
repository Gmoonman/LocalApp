import type { FastifyInstance } from "fastify";
import path from "node:path";
import { registerDependencyRoutes } from "@localapp/dsh-multiuser/dependency-routes";

/** Compatibility adapter; dependency routes belong to the multiuser plugin. */
export async function depsRoutes(app: FastifyInstance) {
  return registerDependencyRoutes(app, path.resolve(process.cwd(), "static", "deps"));
}
