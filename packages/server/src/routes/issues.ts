import { deleteObject, getObject, putObject } from "../lib/s3-client.js";
import type { FastifyInstance } from "fastify";
import { registerIssues, type IssueRoutesHost } from "@localapp/dsh-app-platform/issues-routes";
import { createSavedReply, deleteSavedReply, listSavedReplies, updateSavedReply, findUserById } from "../lib/meta-sqlite.js";
import { persistNotifications } from "../lib/notifications-db.js";
export function createIssueRoutesHost(app: FastifyInstance): IssueRoutesHost {
  return { storage: { deleteObject, getObject, putObject }, dataDir: app.config.dataDir, visitor: request => request.visitorId, userExists: id => Boolean(findUserById(id)),
    persistNotifications, createSavedReply, deleteSavedReply, listSavedReplies, updateSavedReply };
}
export async function issuesRoutes(app: FastifyInstance) { return registerIssues(app, createIssueRoutesHost(app)); }
