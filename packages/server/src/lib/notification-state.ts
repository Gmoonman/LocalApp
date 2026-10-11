import { createNotificationServices } from "@localapp/dsh-app-platform/notification-services";
import { getDb, flushMetaDb } from "./meta-sqlite.js";
import { wsManager } from "./ws-manager.js";
export const notificationServices = createNotificationServices({ database: getDb, flush: flushMetaDb },
  (userId, message) => wsManager.sendToUser(userId, message));
