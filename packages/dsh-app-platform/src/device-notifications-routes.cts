import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DeviceNotificationSourceError,
  DeviceNotificationSourceStore,
  type DeviceNotificationConnectionState,
} from "./device-notification-source-store.cjs";

export interface DeviceNotificationRoutesHost {
  config: { notificationControlToken?: string; publicUrl?: string; listenHost: string };
  requireUser(request: FastifyRequest, reply: FastifyReply): string | null;
  userRole(userId: string): string | null;
  publicOrigin(request: FastifyRequest): string | null;
}
export function parseDeviceNotificationJson(raw: string): unknown {
  const keys = new Set<string>();
  const propertyPattern = /"((?:\\.|[^"\\])*)"\s*:/g;
  for (let match = propertyPattern.exec(raw); match; match = propertyPattern.exec(raw)) {
    const key = JSON.parse(`"${match[1]}"`) as string;
    if (keys.has(key)) return { __duplicateJsonKey: true };
    keys.add(key);
  }
  return JSON.parse(raw) as unknown;
}

export async function registerDeviceNotifications(app: FastifyInstance, store: DeviceNotificationSourceStore, host: DeviceNotificationRoutesHost): Promise<void> {
  const { requireUser: requireRequestUser, userRole: getUserRole, publicOrigin: requestPublicOrigin } = host;
const TOKEN_HEADER = "x-localapp-notification-control";
const SOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUS_STATES = new Set<DeviceNotificationConnectionState>(["pending", "connecting", "connected", "error"]);
const MAX_LONG_POLL_MS = 30_000;

  const controlToken = host.config.notificationControlToken ?? "";

  app.get("/api/device-notifications", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;
    noStore(reply);
    return stateResponse(store, userId, Boolean(controlToken));
  });

  app.get("/api/device-notifications/settings", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;
    noStore(reply);
    return { success: true, data: { deviceIntegration: { available: Boolean(controlToken) }, ...store.controlState(userId) } };
  });

  app.put("/api/device-notifications/settings", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId || !requireSameOriginMutation(req, reply)) return;
    if (!controlToken) return capabilityUnavailable(reply);
    const input = parseSettingsBody(req.body, reply);
    if (!input) return;
    try {
      const data = store.updateDisplaySettings({ ownerUserId: userId, expectedGeneration: input.generation, settings: input.settings });
      noStore(reply);
      return { success: true, data };
    } catch (error) { return storeError(reply, error); }
  });

  app.post("/api/device-notifications/test", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId || !requireSameOriginMutation(req, reply)) return;
    if (!controlToken) return capabilityUnavailable(reply);
    const input = parseGenerationBody(req.body, reply);
    if (!input) return;
    try {
      noStore(reply);
      return reply.status(202).send({ success: true, data: store.createTestCommand({ ownerUserId: userId, expectedGeneration: input.generation }) });
    } catch (error) { return storeError(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/api/device-notifications/:id", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;
    noStore(reply);
    if (!validSourceId(req.params.id)) return sendError(reply, 404, "DEVICE_NOTIFICATION_SOURCE_NOT_FOUND", "Notification source not found");
    const source = store.getPublic(userId, req.params.id);
    if (!source) return sendError(reply, 404, "DEVICE_NOTIFICATION_SOURCE_NOT_FOUND", "Notification source not found");
    return { success: true, data: { deviceIntegration: { available: Boolean(controlToken) }, generation: store.generation(), source } };
  });

  app.post("/api/device-notifications/local/enable", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId || !requireSameOriginMutation(req, reply)) return;
    if (!controlToken) return capabilityUnavailable(reply);
    const input = parseEnableBody(req.body, reply);
    if (!input) return;
    try {
      const result = store.enableLocal({
        ownerUserId: userId,
        sourceOrigin: canonicalServerOrigin(req),
        sourceLabel: input.label,
        expectedGeneration: input.generation,
      });
      noStore(reply);
      return { success: true, data: result };
    } catch (error) {
      return storeError(reply, error);
    }
  });

  app.post<{ Params: { peerId: string } }>("/api/device-notifications/peers/:peerId/enable", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId || !requireSameOriginMutation(req, reply)) return;
    if (!controlToken) return capabilityUnavailable(reply);
    if (getUserRole(userId) !== "admin") return sendError(reply, 403, "DEVICE_NOTIFICATION_LOCAL_ADMIN_REQUIRED", "Local administrator required");
    if (!validSourceId(req.params.peerId)) return sendError(reply, 404, "DEVICE_NOTIFICATION_PEER_NOT_FOUND", "Verified peer not found");
    const input = parseEnableBody(req.body, reply);
    if (!input) return;
    try {
      const result = store.enablePeer({ ownerUserId: userId, peerId: req.params.peerId, sourceLabel: input.label, expectedGeneration: input.generation });
      noStore(reply);
      return { success: true, data: result };
    } catch (error) {
      return storeError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/device-notifications/:id/disable", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId || !requireSameOriginMutation(req, reply)) return;
    if (!validSourceId(req.params.id)) return sendError(reply, 404, "DEVICE_NOTIFICATION_SOURCE_NOT_FOUND", "Notification source not found");
    const input = parseGenerationBody(req.body, reply);
    if (!input) return;
    try {
      const result = store.disable({ ownerUserId: userId, sourceId: req.params.id, expectedGeneration: input.generation });
      noStore(reply);
      return { success: true, data: result };
    } catch (error) {
      return storeError(reply, error);
    }
  });

  app.get("/api/internal/device-notifications/sources", async (req, reply) => {
    noStore(reply);
    if (!isLoopback(req)) return sendError(reply, 403, "DEVICE_NOTIFICATION_LOOPBACK_REQUIRED", "Loopback connection required");
    if (!hasControlToken(req, controlToken)) return sendError(reply, 401, "DEVICE_NOTIFICATION_CONTROL_TOKEN_INVALID", "Notification control token is invalid");
    const query = req.query as Record<string, unknown> | undefined;
    if (query && Object.keys(query).some((key) => !["generation", "waitMs"].includes(key))) {
      return sendError(reply, 400, "DEVICE_NOTIFICATION_INVALID_SNAPSHOT_REQUEST", "Invalid notification snapshot request");
    }
    const generation = query?.generation === undefined ? null : parseSafeInteger(query.generation, 0);
    const waitMs = query?.waitMs === undefined ? 0 : parseSafeInteger(query.waitMs, 0, MAX_LONG_POLL_MS);
    if (generation === undefined || waitMs === undefined) {
      return sendError(reply, 400, "DEVICE_NOTIFICATION_INVALID_SNAPSHOT_REQUEST", "Invalid notification snapshot request");
    }
    if (generation !== null && waitMs > 0) {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      req.raw.once("close", cancel);
      try { await store.waitForGeneration(generation, waitMs, controller.signal); } finally { req.raw.off("close", cancel); }
    }
    return { success: true, data: store.snapshot() };
  });

  app.get("/api/internal/device-notifications/control", async (req, reply) => {
    noStore(reply);
    if (!isLoopback(req)) return sendError(reply, 403, "DEVICE_NOTIFICATION_LOOPBACK_REQUIRED", "Loopback connection required");
    if (!hasControlToken(req, controlToken)) return sendError(reply, 401, "DEVICE_NOTIFICATION_CONTROL_TOKEN_INVALID", "Notification control token is invalid");
    const state = store.controlState("");
    return { success: true, data: { generation: state.generation, settings: state.settings } };
  });

  app.post<{ Params: { id: string } }>("/api/internal/device-notifications/sources/:id/status", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    noStore(reply);
    if (!isLoopback(req)) return sendError(reply, 403, "DEVICE_NOTIFICATION_LOOPBACK_REQUIRED", "Loopback connection required");
    if (!hasControlToken(req, controlToken)) return sendError(reply, 401, "DEVICE_NOTIFICATION_CONTROL_TOKEN_INVALID", "Notification control token is invalid");
    if (!validSourceId(req.params.id)) return sendError(reply, 404, "DEVICE_NOTIFICATION_SOURCE_NOT_FOUND", "Notification source not found");
    const input = parseStatusBody(req.body, reply);
    if (!input) return;
    try {
      return { success: true, data: { source: store.reportStatus(req.params.id, input) } };
    } catch (error) {
      return storeError(reply, error);
    }
  });

  app.post("/api/internal/device-notifications/test/claim", async (req, reply) => {
    noStore(reply);
    if (!isLoopback(req)) return sendError(reply, 403, "DEVICE_NOTIFICATION_LOOPBACK_REQUIRED", "Loopback connection required");
    if (!hasControlToken(req, controlToken)) return sendError(reply, 401, "DEVICE_NOTIFICATION_CONTROL_TOKEN_INVALID", "Notification control token is invalid");
    return { success: true, data: { command: store.claimTestCommand() } };
  });

  app.post("/api/internal/device-notifications/native-status", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    noStore(reply);
    if (!isLoopback(req)) return sendError(reply, 403, "DEVICE_NOTIFICATION_LOOPBACK_REQUIRED", "Loopback connection required");
    if (!hasControlToken(req, controlToken)) return sendError(reply, 401, "DEVICE_NOTIFICATION_CONTROL_TOKEN_INVALID", "Notification control token is invalid");
    const input = parseNativeStatusBody(req.body, reply);
    if (!input) return;
    return { success: true, data: store.reportNativeStatus(input) };
  });

  app.post<{ Params: { id: string } }>("/api/internal/device-notifications/test/:id/complete", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    noStore(reply);
    if (!isLoopback(req)) return sendError(reply, 403, "DEVICE_NOTIFICATION_LOOPBACK_REQUIRED", "Loopback connection required");
    if (!hasControlToken(req, controlToken)) return sendError(reply, 401, "DEVICE_NOTIFICATION_CONTROL_TOKEN_INVALID", "Notification control token is invalid");
    if (!validSourceId(req.params.id)) return sendError(reply, 404, "DEVICE_NOTIFICATION_TEST_NOT_FOUND", "Notification test command not found");
    const input = parseTestCompletionBody(req.body, reply);
    if (!input) return;
    try { return { success: true, data: store.completeTestCommand({ id: req.params.id, ...input }) }; }
    catch (error) { return storeError(reply, error); }
  });

