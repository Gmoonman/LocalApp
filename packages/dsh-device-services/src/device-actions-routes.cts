import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { createDeviceActionStore } from "@localapp/dsh-device-services/desktop-actions-db";
import { DESKTOP_ACTION_CLEANUP_INTERVAL_MS as DEVICE_ACTION_CLEANUP_INTERVAL_MS, DESKTOP_ACTION_ERROR_MAX_BYTES as DEVICE_ACTION_ERROR_MAX_BYTES, DESKTOP_ACTION_RESULT_MAX_BYTES as DEVICE_ACTION_RESULT_MAX_BYTES, DESKTOP_ACTION_TERMINAL_RETENTION_MS as DEVICE_ACTION_TERMINAL_RETENTION_MS, type DesktopActionSnapshot as DeviceActionSnapshot, type DesktopActionStatus as DeviceActionStatus } from "@localapp/dsh-device-services/desktop-actions-db";
import { canonicalizeDeviceActionRequest, DEVICE_ACTION_PROTOCOL_VERSION, type DeviceActionRequest } from "@localapp/dsh-device-services/device-action-types";
import { createDeviceActivationUrl, parseDeviceActivationTicket } from "@localapp/dsh-device-services/device-action-ticket";
import { validateReferer } from "@localapp/dsh-device-services/notify-referer";
import { resolveVersionPublisher, type PageMeta } from "@localapp/app-foundation/page-storage";
export interface DeviceActionsHost {
  isActive?(): boolean;
  onStop?(cleanup: () => void): void;
  config: { publicUrl?: string; listenHost: string; deviceControlToken?: string };
  store: ReturnType<typeof createDeviceActionStore>;
  visitor(request: FastifyRequest): string | null | undefined;
  requireUser(request: FastifyRequest, reply: FastifyReply): string | null;
  keyOwner(key: string): string | null;
  user(userId: string): { displayName: string | null } | null;
  guardTimer(label: string, callback: () => unknown): () => void;
}
export function createDeviceActionRoutes(host: DeviceActionsHost) {
  const streams = new Set<() => void>();
  const closeStreams = () => { for (const close of [...streams]) close(); };
  host.onStop?.(closeStreams);
  const { keyOwner: validateApiKey, user: findUserById, requireUser: requireRequestUser, guardTimer: guardTimerCallback } = host;
  const { claimDeviceAction, cleanupDesktopActions: cleanupDeviceActions, createDesktopAction: createDeviceAction, getDesktopActionSnapshot: getDeviceActionSnapshot, listPendingDesktopActions: listPendingDeviceActions, transitionDeviceAction } = host.store;
const MAX_INSTALLATION_ID_LENGTH = 128;
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUS_BODY_LIMIT = DEVICE_ACTION_RESULT_MAX_BYTES + DEVICE_ACTION_ERROR_MAX_BYTES + 8 * 1024;
const ACTION_STATUSES = new Set<DeviceActionStatus>([
  "pending", "claimed", "awaiting_trust", "preparing", "running", "succeeded", "failed", "cancelled", "expired", "interrupted",
]);

type DeviceActionSseClient = { userId: string; requestId: string; write: (snapshot: DeviceActionSnapshot) => void };
const sseClients = new Set<DeviceActionSseClient>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendError(reply: FastifyReply, status: number, code: string, message = code) {
  return reply.status(status).send({ success: false, code, error: message });
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function validInstallationId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_INSTALLATION_ID_LENGTH && INSTALLATION_ID_PATTERN.test(value);
}

function requireApiKeyUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const apiKey = req.headers["x-api-key"];
  const userId = typeof apiKey === "string" ? validateApiKey(apiKey) : null;
  if (!userId) {
    sendError(reply, 401, "DEVICE_ACTION_API_KEY_REQUIRED", "API key required");
    return null;
  }
  return userId;
}

function publishSnapshot(userId: string, snapshot: DeviceActionSnapshot): void {
  for (const client of sseClients) {
    if (client.userId === userId && client.requestId === snapshot.id) client.write(snapshot);
  }
}

function mapStoreError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : "DEVICE_ACTION_INVALID_PAYLOAD";
  const code = raw.startsWith("DESKTOP_ACTION_") ? raw.replace(/^DESKTOP_ACTION_/, "DEVICE_ACTION_") : raw;
  return { code, message: "Invalid device action payload" };
}

function canonicalServerOrigin(req: FastifyRequest): string {
  const config = host.config;
  if (config.publicUrl) {
    const parsed = new URL(config.publicUrl);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error("DEVICE_ACTION_INVALID_SERVER_ORIGIN");
    }
    return parsed.origin;
  }
  const address = req.server.server.address();
  if (!address || typeof address === "string") throw new Error("DEVICE_ACTION_SERVER_NOT_READY");
  const listenHost = config.listenHost === "0.0.0.0" || config.listenHost === "::" ? "127.0.0.1" : config.listenHost;
  return `http://${listenHost}:${address.port}`;
}

