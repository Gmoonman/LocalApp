import type { FastifyInstance } from "fastify";
import { registerDeviceNotifications, type DeviceNotificationRoutesHost } from "@localapp/dsh-app-platform/device-notifications-routes";
import type { DeviceNotificationSourceStore } from "../lib/device-notification-source-store.js";
import { getUserRole } from "../lib/meta-sqlite.js";
import { requestPublicOrigin } from "../lib/request-origin.js";
import { requireRequestUser } from "../plugins/auth.js";
export { parseDeviceNotificationJson } from "@localapp/dsh-app-platform/device-notifications-routes";
export function createDeviceNotificationRoutesHost(app: FastifyInstance): DeviceNotificationRoutesHost {
  return { config: app.config, requireUser: requireRequestUser, userRole: getUserRole, publicOrigin: requestPublicOrigin };
}
export async function deviceNotificationsRoutes(app: FastifyInstance, store: DeviceNotificationSourceStore): Promise<void> {
  return registerDeviceNotifications(app, store, createDeviceNotificationRoutesHost(app));
}