function stateResponse(store: DeviceNotificationSourceStore, userId: string, available: boolean) {
  return {
    success: true,
    data: {
      deviceIntegration: { available },
      generation: store.generation(),
      sources: store.listPublic(userId),
      availablePeers: getUserRole(userId) === "admin" ? store.listPeerCandidates(userId) : [],
    },
  };
}

function parseEnableBody(body: unknown, reply: FastifyReply): { generation: number; label: string } | null {
  if (!isExactRecord(body, ["generation", "label"])) {
    sendError(reply, 400, "DEVICE_NOTIFICATION_INVALID_REQUEST", "Invalid notification source request");
    return null;
  }
  const generation = parseSafeInteger(body.generation, 0);
  const label = boundedLabel(body.label);
  if (generation === undefined || !label) {
    sendError(reply, 400, "DEVICE_NOTIFICATION_INVALID_REQUEST", "Invalid notification source request");
    return null;
  }
  return { generation, label };
}

function parseGenerationBody(body: unknown, reply: FastifyReply): { generation: number } | null {
  if (!isExactRecord(body, ["generation"])) {
    sendError(reply, 400, "DEVICE_NOTIFICATION_INVALID_REQUEST", "Invalid notification source request");
    return null;
  }
  const generation = parseSafeInteger(body.generation, 0);
  if (generation === undefined) {
    sendError(reply, 400, "DEVICE_NOTIFICATION_INVALID_REQUEST", "Invalid notification source request");
    return null;
  }
  return { generation };
}

