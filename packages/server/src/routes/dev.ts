import type { FastifyInstance } from "fastify";
import { createDevToolkit } from "@localapp/dsh-app-development/dev-toolkit-routes";
import { findUserById, listAllUsersBasic, validateApiKey } from "../lib/meta-sqlite.js";
import { listRecentRequestLogs } from "../lib/request-logger.js";
const contributions = new WeakMap<FastifyInstance["server"], ReturnType<typeof createDevToolkit>>();
export function devToolkitContribution(app: FastifyInstance, factory: typeof createDevToolkit = createDevToolkit) {
  let contribution = contributions.get(app.server);
  if (!contribution) {
    contribution = factory({ dataDir: app.config.dataDir, user: findUserById, users: listAllUsersBasic,
      keyOwner: validateApiKey, userId: request => request.userId, recentRequests: listRecentRequestLogs,
      setIdentity(request, user) {
        request.visitorId = user?.id ?? null; request.visitorName = user?.name ?? null;
        request.visitorRole = user?.role === "admin" ? "admin" : user ? "user" : null; request.userId = user?.id ?? "";
      } });
    contributions.set(app.server, contribution);
  }
  return contribution;
}
export async function installDevRequestContext(app: FastifyInstance): Promise<void> { return devToolkitContribution(app).installRequestContext(app); }
export async function devRoutes(app: FastifyInstance): Promise<void> { return devToolkitContribution(app).register(app); }
