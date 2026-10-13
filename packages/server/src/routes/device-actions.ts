import type { FastifyInstance } from "fastify";
import { createDeviceActionRoutes } from "@localapp/dsh-device-services/device-actions-routes";
import { createDeviceActionStore } from "@localapp/dsh-device-services/desktop-actions-db";
import { getDb, flushMetaDb, findUserById, validateApiKey } from "../lib/meta-sqlite.js";
import { requireRequestUser } from "../plugins/auth.js";
import { guardTimerCallback } from "../lib/timer-guard.js";
const contributions = new WeakMap<FastifyInstance["server"], ReturnType<typeof createDeviceActionRoutes>>();
export function deviceActionContribution(app: FastifyInstance, factory: typeof createDeviceActionRoutes = createDeviceActionRoutes) {
  let contribution = contributions.get(app.server);
  if (!contribution) {
    contribution = factory({ config: app.config,
      store: createDeviceActionStore({ database: getDb, flush: flushMetaDb }),
      visitor: request => request.visitorId, requireUser: requireRequestUser,
      keyOwner: validateApiKey, user: findUserById, guardTimer: guardTimerCallback });
    contributions.set(app.server, contribution);
  }
  return contribution;
}
export async function deviceActionsRoutes(app: FastifyInstance) { return deviceActionContribution(app).register(app); }
export const handleDeviceActionCreation: ReturnType<typeof createDeviceActionRoutes>["handleDeviceActionCreation"] = (request, ...args) => deviceActionContribution(request.server).handleDeviceActionCreation(request, ...args);
