import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { evictConnectionForDbPath, exportDatabaseSnapshot, getDbPath } from "./app-db.cjs";
import { PLATFORM_CAPABILITIES } from "./platform-capabilities.cjs";

export const VERIFICATION_SHELL_COOKIE = "localapp_verify_shell";
export const VERIFICATION_APP_COOKIE = "localapp_verify_app";
export const VERIFICATION_ME_COOKIE = "localapp_verify_me";

export type VerificationIdentity = "owner" | "member";
export type VerificationStatus = "pending" | "opened" | "passed" | "failed" | "expired";

export interface VerificationCheck {
  phase: "http" | "api" | "dom" | "console" | "interaction" | "identity";
  status: "passed" | "failed" | "pending";
  summary: string;
  suggestion?: string;
}

export interface VerificationSessionContext {
  id: string;
  owner: string;
  app: string;
  version: number;
  identity: VerificationIdentity;
  actorId: string;
  actorName: string;
  databasePath: string;
  expiresAt: string;
}

interface AuditEvent {
  event: "created" | "opened" | "reported" | "completed" | "expired";
  at: string;
  sessionId: string;
  owner: string;
  app: string;
}

interface VerificationSession extends VerificationSessionContext {
  tokenHash: string;
  cookieHash: string;
  status: VerificationStatus;
  report: { status: "passed" | "failed"; checks: VerificationCheck[] } | null;
  audit: AuditEvent[];
}

export interface CreateVerificationSessionInput {
  owner: string;
  app: string;
  version: number;
  identity: VerificationIdentity;
  ttlSeconds?: number;
  pageDir: string;
}

export interface CreatedVerificationSession extends VerificationSessionContext {
  openToken: string;
}

const VERIFICATION_CAPABILITIES = PLATFORM_CAPABILITIES.verification;

export class VerificationSessionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class VerificationSessionStore {
  private readonly sessions = new Map<string, VerificationSession>();
  private pendingCreations = 0;
  private readonly rootDir: string;
  private readonly sessionsDir: string;
  private readonly auditPath: string;

  constructor(private readonly dataDir: string) {
    this.rootDir = path.join(dataDir, ".verification");
    this.sessionsDir = path.join(this.rootDir, "sessions");
    this.auditPath = path.join(this.rootDir, "audit.jsonl");
  }

  initialize(): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.rmSync(this.sessionsDir, { recursive: true, force: true });
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  async create(input: CreateVerificationSessionInput): Promise<CreatedVerificationSession> {
    this.cleanupExpired();
    const active = [...this.sessions.values()].filter((session) => session.status === "pending" || session.status === "opened");
    if (active.length + this.pendingCreations >= VERIFICATION_CAPABILITIES.maxConcurrentSessions) {
      throw new VerificationSessionError("Too many active verification sessions", "verification_concurrency_limit", 429);
    }

    this.pendingCreations += 1;
    try {
      return await this.createReserved(input);
    } finally {
      this.pendingCreations -= 1;
    }
  }

  private async createReserved(input: CreateVerificationSessionInput): Promise<CreatedVerificationSession> {
    const sourceDatabase = getDbPath(input.pageDir);
    if (fs.existsSync(sourceDatabase) && fs.statSync(sourceDatabase).size > VERIFICATION_CAPABILITIES.maxDatabaseBytes) {
      throw new VerificationSessionError("Application database exceeds verification copy limit", "verification_database_too_large", 413);
    }
    const snapshot = await exportDatabaseSnapshot(sourceDatabase);
    if (snapshot.byteLength > VERIFICATION_CAPABILITIES.maxDatabaseBytes) {
      throw new VerificationSessionError("Application database exceeds verification copy limit", "verification_database_too_large", 413);
    }

    const id = crypto.randomUUID();
    const openToken = crypto.randomBytes(32).toString("base64url");
    const ttlSeconds = Math.max(
      1,
      Math.min(input.ttlSeconds ?? VERIFICATION_CAPABILITIES.defaultTtlSeconds, VERIFICATION_CAPABILITIES.maxTtlSeconds),
    );
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const sessionDir = path.join(this.sessionsDir, id);
    const databasePath = path.join(sessionDir, "app.db");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(databasePath, snapshot);

    const session: VerificationSession = {
      id,
      owner: input.owner,
      app: input.app,
      version: input.version,
      identity: input.identity,
      actorId: input.identity === "owner" ? input.owner : `verification:member:${id}`,
      actorName: input.identity === "owner" ? "Verification Owner" : "Verification Member",
      databasePath,
      expiresAt,
      tokenHash: digest(openToken),
      cookieHash: "",
      status: "pending",
      report: null,
      audit: [],
    };
    this.sessions.set(id, session);
    this.audit(session, "created");
    return { ...this.publicContext(session), openToken };
  }

