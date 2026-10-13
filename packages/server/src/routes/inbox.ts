import type { FastifyInstance } from "fastify";
import { registerApplicationInbox, type ApplicationInboxHost } from "@localapp/dsh-device-services/inbox-routes";
export { parseDeliveryQuery, type ParsedDeliveryQuery } from "@localapp/dsh-device-services/inbox-routes";
import { listInbox, getUnreadCount, markRead, softDelete, markAllRead, getInboxItem } from "../lib/notifications-db.js";
import { listDeliverableNotifications } from "../lib/notification-delivery.js";
import { requireRequestUser } from "../plugins/auth.js";
export function createApplicationInboxHost(): ApplicationInboxHost {
  return { listInbox, getUnreadCount, markRead, softDelete, markAllRead, getInboxItem,
    listDeliverableNotifications, requireRequestUser };
}
export async function inboxRoutes(app: FastifyInstance) {
  await registerApplicationInbox(app, createApplicationInboxHost());
}
