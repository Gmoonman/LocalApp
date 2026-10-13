import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { createDeviceActionStore } from "@localapp/dsh-device-services/desktop-actions-db";
import { DESKTOP_ACTION_CLEANUP_INTERVAL_MS, DESKTOP_ACTION_ERROR_MAX_BYTES, DESKTOP_ACTION_RESULT_MAX_BYTES, DESKTOP_ACTION_TERMINAL_RETENTION_MS, type DesktopActionSnapshot, type DesktopActionStatus } from "@localapp/dsh-device-services/desktop-actions-db";
import { validateReferer } from "@localapp/dsh-device-services/notify-referer";
import { resolveVersionPublisher, type PageMeta } from "@localapp/app-foundation/page-storage";
export interface DesktopActionsHost {
  isActive?(): boolean;
  onStop?(cleanup: () => void): void;
  protocolVersion: number;
  store: ReturnType<typeof createDeviceActionStore>;
  visitor(request: FastifyRequest): string | null | undefined;
  requireUser(request: FastifyRequest, reply: FastifyReply): string | null;
  keyOwner(key: string): string | null;
  user(userId: string): { displayName: string | null } | null;
  guardTimer(label: string, callback: () => unknown): () => void;
  connection: {
    sendToDesktopUser(userId: string, data: unknown, minimumProtocolVersion: number): number;
    hasDesktopCapability(userId: string, minimumProtocolVersion: number): boolean;
  };
}
export function createDesktopActionRoutes(host: DesktopActionsHost) {
  const streams = new Set<() => void>();
  const closeStreams = () => { for (const close of [...streams]) close(); };
  host.onStop?.(closeStreams);
  const DESKTOP_ACTION_PROTOCOL_VERSION = host.protocolVersion;
  const { keyOwner: validateApiKey, user: findUserById, requireUser: requireRequestUser, guardTimer: guardTimerCallback, connection: wsManager } = host;
  const { claimDesktopAction, cleanupDesktopActions, createDesktopAction, getDesktopActionSnapshot, listPendingDesktopActions, listRecoverableDesktopActions, transitionDesktopAction } = host.store;
const MAX_INSTALLATION_ID_LENGTH = 128;
const MAX_NONCE_LENGTH = 128;
const DESKTOP_ACTION_STATUS_BODY_LIMIT = DESKTOP_ACTION_RESULT_MAX_BYTES
  + DESKTOP_ACTION_ERROR_MAX_BYTES
  + 4 * 1024;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTION_STATUSES = new Set<DesktopActionStatus>([
  "pending",
  "claimed",
  "awaiting_trust",
  "preparing",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "interrupted",
]);

type DesktopActionSseClient = {
  userId: string;
  requestId: string;
  write: (snapshot: DesktopActionSnapshot) => void;
};

const sseClients = new Set<DesktopActionSseClient>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ success: false, code, error: message });
}

function requireApiKeyUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey !== "string") {
    error(reply, 401, "DESKTOP_ACTION_API_KEY_REQUIRED", "API key required");
    return null;
  }
  const userId = validateApiKey(apiKey);
  if (!userId) {
    error(reply, 401, "DESKTOP_ACTION_INVALID_API_KEY", "Invalid API key");
    return null;
  }
  return userId;
}

function validRequestId(value: string): boolean {
  return value.length <= 128 && REQUEST_ID_PATTERN.test(value);
}

