import type { FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";
import path from "node:path";
import { readPageMeta, getPageDir } from "@localapp/app-foundation/page-storage";
import { execRawSql, getDbPath, runDbTransaction } from "@localapp/app-foundation/app-db";
import { loadBackendContract, loadDefaultBackendContract, executeNamedSql } from "@localapp/app-foundation/backend-contract";
import { LocalAppRuntimeError } from "@localapp/app-foundation/runtime-errors";
import type { VisitorContext } from "@localapp/app-foundation/record-access";

export interface ApplicationCollaborationHost {
  visitor(request: FastifyRequest): VisitorContext;
  user(id: string): { name: string; displayName?: string | null; avatarUrl?: string | null } | null | undefined;
  verification(request: FastifyRequest): { version: number; databasePath: string } | null | undefined;
}

export function createApplicationCollaboration(host: ApplicationCollaborationHost) {
type CollaborationSseClient = {
  channel: string;
  userId: string;
  pageName: string;
  resource: string | null;
  write: (event: unknown) => void;
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

const collaborationSseClients = new Set<CollaborationSseClient>();

type PresenceSseClient = {
  channel: string;
  appOwner: string;
  appName: string;
  visitorKey: string;
  visitor: { id: string; name: string; displayName: string | null; avatarUrl: string | null } | null;
  canViewIdentities: boolean;
  write: (event: unknown) => void;
};

const presenceSseClients = new Set<PresenceSseClient>();
type PresenceVisitor = NonNullable<PresenceSseClient["visitor"]>;
type PresenceLease = {
  channel: string;
  appOwner: string;
  appName: string;
  visitorKey: string;
  visitor: PresenceVisitor | null;
  expiresAt: number;
};

const PRESENCE_LEASE_TTL_MS = 120_000;
const presenceLeases = new Map<string, PresenceLease>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureCollaborationTables(dbPath: string): void {
  execRawSql(dbPath, `
    CREATE TABLE IF NOT EXISTS _localapp_record_revisions (
      app_owner TEXT NOT NULL,
      app_name TEXT NOT NULL,
      resource TEXT NOT NULL,
      record_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (app_owner, app_name, resource, record_id)
    )
  `);
  execRawSql(dbPath, `
    CREATE TABLE IF NOT EXISTS _localapp_operation_log (
      id TEXT PRIMARY KEY,
      app_owner TEXT NOT NULL,
      app_name TEXT NOT NULL,
      resource TEXT NOT NULL,
      record_id TEXT NOT NULL,
      actor_id TEXT,
      operation_id TEXT NOT NULL,
      operation_kind TEXT,
      base_revision INTEGER NOT NULL,
      next_revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

function readRecordRevision(dbPath: string, userId: string, pageName: string, resource: string, recordId: string): number {
  const rows = execRawSql(
    dbPath,
    "SELECT revision FROM _localapp_record_revisions WHERE app_owner = ? AND app_name = ? AND resource = ? AND record_id = ?",
    [userId, pageName, resource, recordId],
  ).rows ?? [];
  const value = rows[0]?.revision;
  return typeof value === "number" ? value : 0;
}

function publishCollaborationCommitted(channel: string, event: {
  type: "collab:operation_committed";
  data: {
    appOwner: string;
    appName: string;
    resource: string;
    recordId: string;
    revision: number;
    actorId: string | null;
    operationId: string;
    patch?: Record<string, unknown>;
  };
}): void {
  for (const client of collaborationSseClients) {
    if (client.channel !== channel) continue;
    if (client.userId !== event.data.appOwner || client.pageName !== event.data.appName) continue;
    if (client.resource && client.resource !== event.data.resource) continue;
    client.write(event);
  }
}

async function handleCollaborationEvents(
  req: FastifyRequest,
  reply: FastifyReply,
  dataDir: string,
  userId: string,
  pageName: string,
) {
  const meta = readPageMeta(dataDir, userId, pageName);
  if (!meta?.collaboration?.enabled) {
    return reply.status(404).send({ success: false, error: "Collaboration is not enabled" });
  }

  const url = new URL(req.url, "http://localhost");
  const resource = url.searchParams.get("resource");
  const client: CollaborationSseClient = {
    channel: path.resolve(host.verification(req)?.databasePath ?? getDbPath(getPageDir(dataDir, userId, pageName))),
    userId,
    pageName,
    resource: resource?.trim() || null,
    write: (event) => {
      reply.raw.write(`event: collab:operation_committed\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    },
  };

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": connected\n\n");
  collaborationSseClients.add(client);
  trackStream(req, reply, () => collaborationSseClients.delete(client));
  reply.hijack();
}

function publishPresenceSnapshot(channel: string, appOwner: string, appName: string): void {
  pruneExpiredPresenceLeases();
  const authenticatedUsers = new Map<string, NonNullable<PresenceSseClient["visitor"]>>();
  const anonymousKeys = new Set<string>();
  for (const lease of presenceLeases.values()) {
    if (lease.channel !== channel) continue;
    if (lease.appOwner !== appOwner || lease.appName !== appName) continue;
    if (lease.visitor) authenticatedUsers.set(lease.visitor.id, lease.visitor);
    else anonymousKeys.add(lease.visitorKey);
  }
  for (const client of presenceSseClients) {
    if (client.channel !== channel) continue;
    if (client.appOwner !== appOwner || client.appName !== appName) continue;
    client.write({
      type: "presence:snapshot",
      data: {
        appOwner,
        appName,
        count: authenticatedUsers.size + anonymousKeys.size,
        anonymousCount: anonymousKeys.size,
        authenticatedUsers: client.canViewIdentities ? [...authenticatedUsers.values()] : [],
      },
    });
  }
}

function normalizePresenceClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clientId = value.trim();
  return /^[A-Za-z0-9_-]{1,100}$/.test(clientId) ? clientId : null;
}