function daemonLoopbackFastPath(req: FastifyRequest, sourceOrigin: string): { controlToken: string } | null {
  const config = host.config;
  if (config.publicUrl || (config.listenHost !== "127.0.0.1" && config.listenHost !== "::1")) return null;
  if (typeof config.deviceControlToken !== "string" || config.deviceControlToken.length < 16) return null;
  const parsed = new URL(sourceOrigin);
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]" && parsed.hostname !== "::1") return null;
  return { controlToken: config.deviceControlToken };
}

async function handleDeviceActionCreation(
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
    if (!apiKeyUserId) return sendError(reply, 401, "DEVICE_ACTION_INVALID_API_KEY", "Invalid API key");
    if (apiKeyUserId !== appOwner) return sendError(reply, 403, "DEVICE_ACTION_APP_OWNER_REQUIRED", "Only the app owner may create a development action");
    userId = apiKeyUserId;
  } else {
    if (!visitorId) return sendError(reply, 401, "DEVICE_ACTION_SESSION_REQUIRED", "Browser session required");
    userId = visitorId;
  }

  const refererError = validateReferer(req.headers.referer, req.hostname, appOwner, appName);
  if (refererError) return sendError(reply, 403, "DEVICE_ACTION_INVALID_REFERER", refererError);
  if (!isRecord(req.body)) return sendError(reply, 400, "DEVICE_ACTION_INVALID_PAYLOAD", "Device action body must be an object");
  try {
    const request = canonicalizeDeviceActionRequest(req.body) as DeviceActionRequest;
    const publisher = isDevelopmentCreation ? { userId: appOwner } : resolveVersionPublisher(meta, meta.currentVersion);
    const publisherDisplayName = publisher.displayName ?? findUserById(publisher.userId)?.displayName ?? null;
    const sourceOrigin = canonicalServerOrigin(req);
    const action = createDeviceAction({
      userId,
      serverOrigin: sourceOrigin,
      appOwner,
      appName,
      appVersion: isDevelopmentCreation ? "dev" : String(meta.currentVersion),
      publisherUserId: publisher.userId,
      publisherDisplayName,
      title: request.title,
      description: request.description ?? null,
      script: request.script,
      dependencies: request.dependencies,
      input: request.input,
      timeoutSeconds: request.timeoutSeconds,
      permissions: request.permissions,
    });
    const ticket = {
      protocolVersion: DEVICE_ACTION_PROTOCOL_VERSION,
      sourceOrigin,
      actionId: action.id,
      nonce: action.nonce,
    } as const;
    let activationUrl = createDeviceActivationUrl(ticket);
    let status: DeviceActionStatus = action.status;
    const local = daemonLoopbackFastPath(req, sourceOrigin);
    if (local) {
      const activation = await req.server.inject({
        method: "POST",
        url: "/api/device-control/activations",
        headers: { "content-type": "application/json", "x-localapp-device-control": local.controlToken },
        payload: ticket,
      });
      if (activation.statusCode !== 200) return sendError(reply, 502, "DEVICE_ACTION_LOCAL_ACTIVATION_FAILED", "Local device action activation failed");
      const body = activation.json() as { success?: boolean; data?: { requestId?: string; status?: DeviceActionStatus; confirmationUrl?: string } };
      if (body.success !== true || body.data?.requestId !== action.id || typeof body.data.confirmationUrl !== "string" || !body.data.status) {
        return sendError(reply, 502, "DEVICE_ACTION_LOCAL_ACTIVATION_INVALID", "Local device action activation response is invalid");
      }
      activationUrl = body.data.confirmationUrl;
      status = body.data.status;
    }
    const data = {
      requestId: action.id,
      activationUrl,
      status,
      expiresAt: action.expiresAt,
      protocolVersion: DEVICE_ACTION_PROTOCOL_VERSION,
      permissionsDigest: action.permissionsDigest,
    };
    return reply.status(201).send({ success: true, data });
  } catch (error) {
    const mapped = mapStoreError(error);
    return sendError(reply, 400, mapped.code, mapped.message);
  }
}

