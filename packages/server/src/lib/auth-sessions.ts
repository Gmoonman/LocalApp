import { AuthSessionStore } from "@localapp/dsh-multiuser/auth-sessions";
export { AUTH_SESSION_MAX_AGE_SECONDS, AUTH_SESSION_MAX_AGE_MS, AUTH_SESSION_REFRESH_INTERVAL_MS } from "@localapp/dsh-multiuser/auth-sessions";
export type { CreatedAuthSession, ResolvedAuthSession } from "@localapp/dsh-multiuser/auth-sessions";
import {
  deleteAuthSession,
  deleteAuthSessionsForUser,
  deleteExpiredAuthSessions,
  findAuthSession,
  insertAuthSession,
  insertAuthSessionForUserVersion,
  updateAuthSessionActivity,
} from "./meta-sqlite.js";

const sessions = new AuthSessionStore({ deleteAuthSession, deleteAuthSessionsForUser, deleteExpiredAuthSessions,
  findAuthSession, insertAuthSession, insertAuthSessionForUserVersion, updateAuthSessionActivity });
export const createAuthSession = sessions.createAuthSession.bind(sessions);
export const createAuthSessionForUserVersion = sessions.createAuthSessionForUserVersion.bind(sessions);
export const resolveAuthSession = sessions.resolveAuthSession.bind(sessions);
export const refreshAuthSession = sessions.refreshAuthSession.bind(sessions);
export const revokeAuthSession = sessions.revokeAuthSession.bind(sessions);
export const revokeUserAuthSessions = sessions.revokeUserAuthSessions.bind(sessions);

export { setAuthSessionCookie, clearAuthSessionCookie } from "@localapp/dsh-multiuser/auth-cookies";