function pruneExpiredPresenceLeases(now = Date.now()): void {
  for (const [key, lease] of presenceLeases) {
    if (lease.expiresAt <= now) presenceLeases.delete(key);
  }
}

function resolvePresenceLease(
  req: FastifyRequest,
  appOwner: string,
  appName: string,
  clientId: string,
): { key: string; lease: PresenceLease } {
  const visitor = host.visitor(req);
  const user = visitor.id ? host.user(visitor.id) : null;
  const visitorDetails = visitor.id ? {
    id: visitor.id,
    name: user?.name ?? visitor.name ?? visitor.id,
    displayName: user?.displayName ?? null,
    avatarUrl: user?.avatarUrl ?? null,
  } : null;
  const visitorKey = visitor.id ? `user:${visitor.id}:${clientId}` : `anon:${clientId}`;
  const channel = host.verification(req)?.databasePath ?? "live";
  return {
    key: `${channel}\u0000${appOwner}\u0000${appName}\u0000${visitorKey}`,
    lease: {
      channel,
      appOwner,
      appName,
      visitorKey,
      visitor: visitorDetails,
      expiresAt: Date.now() + PRESENCE_LEASE_TTL_MS,
    },
  };
}

function handlePresenceLeaseMutation(
  req: FastifyRequest,
  reply: FastifyReply,
  appOwner: string,
  appName: string,
  action: "heartbeat" | "leave",
) {
  const clientId = normalizePresenceClientId(isRecord(req.body) ? req.body.clientId : null);
  if (!clientId) {
    return reply.status(400).send({ success: false, code: "PRESENCE_CLIENT_ID_INVALID", error: "Valid clientId is required" });
  }
  pruneExpiredPresenceLeases();
  const resolved = resolvePresenceLease(req, appOwner, appName, clientId);
  if (action === "heartbeat") presenceLeases.set(resolved.key, resolved.lease);
  else presenceLeases.delete(resolved.key);
  publishPresenceSnapshot(resolved.lease.channel, appOwner, appName);
  return { success: true, data: { status: action === "heartbeat" ? "online" : "offline" } };
}

async function handlePresenceEvents(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  pageName: string,
) {
  const requestedClientId = normalizePresenceClientId((req.query as { clientId?: unknown } | undefined)?.clientId);
  const clientId = requestedClientId ?? crypto.randomUUID();
  const resolved = resolvePresenceLease(req, userId, pageName, clientId);
  const client: PresenceSseClient = {
    channel: resolved.lease.channel,
    appOwner: userId,
    appName: pageName,
    visitorKey: resolved.lease.visitorKey,
    visitor: resolved.lease.visitor,
    canViewIdentities: resolved.lease.visitor !== null,
    write: (event) => {
      reply.raw.write("event: presence:snapshot\n");
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    },
  };

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  presenceLeases.set(resolved.key, resolved.lease);
  presenceSseClients.add(client);
  publishPresenceSnapshot(resolved.lease.channel, userId, pageName);
  trackStream(req, reply, () => {
    presenceSseClients.delete(client);
    publishPresenceSnapshot(resolved.lease.channel, userId, pageName);
  });
  reply.hijack();
}

