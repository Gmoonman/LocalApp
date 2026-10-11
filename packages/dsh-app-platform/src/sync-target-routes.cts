import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { AppInstallError } from "./app-installer.cjs";
import { AppDataError } from "./app-data-errors.cjs";
import { AppSyncTarget, targetInstallCode, targetInstallStatus } from "./app-sync-target.cjs";
import { SyncSessionError } from "./sync-session-store.cjs";
import { validateName } from "./validate-name.cjs";
export async function registerSyncTarget(app: FastifyInstance, target: AppSyncTarget, authenticate: (request: FastifyRequest, reply: FastifyReply) => string | null): Promise<void> {
  app.addHook("onRequest", async (_request, reply) => {
    if (!target.active) return reply.status(503).send({ success: false, error: "Synchronization target is stopped", code: "SYNC_TARGET_STOPPED" });
  });
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));

  app.post("/api/peer/sync-sessions", async (request, reply) => {
    const ownerId = authenticate(request, reply);
    if (!ownerId) return;
    try {
      const body = request.body as Record<string, unknown> | null;
      const appName = requiredString(body?.appName, "appName");
      const nameError = validateName(appName);
      if (nameError) throw new SyncSessionError("APP_NAME_INVALID", nameError, 400);
      const mode = body?.mode === "app-only" || body?.mode === "app-and-data" ? body.mode : invalidMode();
      if (body?.protocolVersion !== 2) {
        throw new SyncSessionError("SYNC_PROTOCOL_UNSUPPORTED", "Peer synchronization protocol 2 is required", 409);
      }
      const session = target.create({
        id: requiredString(body?.id, "id"), ownerId,
        mode,
        appName, appVersion: requiredString(body?.appVersion, "appVersion"),
        packageDigest: requiredString(body?.packageDigest, "packageDigest"),
        packageSize: requiredInteger(body?.packageSize, "packageSize"),
        ...(mode === "app-and-data" ? {
          dataDigest: requiredString(body?.dataDigest, "dataDigest"),
          dataSize: requiredInteger(body?.dataSize, "dataSize"),
        } : {}),
      });
      return reply.status(session.status === "created" ? 201 : 200).send({ success: true, data: publicSession(session) });
    } catch (error) { return targetError(reply, error); }
  });

  app.put<{ Params: { id: string } }>("/api/peer/sync-sessions/:id/data", async (request, reply) => {
    const ownerId = authenticate(request, reply);
    if (!ownerId) return;
    try {
      const length = Number(request.headers["content-length"]);
      if (!Number.isSafeInteger(length) || length < 0) throw new SyncSessionError("SYNC_CONTENT_LENGTH_REQUIRED", "A valid Content-Length is required", 411);
      const session = await target.receiveData({
        id: request.params.id, ownerId, stream: request.body as Readable, contentLength: length,
      });
      return { success: true, data: publicSession(session) };
    } catch (error) { return targetError(reply, error); }
  });

  app.put<{ Params: { id: string } }>("/api/peer/sync-sessions/:id/package", async (request, reply) => {
    const ownerId = authenticate(request, reply);
    if (!ownerId) return;
    try {
      const length = Number(request.headers["content-length"]);
      if (!Number.isSafeInteger(length) || length < 0) throw new SyncSessionError("SYNC_CONTENT_LENGTH_REQUIRED", "A valid Content-Length is required", 411);
      const session = await target.receivePackage({
        id: request.params.id, ownerId, stream: request.body as Readable, contentLength: length,
      });
      return { success: true, data: publicSession(session) };
    } catch (error) { return targetError(reply, error); }
  });

  app.post<{ Params: { id: string } }>("/api/peer/sync-sessions/:id/commit", async (request, reply) => {
    const ownerId = authenticate(request, reply);
    if (!ownerId) return;
    try {
      const result = await target.commit(request.params.id, ownerId);
      return { success: true, data: { session: publicSession(result.session), outcome: result.outcome, backupId: result.backupId } };
    } catch (error) { return targetError(reply, error); }
  });

  app.delete<{ Params: { id: string } }>("/api/peer/sync-sessions/:id", async (request, reply) => {
    const ownerId = authenticate(request, reply);
    if (!ownerId) return;
    try {
      if (!target.sessions.remove(request.params.id, ownerId)) return reply.status(404).send({ success: false, error: "Synchronization session not found" });
      return reply.status(204).send();
    } catch (error) { return targetError(reply, error); }
  });
}

function publicSession(session: { id: string; mode: string; appName: string; appVersion: string; packageDigest: string; packageSize: number; dataDigest: string | null; dataSize: number | null; status: string; outcome: unknown; error: string | null; createdAt: string; updatedAt: string }) {
  return { id: session.id, mode: session.mode, appName: session.appName, appVersion: session.appVersion, packageDigest: session.packageDigest, packageSize: session.packageSize, dataDigest: session.dataDigest, dataSize: session.dataSize, status: session.status, outcome: session.outcome, error: session.error, createdAt: session.createdAt, updatedAt: session.updatedAt };
}

function targetError(reply: FastifyReply, error: unknown) {
  return reply.status(targetInstallStatus(error)).send({
    success: false, code: targetInstallCode(error),
    error: error instanceof AppInstallError || error instanceof AppDataError || error instanceof SyncSessionError ? error.message : "Synchronization request failed",
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new SyncSessionError("SYNC_METADATA_INVALID", `${field} is required`, 400);
  return value.trim();
}
function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new SyncSessionError("SYNC_METADATA_INVALID", `${field} must be an integer`, 400);
  return value as number;
}
function invalidMode(): never { throw new SyncSessionError("SYNC_MODE_UNSUPPORTED", "Unsupported synchronization mode", 400); }
