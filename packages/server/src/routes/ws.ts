import type { FastifyInstance } from "fastify";
import { registerWebSocket, type WebSocketRoutesHost } from "@localapp/dsh-app-platform/ws-routes";
import { validateApiKey } from "../lib/meta-sqlite.js";
import { getUnreadInboxItems } from "../lib/notifications-db.js";
import { getNotificationDeliveryHighWater } from "../lib/notification-delivery.js";
import { wsManager } from "../lib/ws-manager.js";
export { MAX_WS_INSTALLATION_ID_LENGTH, parseWsConnectionMetadata, buildWsReadyMessage, shouldSendLegacyMissed } from "@localapp/dsh-app-platform/ws-routes";
export function createWebSocketHost(): WebSocketRoutesHost {
  return { connections: wsManager, keyOwner: validateApiKey, unread: getUnreadInboxItems, highWater: getNotificationDeliveryHighWater };
}
export async function wsRoutes(app: FastifyInstance) { return registerWebSocket(app, createWebSocketHost()); }
