import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { checkAccess } from "./access-control.cjs";
import { applyCrdtUpdate, CrdtStoreError, readCrdtDiff } from "./crdt-store.cjs";
import { getDbPath } from "./app-db.cjs";
import { getPageDir, readPageMeta, type PageMeta } from "./page-storage.cjs";
import type { CrdtCollaborationResourceConfig } from "./models.cjs";


export interface ApplicationCrdtHost {
  visitorId(request: FastifyRequest): string | null | undefined;
  validateApiKey(key: string): string | null;
  user(id: string): { name: string; displayName?: string | null; avatarUrl?: string | null } | null | undefined;
  verification(request: FastifyRequest): { id: string; actorId: string; databasePath: string } | null | undefined;
}

export function createApplicationCrdt(host: ApplicationCrdtHost) {
const DEFAULT_MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_UPDATE_BYTES = 1024 * 1024;
const MAX_STATE_VECTOR_BYTES = 64 * 1024;
const AWARENESS_TTL_MS = 30_000;
const MAX_CRDT_SSE_CLIENTS = 1_000;
const MAX_AWARENESS_LEASES_PER_DOCUMENT = 128;
const MAX_AWARENESS_LEASES_PER_USER = 16;

type CrdtSseClient = {
  channel: string;
  appOwner: string;
  appName: string;
  resource: string;
  documentId: string;
  canViewIdentities: boolean;
  write: (event: "crdt:update" | "crdt:awareness", body: unknown) => void;
};

type AwarenessEditingTarget = {
  surfaceId: string;
  fieldId?: string;
  label?: string;
  kind: "field" | "selection" | "canvas";
  selection?: { anchor: string; head: string };
};

type AwarenessLease = {
  channel: string;
  appOwner: string;
  appName: string;
  resource: string;
  documentId: string;
  clientId: string;
  clock: number;
  user: { id: string; name: string; displayName: string | null; avatarUrl: string | null; color: string };
  editing: AwarenessEditingTarget;
  overlay: boolean;
  updatedAt: string;
  expiresAt: number;
};

const activeStreams = new Set<() => void>();
function trackStream(req: FastifyRequest, reply: FastifyReply, remove: () => void) {
  const close = () => {
    if (!activeStreams.delete(close)) return;
    req.raw.removeListener("close", close);
    remove();
    reply.raw.end();
  };
  activeStreams.add(close);
  req.raw.on("close", close);
}

const crdtSseClients = new Set<CrdtSseClient>();
const awarenessLeases = new Map<string, AwarenessLease>();
const awarenessExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function handleCrdtSync(
  req: FastifyRequest,
  reply: FastifyReply,
  dataDir: string,
  appOwner: string,
  appName: string,
) {
  const body = asRecord(req.body);
  const resource = validIdentifier(body?.resource);
  const documentId = validDocumentId(body?.documentId);
  if (!resource || !documentId) return invalid(reply, "Valid resource and documentId are required");
  const resolved = resolveResource(req, reply, dataDir, appOwner, appName, resource, "read");
  if (!resolved) return;
  let stateVector: Uint8Array | undefined;
  try {
    stateVector = typeof body?.stateVector === "string"
      ? decodeBase64Url(body.stateVector, MAX_STATE_VECTOR_BYTES)
      : undefined;
  } catch (error) {
    return invalid(reply, error instanceof Error ? error.message : "Invalid state vector");
  }
  try {
    const update = await readCrdtDiff({
      dbPath: requestDbPath(req, dataDir, appOwner, appName),
      resource,
      documentId,
      stateVector,
    });
    return { success: true, data: { update: encodeBase64Url(update) } };
  } catch (error) {
    return crdtError(reply, error);
  }
}

async function handleCrdtUpdate(
  req: FastifyRequest,
  reply: FastifyReply,
  dataDir: string,
  appOwner: string,
  appName: string,
) {
  const body = asRecord(req.body);
  const resource = validIdentifier(body?.resource);
  const documentId = validDocumentId(body?.documentId);
  const clientId = validClientId(body?.clientId);
  if (!resource || !documentId || !clientId || typeof body?.update !== "string") {
    return invalid(reply, "Valid resource, documentId, clientId and update are required");
  }
  const resolved = resolveResource(req, reply, dataDir, appOwner, appName, resource, "write");
  if (!resolved) return;
  let update: Uint8Array;
  try {
    update = decodeBase64Url(body.update, MAX_UPDATE_BYTES);
  } catch (error) {
    return invalid(reply, error instanceof Error ? error.message : "Invalid CRDT update");
  }
  try {
    const result = await applyCrdtUpdate({
      dbPath: requestDbPath(req, dataDir, appOwner, appName),
      resource,
      documentId,
      update,
      actorId: resolved.visitorId!,
      maxDocumentBytes: resolved.config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
    });
    publishUpdate({ channel: requestChannel(req), appOwner, appName, resource, documentId, clientId, update });
    return { success: true, data: result };
  } catch (error) {
    return crdtError(reply, error);
  }
}

async function handleCrdtEvents(
  req: FastifyRequest,
  reply: FastifyReply,
  dataDir: string,
  appOwner: string,
  appName: string,
) {
  const query = asRecord(req.query);
  const resource = validIdentifier(query?.resource);
  const documentId = validDocumentId(query?.documentId);
  if (!resource || !documentId) return invalid(reply, "Valid resource and documentId are required");
  const resolved = resolveResource(req, reply, dataDir, appOwner, appName, resource, "read");
  if (!resolved) return;
  if (crdtSseClients.size >= MAX_CRDT_SSE_CLIENTS) {
    return reply.status(503).send({ success: false, code: "CRDT_CONNECTION_LIMIT", error: "Too many CRDT event connections" });
  }
  const client: CrdtSseClient = {
    channel: requestChannel(req),
    appOwner,
    appName,
    resource,
    documentId,
    canViewIdentities: resolved.visitorId !== null,
    write: (event, body) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(body)}\n\n`);
    },
  };
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": connected\n\n");
  crdtSseClients.add(client);
  publishAwarenessSnapshot(client.channel, appOwner, appName, resource, documentId);
  trackStream(req, reply, () => crdtSseClients.delete(client));
  reply.hijack();
}

async function handleCrdtAwareness(
  req: FastifyRequest,
  reply: FastifyReply,
  dataDir: string,
  appOwner: string,
  appName: string,
) {
  const body = asRecord(req.body);
  const resource = validIdentifier(body?.resource);
  const documentId = validDocumentId(body?.documentId);
  const clientId = validClientId(body?.clientId);
  const clock = body?.clock;
  if (!resource || !documentId || !clientId || !Number.isSafeInteger(clock) || Number(clock) < 0) {
    return invalid(reply, "Valid resource, documentId, clientId and clock are required");
  }
  const resolved = resolveResource(req, reply, dataDir, appOwner, appName, resource, "write");
  if (!resolved) return;
  if (resolved.config.awareness === false) {
    return reply.status(403).send({ success: false, code: "CRDT_AWARENESS_DISABLED", error: "CRDT awareness is disabled" });
  }
  const channel = requestChannel(req);
  const key = awarenessKey(channel, appOwner, appName, resource, documentId, clientId);
  publishExpiredAwarenessScopes(pruneAwareness());
  const current = awarenessLeases.get(key);
  if (current && current.user.id !== resolved.visitorId) {
    return reply.status(409).send({ success: false, code: "CRDT_AWARENESS_CLIENT_CONFLICT", error: "Awareness clientId is already in use" });
  }
  if (current && Number(clock) <= current.clock) {
    return reply.status(409).send({ success: false, code: "CRDT_AWARENESS_CLOCK_STALE", error: "Awareness clock must increase" });
  }
  if (body?.state === null) {
    deleteAwarenessLease(key);
    publishAwarenessSnapshot(channel, appOwner, appName, resource, documentId);
    return { success: true, data: { status: "offline" } };
  }
  const state = asRecord(body?.state);
  const editing = normalizeEditingTarget(asRecord(state?.editing));
  if (!editing) return invalid(reply, "Valid awareness editing target is required");
  if (!current) {
    const scoped = [...awarenessLeases.values()].filter((lease) =>
      lease.channel === channel && lease.appOwner === appOwner && lease.appName === appName && lease.resource === resource && lease.documentId === documentId,
    );
    if (scoped.length >= MAX_AWARENESS_LEASES_PER_DOCUMENT) {
      return reply.status(429).send({ success: false, code: "CRDT_AWARENESS_LIMIT", error: "Too many editors for this document" });
    }
    if (scoped.filter((lease) => lease.user.id === resolved.visitorId).length >= MAX_AWARENESS_LEASES_PER_USER) {
      return reply.status(429).send({ success: false, code: "CRDT_AWARENESS_LIMIT", error: "Too many editing sessions for this user" });
    }
  }
  const user = host.user(resolved.visitorId!);
  const now = new Date().toISOString();
  const lease: AwarenessLease = {
    channel,
    appOwner,
    appName,
    resource,
    documentId,
    clientId,
    clock: Number(clock),
    user: {
      id: resolved.visitorId!,
      name: user?.name ?? resolved.visitorId!,
      displayName: user?.displayName ?? null,
      avatarUrl: user?.avatarUrl ?? null,
      color: identityColor(resolved.visitorId!),
    },
    editing,
    overlay: resolved.meta.collaboration?.overlay !== false && resolved.config.overlay !== false,
    updatedAt: now,
    expiresAt: Date.now() + AWARENESS_TTL_MS,
  };
  awarenessLeases.set(key, lease);
  scheduleAwarenessExpiry(key, lease);
  publishAwarenessSnapshot(channel, appOwner, appName, resource, documentId);
  return { success: true, data: { status: "editing", expiresInMs: AWARENESS_TTL_MS } };
}

function resolveResource(
  req: FastifyRequest,
  reply: FastifyReply,
  dataDir: string,
  appOwner: string,
  appName: string,
  resource: string,
  action: "read" | "write",
): { config: CrdtCollaborationResourceConfig; visitorId: string | null; meta: PageMeta } | null {
  const meta = readPageMeta(dataDir, appOwner, appName);
  if (!meta) {
    reply.status(404).send({ success: false, error: "Application not found" });
    return null;
  }
  const config = meta.collaboration?.enabled ? meta.collaboration.resources?.[resource] : undefined;
  if (!config || config.mode !== "crdt") {
    reply.status(404).send({ success: false, code: "CRDT_RESOURCE_NOT_FOUND", error: "CRDT resource is not declared" });
    return null;
  }
  const visitorId = requestVisitorId(req);
  const level = action === "read" ? config.read ?? "authenticated" : config.write ?? "authenticated";
  if (!checkAccess(level, visitorId, appOwner, config.acl)) {
    reply.status(visitorId ? 403 : 401).send({
      success: false,
      code: visitorId ? "CRDT_ACCESS_DENIED" : "AUTHENTICATION_REQUIRED",
      error: visitorId ? "CRDT access denied" : "Authentication required",
    });
    return null;
  }
  return { config, visitorId, meta };
}

function requestVisitorId(req: FastifyRequest): string | null {
  const verification = host.verification(req);
  if (verification) return verification.actorId;
  const visitorId = host.visitorId(req);
  if (visitorId) return visitorId;
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" ? host.validateApiKey(apiKey) : null;
}

function requestDbPath(req: FastifyRequest, dataDir: string, appOwner: string, appName: string): string {
  return host.verification(req)?.databasePath ?? getDbPath(getPageDir(dataDir, appOwner, appName));
}

function publishUpdate(input: {
  channel: string;
  appOwner: string;
  appName: string;
  resource: string;
  documentId: string;
  clientId: string;
  update: Uint8Array;
}): void {
  const body = { type: "crdt:update", data: { clientId: input.clientId, update: encodeBase64Url(input.update) } };
  for (const client of crdtSseClients) {
    if (matches(client, input)) client.write("crdt:update", body);
  }
}

function publishAwarenessSnapshot(channel: string, appOwner: string, appName: string, resource: string, documentId: string): void {
  const expiredScopes = pruneAwareness();
  publishAwarenessScope(channel, appOwner, appName, resource, documentId);
  for (const scope of expiredScopes.values()) {
    if (scope.channel === channel && scope.appOwner === appOwner && scope.appName === appName && scope.resource === resource && scope.documentId === documentId) continue;
    publishAwarenessScope(scope.channel, scope.appOwner, scope.appName, scope.resource, scope.documentId);
  }
}

function publishAwarenessScope(channel: string, appOwner: string, appName: string, resource: string, documentId: string): void {
  const peers = [...awarenessLeases.values()].filter((lease) =>
    lease.channel === channel && lease.appOwner === appOwner && lease.appName === appName && lease.resource === resource && lease.documentId === documentId,
  );
  for (const client of crdtSseClients) {
    if (!matches(client, { channel, appOwner, appName, resource, documentId })) continue;
    client.write("crdt:awareness", {
      type: "crdt:awareness",
      data: {
        peers: peers.map((peer) => ({
          clientId: peer.clientId,
          clock: peer.clock,
          user: client.canViewIdentities
            ? peer.user
            : { id: "anonymous", name: "Collaborator", displayName: "Collaborator", avatarUrl: null, color: peer.user.color },
          editing: peer.editing,
          overlay: peer.overlay,
          updatedAt: peer.updatedAt,
        })),
      },
    });
  }
}

function matches(
  client: CrdtSseClient,
  scope: { channel: string; appOwner: string; appName: string; resource: string; documentId: string },
): boolean {
  return client.channel === scope.channel && client.appOwner === scope.appOwner && client.appName === scope.appName
    && client.resource === scope.resource && client.documentId === scope.documentId;
}

function pruneAwareness(now = Date.now()): Map<string, Pick<AwarenessLease, "channel" | "appOwner" | "appName" | "resource" | "documentId">> {
  const changedScopes = new Map<string, Pick<AwarenessLease, "channel" | "appOwner" | "appName" | "resource" | "documentId">>();
  for (const [key, lease] of awarenessLeases) {
    if (lease.expiresAt > now) continue;
    deleteAwarenessLease(key);
    changedScopes.set(
      [lease.channel, lease.appOwner, lease.appName, lease.resource, lease.documentId].join("\u0000"),
      { channel: lease.channel, appOwner: lease.appOwner, appName: lease.appName, resource: lease.resource, documentId: lease.documentId },
    );
  }
  return changedScopes;
}

function publishExpiredAwarenessScopes(
  scopes: Map<string, Pick<AwarenessLease, "channel" | "appOwner" | "appName" | "resource" | "documentId">>,
): void {
  for (const scope of scopes.values()) {
    publishAwarenessScope(scope.channel, scope.appOwner, scope.appName, scope.resource, scope.documentId);
  }
}

function deleteAwarenessLease(key: string): AwarenessLease | undefined {
  const lease = awarenessLeases.get(key);
  awarenessLeases.delete(key);
  const timer = awarenessExpiryTimers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  awarenessExpiryTimers.delete(key);
  return lease;
}

function scheduleAwarenessExpiry(key: string, lease: AwarenessLease): void {
  const previous = awarenessExpiryTimers.get(key);
  if (previous !== undefined) clearTimeout(previous);
  const timer = setTimeout(() => {
    const current = awarenessLeases.get(key);
    if (!current || current.clock !== lease.clock || current.expiresAt !== lease.expiresAt) return;
    deleteAwarenessLease(key);
    publishAwarenessScope(current.channel, current.appOwner, current.appName, current.resource, current.documentId);
  }, Math.max(0, lease.expiresAt - Date.now()));
  timer.unref?.();
  awarenessExpiryTimers.set(key, timer);
}

function normalizeEditingTarget(value: Record<string, unknown> | null): AwarenessEditingTarget | null {
  const surfaceId = validIdentifier(value?.surfaceId);
  const fieldId = value?.fieldId === undefined ? undefined : validIdentifier(value.fieldId);
  const kind = value?.kind ?? "field";
  if (!surfaceId || (value?.fieldId !== undefined && !fieldId) || !["field", "selection", "canvas"].includes(String(kind))) return null;
  const label = typeof value?.label === "string" ? value.label.trim().slice(0, 80) : undefined;
  const selectionRecord = asRecord(value?.selection);
  const selection = selectionRecord
    && typeof selectionRecord.anchor === "string" && selectionRecord.anchor.length <= 2048
    && typeof selectionRecord.head === "string" && selectionRecord.head.length <= 2048
    ? { anchor: selectionRecord.anchor, head: selectionRecord.head }
    : undefined;
  return {
    surfaceId,
    ...(fieldId ? { fieldId } : {}),
    ...(label ? { label } : {}),
    kind: kind as AwarenessEditingTarget["kind"],
    ...(selection ? { selection } : {}),
  };
}

function awarenessKey(channel: string, appOwner: string, appName: string, resource: string, documentId: string, clientId: string): string {
  return [channel, appOwner, appName, resource, documentId, clientId].join("\u0000");
}

function requestChannel(req: FastifyRequest): string {
  const verification = host.verification(req);
  return verification ? `verification:${verification.id}` : "live";
}

function validIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(normalized) ? normalized : null;
}

function validDocumentId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/.test(normalized) && !normalized.includes("..") ? normalized : null;
}

function validClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(normalized) ? normalized : null;
}

function decodeBase64Url(value: string, maxBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url payload");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength > maxBytes) throw new Error(`Payload exceeds ${maxBytes} bytes`);
  return bytes;
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function identityColor(userId: string): string {
  const digest = crypto.createHash("sha256").update(userId).digest();
  const hue = digest.readUInt16BE(0) % 360;
  return `hsl(${hue} 72% 48%)`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function invalid(reply: FastifyReply, error: string) {
  return reply.status(400).send({ success: false, code: "CRDT_REQUEST_INVALID", error });
}

function crdtError(reply: FastifyReply, error: unknown) {
  if (error instanceof CrdtStoreError) {
    return reply.status(error.status).send({ success: false, code: error.code, error: error.message });
  }
  return reply.status(500).send({ success: false, code: "CRDT_INTERNAL_ERROR", error: "CRDT operation failed" });
}

return {
  handleCrdtSync, handleCrdtUpdate, handleCrdtEvents, handleCrdtAwareness,
  dispose() {
    for (const close of [...activeStreams]) close();
    for (const timer of awarenessExpiryTimers.values()) clearTimeout(timer);
    awarenessExpiryTimers.clear(); awarenessLeases.clear(); crdtSseClients.clear();
  },
};
}
