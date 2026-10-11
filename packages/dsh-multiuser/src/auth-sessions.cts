import { createHash, randomBytes } from "node:crypto";
export const AUTH_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const AUTH_SESSION_MAX_AGE_MS = AUTH_SESSION_MAX_AGE_SECONDS * 1000;
export const AUTH_SESSION_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CreatedAuthSession {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface ResolvedAuthSession {
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  shouldRefresh: boolean;
}

export interface AuthSessionRecord {
  tokenHash: string; userId: string; createdAt: string; lastSeenAt: string; expiresAt: string;
}
export interface AuthSessionPersistence {
  deleteAuthSession(hash: string): boolean;
  deleteAuthSessionsForUser(userId: string): number;
  deleteExpiredAuthSessions(now: string): number;
  findAuthSession(hash: string): AuthSessionRecord | null;
  insertAuthSession(record: AuthSessionRecord): void;
  insertAuthSessionForUserVersion(record: AuthSessionRecord, version: number, generation: string): boolean;
  updateAuthSessionActivity(hash: string, seen: string, expires: string): boolean;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthSessionStore {
  constructor(private readonly persistence: AuthSessionPersistence) {}
  createAuthSession(userId: string, now = new Date()): CreatedAuthSession {
    const session = this.prepareAuthSession(userId, now);
    this.persistence.deleteExpiredAuthSessions(now.toISOString());
    this.persistence.insertAuthSession(this.toRecord(session, userId, now));
    return session;
  }

  createAuthSessionForUserVersion(
    userId: string,
    authVersion: number,
    authGeneration: string,
    now = new Date(),
  ): CreatedAuthSession | null {
    const session = this.prepareAuthSession(userId, now);
    this.persistence.deleteExpiredAuthSessions(now.toISOString());
    return this.persistence.insertAuthSessionForUserVersion(this.toRecord(session, userId, now), authVersion, authGeneration)
      ? session
      : null;
  }

  private prepareAuthSession(userId: string, now: Date): CreatedAuthSession {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(now.getTime() + AUTH_SESSION_MAX_AGE_MS);
    return { token, tokenHash, expiresAt };
  }

  private toRecord(session: CreatedAuthSession, userId: string, now: Date) {
    const timestamp = now.toISOString();
    return {
      tokenHash: session.tokenHash,
      userId,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  resolveAuthSession(token: string, now = new Date()): ResolvedAuthSession | null {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = this.persistence.findAuthSession(tokenHash);
    if (!session) return null;

    const expiresAt = new Date(session.expiresAt);
    if (expiresAt.getTime() <= now.getTime()) {
      this.persistence.deleteAuthSession(tokenHash);
      return null;
    }

    const lastSeenAt = new Date(session.lastSeenAt);
    return {
      tokenHash,
      userId: session.userId,
      expiresAt,
      shouldRefresh: now.getTime() - lastSeenAt.getTime() >= AUTH_SESSION_REFRESH_INTERVAL_MS,
    };
  }

  refreshAuthSession(tokenHash: string, now = new Date()): { expiresAt: Date } | null {
    const session = this.persistence.findAuthSession(tokenHash);
    if (!session || new Date(session.expiresAt).getTime() <= now.getTime()) {
      if (session) this.persistence.deleteAuthSession(tokenHash);
      return null;
    }

    const expiresAt = new Date(now.getTime() + AUTH_SESSION_MAX_AGE_MS);
    const updated = this.persistence.updateAuthSessionActivity(tokenHash, now.toISOString(), expiresAt.toISOString());
    return updated ? { expiresAt } : null;
  }

  revokeAuthSession(tokenHash: string): boolean {
    return this.persistence.deleteAuthSession(tokenHash);
  }

  revokeUserAuthSessions(userId: string): number {
    return this.persistence.deleteAuthSessionsForUser(userId);
  }

}
