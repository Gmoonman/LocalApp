import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { registerBrowserSessions, type BrowserSessionHost } from "@localapp/dsh-multiuser/browser-sessions";
import { findUserById } from "../lib/meta-sqlite.js";
import { refreshAuthSession, resolveAuthSession, revokeAuthSession } from "../lib/auth-sessions.js";
export function createBrowserSessionHost(): BrowserSessionHost {
  return {
    token: req => req.cookies?.token,
    findUserById, refreshAuthSession, resolveAuthSession, revokeAuthSession,
  };
}
async function session(app: FastifyInstance) {
  return registerBrowserSessions(app, createBrowserSessionHost());
}
export const sessionPlugin = fp(session, { name: "session" });