function parseSettingsBody(body: unknown, reply: FastifyReply): { generation: number; settings: { quietHours: { start: string; end: string; timeZone: string } | null; preview: "full" | "hidden" } } | null {
  if (!isExactRecord(body, ["generation", "settings"]) || !isExactRecord(body.settings, ["quietHours", "preview"])) return invalidRequest(reply);
  const generation = parseSafeInteger(body.generation, 0);
  const preview = body.settings.preview === "full" || body.settings.preview === "hidden" ? body.settings.preview : null;
  let quietHours: { start: string; end: string; timeZone: string } | null = null;
  if (body.settings.quietHours !== null) {
    if (!isExactRecord(body.settings.quietHours, ["start", "end", "timeZone"])) return invalidRequest(reply);
    const { start, end, timeZone } = body.settings.quietHours;
    if (typeof start !== "string" || typeof end !== "string" || !validClock(start) || !validClock(end) || start === end
      || typeof timeZone !== "string" || !validTimeZone(timeZone)) return invalidRequest(reply);
    quietHours = { start, end, timeZone };
  }
  if (generation === undefined || preview === null) return invalidRequest(reply);
  return { generation, settings: { quietHours, preview } };
}

function parseTestCompletionBody(body: unknown, reply: FastifyReply): { result: "shown" | "denied" | "unsupported" | "failed"; permission: "not-determined" | "granted" | "denied" | "unsupported" | "unknown"; daemonVersion: string; adapterVersion: string } | null {
  if (!isExactRecord(body, ["result", "permission", "daemonVersion", "adapterVersion"])) return invalidRequest(reply);
  const results = ["shown", "denied", "unsupported", "failed"] as const;
  const permissions = ["not-determined", "granted", "denied", "unsupported", "unknown"] as const;
  if (!results.includes(body.result as never) || !permissions.includes(body.permission as never)
    || !boundedVersion(body.daemonVersion) || !boundedVersion(body.adapterVersion)) return invalidRequest(reply);
  return body as { result: typeof results[number]; permission: typeof permissions[number]; daemonVersion: string; adapterVersion: string };
}