async function register(app: FastifyInstance) {
  app.addHook("onClose", async () => closeStreams());
  if (host.isActive?.() === false) throw new Error("Application platform plugin is stopped");
  app.addHook("onRequest", async (_request, reply) => {
    if (host.isActive?.() === false) return reply.code(503).send({ success: false, error: "Application platform plugin is stopped" });
  });
  const cleanup = () => cleanupDeviceActions(new Date(Date.now() - DEVICE_ACTION_TERMINAL_RETENTION_MS));
  cleanup();
  const cleanupTimer = setInterval(guardTimerCallback("device action cleanup", cleanup), DEVICE_ACTION_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  host.onStop?.(() => clearInterval(cleanupTimer));
  app.addHook("onClose", async () => clearInterval(cleanupTimer));

  app.get("/api/device-actions/capabilities", async () => ({
    success: true,
    data: { supported: true, protocolVersion: DEVICE_ACTION_PROTOCOL_VERSION },
  }));

  app.get("/api/device-actions/pending", async (req, reply) => {
    const userId = requireApiKeyUser(req, reply);
    if (!userId) return;
    reply.header("Cache-Control", "no-store");
    return { success: true, data: listPendingDeviceActions(userId) };
  });

  app.post<{ Params: { id: string } }>("/api/device-actions/:id/claim", { bodyLimit: 32 * 1024 }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!validRequestId(req.params.id) || !isRecord(req.body)) return sendError(reply, 400, "DEVICE_ACTION_INVALID_TICKET");
    const input = req.body;
    if (Object.keys(input).some((key) => !["protocolVersion", "sourceOrigin", "actionId", "nonce", "installationId"].includes(key))) {
      return sendError(reply, 400, "DEVICE_ACTION_INVALID_TICKET");
    }
    if (!validInstallationId(input.installationId) || input.actionId !== req.params.id) return sendError(reply, 400, "DEVICE_ACTION_INVALID_INSTALLATION_ID");
    let ticket;
    try {
      const { installationId: _installationId, ...ticketInput } = input;
      ticket = parseDeviceActivationTicket(ticketInput);
    } catch { return sendError(reply, 404, "DEVICE_ACTION_NOT_FOUND", "Device action not found"); }
    const result = claimDeviceAction(ticket.actionId, ticket.nonce, input.installationId, ticket.sourceOrigin);
    if (result.outcome !== "claimed") {
      if (result.outcome === "expired") return sendError(reply, 410, "DEVICE_ACTION_EXPIRED", "Device action expired");
      if (result.outcome === "conflict") return sendError(reply, 409, "DEVICE_ACTION_CLAIM_CONFLICT", "Device action already claimed");
      return sendError(reply, 404, "DEVICE_ACTION_NOT_FOUND", "Device action not found");
    }
    return { success: true, data: { action: result.action, callbackToken: result.action.nonce, installationId: input.installationId, protocolVersion: DEVICE_ACTION_PROTOCOL_VERSION } };
  });

  app.post<{ Params: { id: string } }>("/api/device-actions/:id/status", { bodyLimit: STATUS_BODY_LIMIT }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!validRequestId(req.params.id) || !isRecord(req.body)) return sendError(reply, 400, "DEVICE_ACTION_INVALID_STATUS");
    const input = req.body;
    if (Object.keys(input).some((key) => !["protocolVersion", "installationId", "callbackToken", "status", "result", "error"].includes(key))) {
      return sendError(reply, 400, "DEVICE_ACTION_INVALID_STATUS");
    }
    if (input.protocolVersion !== DEVICE_ACTION_PROTOCOL_VERSION || !validInstallationId(input.installationId)
      || typeof input.callbackToken !== "string" || typeof input.status !== "string" || !ACTION_STATUSES.has(input.status as DeviceActionStatus)) {
      return sendError(reply, 400, "DEVICE_ACTION_INVALID_STATUS");
    }
    try {
      const transition = transitionDeviceAction({
        id: req.params.id,
        callbackToken: input.callbackToken,
        installationId: input.installationId,
        status: input.status as DeviceActionStatus,
        ...(input.result === undefined ? {} : { result: input.result }),
        ...(input.error === undefined ? {} : { error: input.error as { message: string; code?: string } | null }),
      });
      if (transition.outcome !== "updated") {
        if (transition.outcome === "invalid_transition") return sendError(reply, 409, "DEVICE_ACTION_INVALID_TRANSITION");
        if (transition.outcome === "terminal_conflict") return sendError(reply, 409, "DEVICE_ACTION_TERMINAL_CONFLICT");
        return sendError(reply, 404, "DEVICE_ACTION_NOT_FOUND", "Device action not found");
      }
      if (transition.changed) publishSnapshot(transition.action.userId, transition.action);
      return { success: true, data: transition.action };
    } catch (error) {
      const mapped = mapStoreError(error);
      return sendError(reply, 400, mapped.code, mapped.message);
    }
  });

  app.get<{ Params: { id: string } }>("/api/device-actions/:id/events", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId || !validRequestId(req.params.id)) return;
    const initial = getDeviceActionSnapshot(userId, req.params.id);
    if (!initial) return sendError(reply, 404, "DEVICE_ACTION_NOT_FOUND", "Device action not found");
    let lastEventKey = "";
    const client: DeviceActionSseClient = {
      userId,
      requestId: req.params.id,
      write: (snapshot) => {
        const key = `${snapshot.updatedAt}:${snapshot.status}`;
        if (key === lastEventKey) return;
        lastEventKey = key;
        reply.raw.write(`id: ${key}\n`);
        reply.raw.write("event: device:action-updated\n");
        reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      },
    };
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    sseClients.add(client);
    client.write(initial);
    const heartbeat = setInterval(guardTimerCallback("device action heartbeat", () => {
      const snapshot = getDeviceActionSnapshot(userId, req.params.id);
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

  app.get<{ Params: { id: string } }>("/api/device-actions/:id", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId || !validRequestId(req.params.id)) return;
    reply.header("Cache-Control", "no-store");
    const snapshot = getDeviceActionSnapshot(userId, req.params.id);
    if (!snapshot) return sendError(reply, 404, "DEVICE_ACTION_NOT_FOUND", "Device action not found");
    return { success: true, data: snapshot };
  });
}

return { register, handleDeviceActionCreation };
}
