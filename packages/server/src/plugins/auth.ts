import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { initMetaDb, validateApiKey, getUserRole, findUserById } from "../lib/meta-sqlite.js";

import { resolveAuthSession } from "../lib/auth-sessions.js";
import { resolveRequestUser as resolveIdentity, registerUserAuthentication, registerAdministratorAuthentication, registerCliVersionCheck, type RequestUserResolution } from "@localapp/dsh-multiuser/request-identity";
export type { RequestUserResolution } from "@localapp/dsh-multiuser/request-identity";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

function validateExistingAccountKey(key: string): string | null {
  const userId = validateApiKey(key);
  return userId && findUserById(userId) ? userId : null;
}

export function resolveRequestUser(req: FastifyRequest): RequestUserResolution {
  return resolveIdentity({ apiKey: req.headers["x-api-key"], visitorId: req.visitorId }, { validateApiKey: validateExistingAccountKey });
}

/** Re-read the original credentials for connections that outlive admission. */
export function isRequestUserAuthenticated(request: FastifyRequest, userId: string): boolean {
  if (!findUserById(userId)) return false;
  const key = request.headers["x-api-key"];
  if (typeof key === "string") return validateApiKey(key) === userId;
  const token = request.cookies?.token;
  return typeof token === "string" && resolveAuthSession(token)?.userId === userId;
}

export function requireRequestUser(
  req: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const resolution = resolveRequestUser(req);
  if (resolution.ok) return resolution.userId;

  reply.status(401).send({
    success: false,
    error: resolution.reason === "invalid-api-key"
      ? "Invalid API key"
      : "Authentication required",
  });
  return null;
}

export async function authPlugin(app: FastifyInstance) {
  const config = app.config;
  await initMetaDb(config.dataDir);

  registerUserAuthentication(app, {
    validateApiKey: validateExistingAccountKey, getUserRole,
    visitorId: request => request.visitorId,
    setUserId: (request, userId) => { request.userId = userId; },
  });
}

export async function adminAuth(app: FastifyInstance) {
  registerAdministratorAuthentication(app, {
    validateApiKey: validateExistingAccountKey, getUserRole,
    visitorId: request => request.visitorId,
    setUserId: (request, userId) => { request.userId = userId; },
  });
}

export function registerVersionCheck(app: FastifyInstance) {
  registerCliVersionCheck(app, { minVersion: app.config.minCliVersion, visitorId: request => request.visitorId });
}