  exchange(openToken: string): { context: VerificationSessionContext; cookieToken: string } {
    this.cleanupExpired();
    const tokenHash = digest(openToken);
    const session = [...this.sessions.values()].find((candidate) => candidate.tokenHash === tokenHash);
    if (!session || session.status !== "pending") {
      throw new VerificationSessionError("Verification open token is invalid or already used", "verification_token_consumed", 410);
    }
    session.tokenHash = "";
    session.status = "opened";
    const cookieToken = crypto.randomBytes(32).toString("base64url");
    session.cookieHash = digest(cookieToken);
    this.audit(session, "opened");
    return { context: this.publicContext(session), cookieToken };
  }

  resolve(cookieToken: string | undefined, owner: string, app: string): VerificationSessionContext | null {
    if (!cookieToken) return null;
    this.cleanupExpired();
    const cookieHash = digest(cookieToken);
    const session = [...this.sessions.values()].find((candidate) => candidate.cookieHash === cookieHash);
    if (!session || session.status !== "opened" || session.owner !== owner || session.app !== app) return null;
    return this.publicContext(session);
  }

  resolveFromFormalReferer(cookieToken: string | undefined, referer: string | undefined): VerificationSessionContext | null {
    if (!cookieToken || !referer) return null;
    let pathname: string;
    try {
      pathname = new URL(referer).pathname;
    } catch {
      return null;
    }
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length < 2 || segments[0] === "serve") return null;
    return this.resolve(cookieToken, decodeURIComponent(segments[0]), decodeURIComponent(segments[1]));
  }

  report(
    context: VerificationSessionContext,
    input: { status: "passed" | "failed"; checks: VerificationCheck[] },
  ): void {
    const session = this.sessions.get(context.id);
    if (!session || session.status !== "opened") {
      throw new VerificationSessionError("Verification session is no longer active", "verification_session_inactive", 410);
    }
    session.report = input;
    this.audit(session, "reported");
    session.status = input.status;
    session.cookieHash = "";
    this.removeDatabase(session);
    this.audit(session, "completed");
  }

  get(id: string): (VerificationSessionContext & {
    status: VerificationStatus;
    report: VerificationSession["report"];
    audit: AuditEvent[];
  }) | null {
    this.cleanupExpired();
    const session = this.sessions.get(id);
    if (!session) return null;
    return {
      ...this.publicContext(session),
      status: session.status,
      report: session.report,
      audit: [...session.audit],
    };
  }

  cleanupExpired(now = Date.now()): void {
    for (const session of this.sessions.values()) {
      if ((session.status === "pending" || session.status === "opened") && Date.parse(session.expiresAt) <= now) {
        session.status = "expired";
        session.tokenHash = "";
        session.cookieHash = "";
        this.removeDatabase(session);
        this.audit(session, "expired");
        this.sessions.delete(session.id);
      } else if (!["pending", "opened"].includes(session.status) && Date.parse(session.expiresAt) <= now) {
        this.sessions.delete(session.id);
      }
    }
  }

  private removeDatabase(session: VerificationSession): void {
    evictConnectionForDbPath(session.databasePath);
    fs.rmSync(path.dirname(session.databasePath), { recursive: true, force: true });
  }

  private publicContext(session: VerificationSession): VerificationSessionContext {
    return {
      id: session.id,
      owner: session.owner,
      app: session.app,
      version: session.version,
      identity: session.identity,
      actorId: session.actorId,
      actorName: session.actorName,
      databasePath: session.databasePath,
      expiresAt: session.expiresAt,
    };
  }

  private audit(session: VerificationSession, event: AuditEvent["event"]): void {
    const entry: AuditEvent = {
      event,
      at: new Date().toISOString(),
      sessionId: session.id,
      owner: session.owner,
      app: session.app,
    };
    session.audit.push(entry);
    fs.appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`);
  }
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
