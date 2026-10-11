import { registerPlatformData, type PlatformDataHost } from "@localapp/dsh-app-platform/platform-data-routes";
import type { FastifyInstance } from "fastify";
import { findGroupById, findUserById, listAllUsersPlatform, listSystemGroups, validateApiKey } from "../lib/meta-sqlite.js";
export function createPlatformDataHost(): PlatformDataHost {
  return { users: listAllUsersPlatform, user: findUserById, groups: listSystemGroups, group: findGroupById,
    allow: request => { const key = request.headers["x-api-key"]; return Boolean(typeof key === "string" && validateApiKey(key) || request.visitorId); } };
}
export async function platformDataRoutes(app: FastifyInstance) { return registerPlatformData(app, createPlatformDataHost()); }