function parseNativeStatusBody(body: unknown, reply: FastifyReply): { permission: "not-determined" | "granted" | "denied" | "unsupported" | "unknown"; daemonVersion: string; adapterVersion: string } | null {
  if (!isExactRecord(body, ["permission", "daemonVersion", "adapterVersion"])) return invalidRequest(reply);
  const permissions = ["not-determined", "granted", "denied", "unsupported", "unknown"] as const;
  if (!permissions.includes(body.permission as never) || !boundedVersion(body.daemonVersion) || !boundedVersion(body.adapterVersion)) return invalidRequest(reply);
  return body as { permission: typeof permissions[number]; daemonVersion: string; adapterVersion: string };
}

function invalidRequest(reply: FastifyReply): null {
  sendError(reply, 400, "DEVICE_NOTIFICATION_INVALID_REQUEST", "Invalid device notification request");
  return null;
}

function parseStatusBody(body: unknown, reply: FastifyReply): {
  generation: number;
  state: "pending" | "connecting" | "connected" | "error";
  cursor: number | null;
  lastEventAt: string | null;
  error: { code: string; message: string } | null;
} | null {
  if (!isExactRecord(body, ["generation", "state", "cursor", "lastEventAt", "error"])) return invalidStatus(reply);
  const generation = parseSafeInteger(body.generation, 1);
  const state = typeof body.state === "string" && STATUS_STATES.has(body.state as DeviceNotificationConnectionState)
    ? body.state as "pending" | "connecting" | "connected" | "error"
    : null;
  const cursor = body.cursor === null ? null : parseSafeInteger(body.cursor, 0);
  const lastEventAt = body.lastEventAt === null ? null : boundedIsoDate(body.lastEventAt);
  let error: { code: string; message: string } | null = null;
  if (body.error !== null) {
    if (!isExactRecord(body.error, ["code", "message"])) return invalidStatus(reply);
    if (typeof body.error.code !== "string" || !/^[A-Z0-9_]{1,64}$/.test(body.error.code)
      || typeof body.error.message !== "string" || body.error.message.length < 1 || body.error.message.length > 240) return invalidStatus(reply);
    error = { code: body.error.code, message: body.error.message };
  }
  if (generation === undefined || !state || cursor === undefined || (body.lastEventAt !== null && !lastEventAt)) return invalidStatus(reply);
  return { generation, state, cursor, lastEventAt, error };
}

