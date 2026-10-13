import type { FastifyInstance } from "fastify";
import { createDesktopActionRoutes } from "@localapp/dsh-device-services/desktop-actions-routes";
import { createDeviceActionStore } from "@localapp/dsh-device-services/desktop-actions-db";
import { getDb, flushMetaDb, findUserById, validateApiKey } from "../lib/meta-sqlite.js";
import { requireRequestUser } from "../plugins/auth.js";
import { guardTimerCallback } from "../lib/timer-guard.js";
import { DESKTOP_ACTION_PROTOCOL_VERSION, wsManager } from "../lib/ws-manager.js";
const contributions = new WeakMap<FastifyInstance["server"], ReturnType<typeof createDesktopActionRoutes>>();
export function desktopActionContribution(app: FastifyInstance, factory: typeof createDesktopActionRoutes = createDesktopActionRoutes) {
  let contribution = contributions.get(app.server);
  if (!contribution) {
    contribution = factory({ protocolVersion: DESKTOP_ACTION_PROTOCOL_VERSION, connection: wsManager,
      store: createDeviceActionStore({ database: getDb, flush: flushMetaDb }),
      visitor: request => request.visitorId, requireUser: requireRequestUser,
      keyOwner: validateApiKey, user: findUserById, guardTimer: guardTimerCallback });
    contributions.set(app.server, contribution);
  }
  return contribution;
}
export async function desktopActionsRoutes(app: FastifyInstance) { return desktopActionContribution(app).register(app); }
export const handleDesktopActionCreation: ReturnType<typeof createDesktopActionRoutes>["handleDesktopActionCreation"] = (request, ...args) => desktopActionContribution(request.server).handleDesktopActionCreation(request, ...args);
