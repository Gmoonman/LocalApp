import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { registerAuthenticationRoutes, type AuthenticationHost } from "@localapp/dsh-multiuser/auth-routes";
import { VERIFICATION_ME_COOKIE } from "../lib/verification-sessions.js";
import { findUserByName, findUserById, updateUserPasswordAndRevokeSessions, validateApiKey } from "../lib/meta-sqlite.js";
import { clearAuthSessionCookie, createAuthSessionForUserVersion, revokeAuthSession, setAuthSessionCookie } from "../lib/auth-sessions.js";

export function createAuthenticationHost(app: FastifyInstance): AuthenticationHost {
  return {
    findUserByName, findUserById, updateUserPasswordAndRevokeSessions,
    createAuthSessionForUserVersion, setAuthSessionCookie, validateApiKey,
    comparePassword: (password, hash) => bcrypt.compare(password, hash),
    hashPassword: (password, rounds) => bcrypt.hash(password, rounds),
    visitorId: req => req.visitorId,
    logout(req, reply) {
      if (req.authSessionTokenHash) revokeAuthSession(req.authSessionTokenHash);
      clearAuthSessionCookie(req, reply);
    },
    verificationUser(req) {
      const verification = app.verificationSessions?.resolveFromFormalReferer(req.cookies?.[VERIFICATION_ME_COOKIE], req.headers.referer);
      return verification ? {
        id: verification.actorId, name: verification.actorName, role: "user",
        verificationIdentity: verification.identity, displayName: verification.actorName,
        avatarUrl: null, bio: null,
      } : undefined;
    },
  };
}

export async function authRoutes(app: FastifyInstance) {
  return registerAuthenticationRoutes(app, createAuthenticationHost(app));
}