function validBoundedValue(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function publishSnapshot(userId: string, snapshot: DesktopActionSnapshot): void {
  for (const client of sseClients) {
    if (client.userId === userId && client.requestId === snapshot.id) client.write(snapshot);
  }
}

function sendRepositoryError(reply: FastifyReply, err: unknown) {
  const code = err instanceof Error ? err.message : "DESKTOP_ACTION_INVALID_PAYLOAD";
  if (code.startsWith("DESKTOP_ACTION_")) {
    return error(reply, 400, code, "Invalid desktop action payload");
  }
  throw err;
}

async function handleDesktopActionCreation(
  req: FastifyRequest,
  reply: FastifyReply,
  meta: PageMeta,
  appOwner: string,
  appName: string,
) {
  if (host.isActive?.() === false) return reply.code(503).send({ success: false, error: "Application platform plugin is stopped" });
  const visitorId = host.visitor(req);
  const apiKey = req.headers["x-api-key"];
  const isDevelopmentCreation = typeof apiKey === "string";
  let userId: string;
  if (isDevelopmentCreation) {
    const apiKeyUserId = validateApiKey(apiKey);
    if (!apiKeyUserId) {
      return error(reply, 401, "DESKTOP_ACTION_INVALID_API_KEY", "Invalid API key");
    }
    if (apiKeyUserId !== appOwner) {
      return error(
        reply,
        403,
        "DESKTOP_ACTION_APP_OWNER_REQUIRED",
        "Only the app owner can create development desktop actions",
      );
    }
    userId = apiKeyUserId;
  } else {
    if (!visitorId) {
      return error(reply, 401, "DESKTOP_ACTION_SESSION_REQUIRED", "Browser session required");
    }
    userId = visitorId;
  }

  const refererError = validateReferer(req.headers.referer, req.hostname, appOwner, appName);
  if (refererError) {
    return error(reply, 403, "DESKTOP_ACTION_INVALID_REFERER", refererError);
  }
  if (!isRecord(req.body)) {
    return error(reply, 400, "DESKTOP_ACTION_INVALID_PAYLOAD", "Desktop action body must be an object");
  }

  const { title, description, script, dependencies, input, timeoutSeconds } = req.body;
  if (typeof title !== "string" || title.trim().length === 0) {
    return error(reply, 400, "DESKTOP_ACTION_INVALID_TITLE", "Desktop action title is required");
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    return error(reply, 400, "DESKTOP_ACTION_INVALID_DESCRIPTION", "Desktop action description must be a string");
  }

  const publisher = isDevelopmentCreation
    ? { userId: appOwner }
    : resolveVersionPublisher(meta, meta.currentVersion);
  const publisherDisplayName = publisher.displayName ?? findUserById(publisher.userId)?.displayName ?? null;
  try {
    const action = createDesktopAction({
      userId,
      serverOrigin: new URL(req.headers.referer!).origin,
      appOwner,
      appName,
      appVersion: isDevelopmentCreation ? "dev" : String(meta.currentVersion),
      publisherUserId: publisher.userId,
      publisherDisplayName,
      title,
      description: description ?? null,
      script: script as string,
      dependencies: dependencies as Record<string, string> | undefined,
      input,
      timeoutSeconds: timeoutSeconds as number | undefined,
    });
    const data = {
      requestId: action.id,
      activationUrl: `localapp://action/${action.id}?nonce=${encodeURIComponent(action.nonce)}`,
      expiresAt: action.expiresAt,
      protocolVersion: DESKTOP_ACTION_PROTOCOL_VERSION,
    };
    wsManager.sendToDesktopUser(userId, data, DESKTOP_ACTION_PROTOCOL_VERSION);
    return reply.status(201).send({ success: true, data });
  } catch (err) {
    return sendRepositoryError(reply, err);
  }
}

async function register(app: FastifyInstance) {
  app.addHook("onClose", async () => closeStreams());
  if (host.isActive?.() === false) throw new Error("Application platform plugin is stopped");
  app.addHook("onRequest", async (_request, reply) => {
    if (host.isActive?.() === false) return reply.code(503).send({ success: false, error: "Application platform plugin is stopped" });
  });
  const cleanup = () => cleanupDesktopActions(
    new Date(Date.now() - DESKTOP_ACTION_TERMINAL_RETENTION_MS),
  );
  cleanup();
  const cleanupTimer = setInterval(guardTimerCallback("desktop action cleanup", cleanup), DESKTOP_ACTION_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  host.onStop?.(() => clearInterval(cleanupTimer));
  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
  });

  app.get("/api/desktop-actions/capabilities", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;
    return {
      success: true,
      data: {
        supported: true,
        protocolVersion: DESKTOP_ACTION_PROTOCOL_VERSION,
        online: wsManager.hasDesktopCapability(userId, DESKTOP_ACTION_PROTOCOL_VERSION),
      },
    };
  });

  app.get("/api/desktop-actions/pending", async (req, reply) => {
    const userId = requireApiKeyUser(req, reply);
    if (!userId) return;
    reply.header("Cache-Control", "no-store");
    return { success: true, data: listPendingDesktopActions(userId) };
  });

  app.get<{ Querystring: { installationId?: string } }>(
    "/api/desktop-actions/recover",
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const userId = requireApiKeyUser(req, reply);
      if (!userId) return;
      const { installationId } = req.query;
      if (typeof installationId !== "string" || !CANONICAL_INSTALLATION_ID_PATTERN.test(installationId)) {
        return error(
          reply,
          400,
          "DESKTOP_ACTION_INVALID_INSTALLATION_ID",
          "Invalid desktop installation ID",
        );
      }
      return {
        success: true,
        data: listRecoverableDesktopActions(userId, installationId),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { nonce?: string; installationId?: string; protocolVersion?: string } }>(
    "/api/desktop-actions/:id/claim",
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const userId = requireApiKeyUser(req, reply);
      if (!userId) return;
      const { id } = req.params;
      const { nonce, installationId, protocolVersion } = req.query;
      if (!validRequestId(id)) {
        return error(reply, 400, "DESKTOP_ACTION_INVALID_REQUEST_ID", "Invalid desktop action request ID");
      }
      if (protocolVersion !== String(DESKTOP_ACTION_PROTOCOL_VERSION)) {
        return error(reply, 400, "DESKTOP_ACTION_UNSUPPORTED_PROTOCOL", "Unsupported desktop action protocol");
      }
      if (!validBoundedValue(nonce, MAX_NONCE_LENGTH)) {
        return error(reply, 400, "DESKTOP_ACTION_INVALID_NONCE", "Invalid desktop action nonce");
      }
      if (!validBoundedValue(installationId, MAX_INSTALLATION_ID_LENGTH)) {
        return error(reply, 400, "DESKTOP_ACTION_INVALID_INSTALLATION_ID", "Invalid desktop installation ID");
      }

      const result = claimDesktopAction(userId, id, nonce, installationId);
      switch (result.outcome) {
        case "not_found":
        case "invalid_nonce":
          return error(reply, 404, "DESKTOP_ACTION_NOT_FOUND", "Desktop action not found");
        case "expired":
          return error(reply, 410, "DESKTOP_ACTION_EXPIRED", "Desktop action expired");
        case "conflict":
          return error(reply, 409, "DESKTOP_ACTION_CLAIM_CONFLICT", "Desktop action already claimed");
        case "claimed":
          break;
      }
      if (!result.idempotent) {
        const snapshot = getDesktopActionSnapshot(userId, id);
        if (snapshot) publishSnapshot(userId, snapshot);
      }
      return { success: true, data: result.action };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/desktop-actions/:id/status",
    { bodyLimit: DESKTOP_ACTION_STATUS_BODY_LIMIT },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const userId = requireApiKeyUser(req, reply);
      if (!userId) return;
      if (!validRequestId(req.params.id)) {
        return error(reply, 400, "DESKTOP_ACTION_INVALID_REQUEST_ID", "Invalid desktop action request ID");
      }
      if (!isRecord(req.body)) {
        return error(reply, 400, "DESKTOP_ACTION_INVALID_STATUS", "Desktop action status body must be an object");
      }
      const { installationId, status, result, error: actionError } = req.body;
      if (!validBoundedValue(installationId, MAX_INSTALLATION_ID_LENGTH)) {
        return error(reply, 400, "DESKTOP_ACTION_INVALID_INSTALLATION_ID", "Invalid desktop installation ID");
      }
      if (typeof status !== "string" || !ACTION_STATUSES.has(status as DesktopActionStatus)) {
        return error(reply, 400, "DESKTOP_ACTION_INVALID_STATUS", "Invalid desktop action status");
      }
      if (
        actionError !== undefined
        && actionError !== null
        && (!isRecord(actionError)
          || typeof actionError.message !== "string"
          || (actionError.code !== undefined && typeof actionError.code !== "string"))
      ) {
        return error(reply, 400, "DESKTOP_ACTION_INVALID_ERROR", "Invalid desktop action error");
      }

      try {
        const transition = transitionDesktopAction({
          userId,
          id: req.params.id,
          installationId,
          status: status as DesktopActionStatus,
          ...(result === undefined ? {} : { result }),
          ...(actionError === undefined ? {} : { error: actionError as { message: string; code?: string } | null }),
        });
        switch (transition.outcome) {
          case "not_found":
            return error(reply, 404, "DESKTOP_ACTION_NOT_FOUND", "Desktop action not found");
          case "invalid_transition":
            return error(reply, 409, "DESKTOP_ACTION_INVALID_TRANSITION", "Invalid desktop action transition");
          case "terminal_conflict":
            return error(reply, 409, "DESKTOP_ACTION_TERMINAL_CONFLICT", "Desktop action is already terminal");
          case "updated":
            break;
        }
        if (transition.changed) publishSnapshot(userId, transition.action);
        return { success: true, data: transition.action };
      } catch (err) {
        return sendRepositoryError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/desktop-actions/:id/events", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;
    if (!validRequestId(req.params.id)) {
      return error(reply, 400, "DESKTOP_ACTION_INVALID_REQUEST_ID", "Invalid desktop action request ID");
    }
    const initial = getDesktopActionSnapshot(userId, req.params.id);
    if (!initial) return error(reply, 404, "DESKTOP_ACTION_NOT_FOUND", "Desktop action not found");

    let lastEventKey = "";
    const client: DesktopActionSseClient = {
      userId,
      requestId: req.params.id,
      write: (snapshot) => {
        const eventKey = `${snapshot.updatedAt}:${snapshot.status}`;
        if (eventKey === lastEventKey) return;
        lastEventKey = eventKey;
        reply.raw.write(`id: ${eventKey}\n`);
        reply.raw.write("event: desktop:action-updated\n");
        reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      },
    };

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    sseClients.add(client);
    client.write(initial);
    const heartbeat = setInterval(guardTimerCallback("desktop action heartbeat", () => {
      const snapshot = getDesktopActionSnapshot(userId, req.params.id);
      if (snapshot) client.write(snapshot);
      reply.raw.write(": heartbeat\n\n");
    }), 15_000);
    heartbeat.unref();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      sseClients.delete(client);
      streams.delete(close);
      req.raw.off("close", close);
      reply.raw.end();
    };
    streams.add(close);
    req.raw.on("close", close);
    reply.hijack();
  });

  app.get<{ Params: { id: string } }>("/api/desktop-actions/:id", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;
    if (!validRequestId(req.params.id)) {
      return error(reply, 400, "DESKTOP_ACTION_INVALID_REQUEST_ID", "Invalid desktop action request ID");
    }
    reply.header("Cache-Control", "no-store");
    const snapshot = getDesktopActionSnapshot(userId, req.params.id);
    if (!snapshot) return error(reply, 404, "DESKTOP_ACTION_NOT_FOUND", "Desktop action not found");
    return { success: true, data: snapshot };
  });
}

return { register, handleDesktopActionCreation };
}
