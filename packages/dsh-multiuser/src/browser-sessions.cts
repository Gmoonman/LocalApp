import type {} from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { clearAuthSessionCookie, setAuthSessionCookie } from "./auth-cookies.cjs";
import type { ResolvedAuthSession } from "./auth-sessions.cjs";
export interface BrowserSessionHost {
  token(req: FastifyRequest): string | undefined;
  findUserById(id: string): { id: string; name: string; role: "admin" | "user" } | null;
  resolveAuthSession(token: string): ResolvedAuthSession | null;
  refreshAuthSession(hash: string): { expiresAt: Date } | null;
  revokeAuthSession(hash: string): boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    visitorId?: string | null;
    visitorName?: string | null;
    visitorRole?: "admin" | "user" | null;
    authSessionTokenHash?: string | null;
  }
}

export async function registerBrowserSessions(app: FastifyInstance, host: BrowserSessionHost) {
  const { findUserById, resolveAuthSession, refreshAuthSession, revokeAuthSession } = host;
  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    const token = host.token(req);
    if (!token) {
      req.visitorId = null;
      req.visitorName = null;
      req.visitorRole = null;
      req.authSessionTokenHash = null;
      return;
    }

    const resolved = resolveAuthSession(token);
    if (!resolved) {
      req.visitorId = null;
      req.visitorName = null;
      req.visitorRole = null;
      req.authSessionTokenHash = null;
      clearAuthSessionCookie(req, reply);
      return;
    }

    const user = findUserById(resolved.userId);
    if (!user) {
      revokeAuthSession(resolved.tokenHash);
      req.visitorId = null;
      req.visitorName = null;
      req.visitorRole = null;
      req.authSessionTokenHash = null;
      clearAuthSessionCookie(req, reply);
      return;
    }

    req.visitorId = user.id;
    req.visitorName = user.name;
    req.visitorRole = user.role;
    req.authSessionTokenHash = resolved.tokenHash;

    if (resolved.shouldRefresh) {
      const refreshed = refreshAuthSession(resolved.tokenHash);
      if (refreshed) setAuthSessionCookie(req, reply, token, refreshed.expiresAt);
    }
  });
}