async function handleCollaborationCommit(
  req: FastifyRequest,
  reply: FastifyReply,
  dataDir: string,
  userId: string,
  pageName: string,
) {
  if (!isRecord(req.body)) {
    return reply.status(400).send({ success: false, error: "Collaboration commit body must be an object" });
  }
  if ("sql" in req.body) {
    return reply.status(400).send({ success: false, error: "Client SQL is not allowed in collaboration commits" });
  }

  const resource = typeof req.body.resource === "string" ? req.body.resource : "";
  const recordId = typeof req.body.recordId === "string" ? req.body.recordId : "";
  const baseRevision = typeof req.body.baseRevision === "number" ? req.body.baseRevision : NaN;
  const params = isRecord(req.body.params) ? req.body.params : undefined;
  if (!resource || !recordId || !Number.isInteger(baseRevision) || baseRevision < 0 || !params) {
    return reply.status(400).send({ success: false, error: "Collaboration commit requires resource, recordId, baseRevision and params" });
  }

  const meta = readPageMeta(dataDir, userId, pageName);
  const collaborationResource = meta?.collaboration?.enabled ? meta.collaboration.resources?.[resource] : undefined;
  if (!collaborationResource || collaborationResource.mode !== "record-versioned") {
    return reply.status(403).send({ success: false, error: `Collaboration resource is not declared: ${resource}` });
  }

  const pageDir = getPageDir(dataDir, userId, pageName);
  const contractDir = meta
    ? path.join(pageDir, "versions", `v${host.verification(req)?.version ?? meta.currentVersion}`)
    : pageDir;
  const contract = meta?.backend
    ? loadBackendContract(contractDir, meta.backend, { allowDisabledHostedActions: true })
    : loadDefaultBackendContract(contractDir, { allowDisabledHostedActions: true });
  if (!contract.mutations[collaborationResource.mutation]) {
    return reply.status(400).send({
      success: false,
      error: `Collaboration mutation is not declared in backend contract: ${collaborationResource.mutation}`,
    });
  }

  const dbPath = host.verification(req)?.databasePath ?? getDbPath(pageDir);
  const visitor = host.visitor(req);
  const actorId = visitor.id;
  const operationId = typeof req.body.operationId === "string" && req.body.operationId.trim()
    ? req.body.operationId
    : crypto.randomUUID();
  const operationKind = typeof req.body.operationKind === "string" ? req.body.operationKind : "save";
  const now = new Date().toISOString();

  try {
    const result = await runDbTransaction(dbPath, async () => {
      ensureCollaborationTables(dbPath);
      const currentRevision = readRecordRevision(dbPath, userId, pageName, resource, recordId);
      if (currentRevision !== baseRevision) {
        const conflict = new Error("revision_conflict") as Error & { code?: string; serverRevision?: number };
        conflict.code = "revision_conflict";
        conflict.serverRevision = currentRevision;
        throw conflict;
      }

      const mutationResult = await executeNamedSql(contract, {
        kind: "mutation",
        name: collaborationResource.mutation,
        dbPath,
        body: { params },
        context: {
          visitorId: actorId,
          ownerId: userId,
          now: new Date(now),
        },
        queue: { bypass: true },
      });

      const nextRevision = currentRevision + 1;
      execRawSql(
        dbPath,
        `INSERT INTO _localapp_record_revisions
          (app_owner, app_name, resource, record_id, revision, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_owner, app_name, resource, record_id)
         DO UPDATE SET revision = excluded.revision, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [userId, pageName, resource, recordId, nextRevision, actorId, now],
      );
      execRawSql(
        dbPath,
        `INSERT INTO _localapp_operation_log
          (id, app_owner, app_name, resource, record_id, actor_id, operation_id, operation_kind, base_revision, next_revision, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          userId,
          pageName,
          resource,
          recordId,
          actorId,
          operationId,
          operationKind,
          baseRevision,
          nextRevision,
          JSON.stringify({ params }),
          now,
        ],
      );

      return { revision: nextRevision, operationId, mutation: mutationResult };
    });

    publishCollaborationCommitted(path.resolve(dbPath), {
      type: "collab:operation_committed",
      data: {
        appOwner: userId,
        appName: pageName,
        resource,
        recordId,
        revision: result.revision,
        actorId,
        operationId,
        patch: params,
      },
    });

    return { success: true, data: result };
  } catch (err: any) {
    if (err?.code === "revision_conflict") {
      return reply.status(409).send({
        success: false,
        code: "revision_conflict",
        error: "Revision conflict",
        data: { serverRevision: err.serverRevision },
      });
    }
    const message = err?.message ?? "Collaboration commit failed";
    if (err instanceof LocalAppRuntimeError) {
      return reply.status(err.status).send({ success: false, error: message, code: err.code });
    }
    if (/access denied/i.test(message)) {
      if (!actorId) return reply.status(401).send({ success: false, error: "Authentication required" });
      return reply.status(403).send({ success: false, error: message });
    }
    return reply.status(400).send({ success: false, error: message });
  }
}


return {
  handleCollaborationEvents, handleCollaborationCommit,
  handlePresenceEvents, handlePresenceLeaseMutation,
  dispose() {
    for (const close of [...activeStreams]) close();
    collaborationSseClients.clear(); presenceSseClients.clear(); presenceLeases.clear();
  },
};
}
