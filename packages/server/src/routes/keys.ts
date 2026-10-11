import type { FastifyInstance } from "fastify";
import { registerKeyRoutes, type KeyRoutesHost } from "@localapp/dsh-multiuser/keys-routes";
import { createApiKey, getUserRole, listApiKeysByUser } from "../lib/meta-sqlite.js";
export function createKeyRoutesHost(): KeyRoutesHost {
  return { createApiKey, getUserRole, listApiKeysByUser, userId: req => req.userId };
}
export async function keysRoutes(app: FastifyInstance) {
  return registerKeyRoutes(app, createKeyRoutesHost());
}
