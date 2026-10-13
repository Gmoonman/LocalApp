import type { FastifyInstance } from "fastify";
import path from "node:path";
import {getPageDir} from "@localapp/dsh-app-platform/page-storage";
import {getDbPath} from "@localapp/dsh-app-platform/app-db";
import { registerApplicationEntry, type ApplicationEntryHost } from "@localapp/dsh-app-platform/application-entry-routes";
import { pushPageView } from "../lib/request-logger.js";
import { listUsers, validateApiKey, findUserById } from "../lib/meta-sqlite.js";
import { resolveRecipients, persistNotifications } from "../lib/notifications-db.js";
import { putObject, getObject, openObject } from "../lib/s3-client.js";
import { handleDesktopActionCreation } from "./desktop-actions.js";
import { handleDeviceActionCreation } from "./device-actions.js";
export function createApplicationEntryHost(app: FastifyInstance, options: { webRoot?: string } = {}): ApplicationEntryHost {
  return { webRoot: options.webRoot ?? path.resolve(__dirname, "../../../web/out"),
    dataDir: request => request?.developmentPreview?.dataDir ?? app.config.dataDir,
    previewData: request => {
      const preview = request.developmentPreview;
      return preview?.productionOwner
        ? { databasePath: getDbPath(getPageDir(app.config.dataDir,preview.productionOwner,preview.app)), ownerId: preview.productionOwner, readSource: preview.readSource ?? preview.dataMode ?? "test", writeSource: preview.writeSource ?? "test" } : undefined;
    },
    visitorId: request => request.visitorId, visitorName: request => request.visitorName,
    userId: request => request.userId, now: request => request.devNow,
    keyOwner: validateApiKey, user: findUserById, userCount: () => listUsers(1, 1).total,
    pushPageView, notifications: { resolveRecipients, persistNotifications }, storage: { putObject, getObject, openObject },
    sessions: app.verificationSessions, desktopAction: handleDesktopActionCreation, deviceAction: handleDeviceActionCreation };
}
export async function serveRoutes(app: FastifyInstance, options: { webRoot?: string } = {}) { return registerApplicationEntry(app, createApplicationEntryHost(app, options)); }