function invalidStatus(reply: FastifyReply): null {
  sendError(reply, 400, "DEVICE_NOTIFICATION_INVALID_STATUS", "Invalid notification status report");
  return null;
}

function requireSameOriginMutation(req: FastifyRequest, reply: FastifyReply): boolean {
  if (typeof req.headers["x-api-key"] === "string") return true;
  const supplied = typeof req.headers.origin === "string" ? req.headers.origin : null;
  const expected = new Set<string>();
  const publicOrigin = requestPublicOrigin(req);
  if (publicOrigin) expected.add(publicOrigin);
  if (host.config.publicUrl) {
    try { expected.add(new URL(host.config.publicUrl).origin); } catch { /* invalid config is handled at startup */ }
  }
  try { expected.add(canonicalServerOrigin(req)); } catch { /* unopened test Server */ }
  if (supplied && expected.has(supplied)) return true;
  sendError(reply, 403, "DEVICE_NOTIFICATION_ORIGIN_REQUIRED", "Same-origin request required");
  return false;
}

function canonicalServerOrigin(req: FastifyRequest): string {
  if (host.config.publicUrl) return new URL(host.config.publicUrl).origin;
  const address = req.server.server.address();
  if (!address || typeof address === "string") throw new Error("DEVICE_NOTIFICATION_SERVER_NOT_READY");
  const listenHost = host.config.listenHost === "0.0.0.0" || host.config.listenHost === "::" ? "127.0.0.1" : host.config.listenHost;
  return `http://${listenHost}:${address.port}`;
}

function isLoopback(req: FastifyRequest): boolean {
  const address = req.socket.remoteAddress ?? req.ip;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function hasControlToken(req: FastifyRequest, expected: string): boolean {
  const supplied = req.headers[TOKEN_HEADER];
  if (typeof supplied !== "string" || supplied.length === 0 || Buffer.byteLength(expected) < 16) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function storeError(reply: FastifyReply, error: unknown) {
  const code = error instanceof DeviceNotificationSourceError ? error.code : "DEVICE_NOTIFICATION_MUTATION_FAILED";
  const responses: Record<string, [number, string]> = {
    DEVICE_NOTIFICATION_GENERATION_CONFLICT: [409, "Notification source generation changed"],
    DEVICE_NOTIFICATION_STALE_STATUS: [409, "Notification status report is stale"],
    DEVICE_NOTIFICATION_PEER_NOT_VERIFIED: [409, "Verified peer required"],
    DEVICE_NOTIFICATION_SOURCE_NOT_FOUND: [404, "Notification source not found"],
    DEVICE_NOTIFICATION_ACCOUNT_NOT_FOUND: [404, "Notification account not found"],
    DEVICE_NOTIFICATION_TEST_NOT_FOUND: [404, "Notification test command not found"],
  };
  const [status, message] = responses[code] ?? [500, "Notification source mutation failed"];
  return sendError(reply, status, code, message);
}

function capabilityUnavailable(reply: FastifyReply) {
  return sendError(reply, 409, "DEVICE_NOTIFICATION_CAPABILITY_UNAVAILABLE", "Device notification integration is unavailable");
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ success: false, code, error: message });
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}

function validSourceId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_ID_PATTERN.test(value);
}

function boundedLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label.length >= 1 && label.length <= 80 ? label : null;
}

function boundedIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function validClock(value: string): boolean { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function validTimeZone(value: string): boolean {
  if (value.length < 1 || value.length > 64 || /[\u0000-\u001f<>]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; }
}
function boundedVersion(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value); }

function parseSafeInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

}
