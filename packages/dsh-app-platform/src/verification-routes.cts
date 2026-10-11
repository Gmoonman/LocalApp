import type { FastifyInstance, FastifyRequest } from "fastify";
import { readPageMeta, getPageDir } from "./page-storage.cjs";
import {
  VERIFICATION_APP_COOKIE,
  VERIFICATION_ME_COOKIE,
  VERIFICATION_SHELL_COOKIE,
  VerificationSessionError,
  type VerificationIdentity,
  type VerificationCheck,
} from "./verification-sessions.cjs";
import type { VerificationSessionStore } from "./verification-sessions.cjs";
import type {} from "@fastify/cookie";

export interface VerificationRoutesHost {
  dataDir: string;
  sessions: VerificationSessionStore;
  keyOwner(key: string): string | null;
  publicOrigin(request: FastifyRequest): string | null;
}
export async function registerVerification(app: FastifyInstance, host: VerificationRoutesHost) {
  const { keyOwner: validateApiKey, publicOrigin: requestPublicOrigin } = host;
  app.post("/api/verification/sessions", async (req, reply) => {
    const apiKey = req.headers["x-api-key"];
    const requester = typeof apiKey === "string" ? validateApiKey(apiKey) : null;
    if (!requester) return reply.status(401).send({ success: false, error: "Valid owner API key required" });

    const body = req.body as Record<string, unknown> | undefined;
    const owner = typeof body?.owner === "string" ? body.owner : "";
    const appName = typeof body?.app === "string" ? body.app : "";
    const identity = body?.identity as VerificationIdentity;
    const version = typeof body?.version === "number" ? body.version : Number(body?.version);
    if (!owner || !appName || !["owner", "member"].includes(identity) || !Number.isInteger(version)) {
      return reply.status(400).send({ success: false, error: "owner, app, version, and identity are required" });
    }
    if (requester !== owner) return reply.status(403).send({ success: false, error: "Only the app owner can create verification sessions" });

    const meta = readPageMeta(host.dataDir, owner, appName);
    if (!meta) return reply.status(404).send({ success: false, error: "Page not found" });
    if (!meta.versions.some((entry) => entry.version === version)) {
      return reply.status(404).send({ success: false, error: "App version not found" });
    }

    try {
      const created = await host.sessions.create({
        owner,
        app: appName,
        version,
        identity,
        ttlSeconds: typeof body?.ttlSeconds === "number" ? body.ttlSeconds : undefined,
        pageDir: getPageDir(host.dataDir, owner, appName),
      });
      const openPath = `/api/verification/open/${created.openToken}`;
      const origin = requestPublicOrigin(req);
      const openUrl = origin ? `${origin}${openPath}` : openPath;
      return reply.status(201).send({
        success: true,
        data: {
          id: created.id,
          owner: created.owner,
          app: created.app,
          version: created.version,
          identity: created.identity,
          expiresAt: created.expiresAt,
          openUrl,
        },
      });
    } catch (error) {
      return sendVerificationError(reply, error);
    }
  });

  app.get<{ Params: { token: string } }>("/api/verification/open/:token", async (req, reply) => {
    try {
      const { context, cookieToken } = host.sessions.exchange(req.params.token);
      const maxAge = Math.max(1, Math.floor((Date.parse(context.expiresAt) - Date.now()) / 1000));
      const common = {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: requestPublicOrigin(req)?.startsWith("https://") ?? false,
        maxAge,
      };
      reply.setCookie(VERIFICATION_SHELL_COOKIE, cookieToken, {
        ...common,
        path: `/${context.owner}/${context.app}`,
      });
      reply.setCookie(VERIFICATION_APP_COOKIE, cookieToken, {
        ...common,
        path: `/serve/${context.owner}/${context.app}`,
      });
      reply.setCookie(VERIFICATION_ME_COOKIE, cookieToken, {
        ...common,
        path: "/api/me",
      });
      return reply.redirect(`/${context.owner}/${context.app}/`, 302);
    } catch (error) {
      return sendVerificationError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/verification/sessions/:id", async (req, reply) => {
    const apiKey = req.headers["x-api-key"];
    const requester = typeof apiKey === "string" ? validateApiKey(apiKey) : null;
    if (!requester) return reply.status(401).send({ success: false, error: "Valid owner API key required" });
    const session = host.sessions.get(req.params.id);
    if (!session) return reply.status(404).send({ success: false, error: "Verification session not found" });
    if (session.owner !== requester) return reply.status(403).send({ success: false, error: "Access denied" });
    const { databasePath: _databasePath, actorId: _actorId, ...publicSession } = session;
    return { success: true, data: publicSession };
  });

  app.post<{ Params: { id: string } }>("/api/verification/sessions/:id/report", async (req, reply) => {
    const apiKey = req.headers["x-api-key"];
    const requester = typeof apiKey === "string" ? validateApiKey(apiKey) : null;
    if (!requester) return reply.status(401).send({ success: false, error: "Valid owner API key required" });
    const session = host.sessions.get(req.params.id);
    if (!session) return reply.status(404).send({ success: false, error: "Verification session not found" });
    if (session.owner !== requester) return reply.status(403).send({ success: false, error: "Access denied" });
    const report = parseVerificationReport(req.body);
    if (!report) return reply.status(400).send({ success: false, error: "status and valid checks are required" });
    try {
      host.sessions.report(session, report);
      return { success: true, data: { id: session.id, status: report.status } };
    } catch (error) {
      return sendVerificationError(reply, error);
    }
  });
}

function parseVerificationReport(body: unknown): { status: "passed" | "failed"; checks: VerificationCheck[] } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (!["passed", "failed"].includes(String(value.status)) || !Array.isArray(value.checks)) return null;
  const checks = value.checks.filter(isVerificationCheck);
  if (checks.length !== value.checks.length) return null;
  return { status: value.status as "passed" | "failed", checks };
}

function isVerificationCheck(value: unknown): value is VerificationCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const check = value as Record<string, unknown>;
  return ["http", "api", "dom", "console", "interaction", "identity"].includes(String(check.phase))
    && ["passed", "failed", "pending"].includes(String(check.status))
    && typeof check.summary === "string"
    && (check.suggestion === undefined || typeof check.suggestion === "string");
}

function sendVerificationError(reply: any, error: unknown) {
  if (error instanceof VerificationSessionError) {
    return reply.status(error.status).send({ success: false, error: error.message, code: error.code });
  }
  return reply.status(500).send({ success: false, error: error instanceof Error ? error.message : "Verification session failed" });
}
