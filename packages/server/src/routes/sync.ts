import { registerSyncSource } from "@localapp/dsh-app-sync/sync-source-routes";
import { registerSyncTarget } from "@localapp/dsh-app-sync/sync-target-routes";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppSyncSource } from "../lib/app-sync-source.js";
import type { AppSyncTarget } from "../lib/app-sync-target.js";
import { validateApiKey } from "../lib/meta-sqlite.js";
export function createSyncTargetAuthentication(request: FastifyRequest, reply: FastifyReply) { return bearerOwner(request, reply); }
export async function syncTargetRoutes(app: FastifyInstance, target: AppSyncTarget) { return registerSyncTarget(app, target, createSyncTargetAuthentication); }
export async function syncSourceRoutes(app: FastifyInstance, source: AppSyncSource) { return registerSyncSource(app, source, request => request.userId); }
function bearerOwner(request: FastifyRequest, reply: FastifyReply): string | null {
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string" ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
  const ownerId = match ? validateApiKey(match[1]) : null;
  if (!ownerId) reply.status(401).send({ success: false, error: "Authentication required" });
  else request.userId = ownerId;
  return ownerId;
}
