import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { DeliveryPage } from "./notification-delivery.cjs";
import type { InboxItem, InboxPage } from "./notifications.cjs";
export interface ApplicationInboxHost {
  listInbox(userId: string, options: { limit: number; cursor?: string; unreadOnly: boolean }): InboxPage;
  getUnreadCount(userId: string): number;
  markRead(userId: string, id: string): InboxItem | null;
  softDelete(userId: string, id: string): boolean;
  markAllRead(userId: string): number;
  getInboxItem(userId: string, id: string): InboxItem | null;
  listDeliverableNotifications(userId: string, query: ParsedDeliveryQuery): DeliveryPage;
  requireRequestUser(request: FastifyRequest, reply: FastifyReply): string | null;
}

const DELIVERY_QUERY_FIELDS = new Set(["afterSequence", "limit", "since"]);
const MAX_DELIVERY_CATCH_UP_AGE_MS = 24 * 60 * 60 * 1000;

export interface ParsedDeliveryQuery {
  afterSequence: number;
  limit: number;
  since?: string;
}

export function parseDeliveryQuery(rawUrl: string, now = Date.now()): ParsedDeliveryQuery | null {
  let searchParams: URLSearchParams;
  try {
    searchParams = new URL(rawUrl, "http://localapp.invalid").searchParams;
  } catch {
    return null;
  }
  for (const key of searchParams.keys()) {
    if (!DELIVERY_QUERY_FIELDS.has(key)) return null;
  }

  const afterValues = searchParams.getAll("afterSequence");
  if (afterValues.length !== 1 || !isCanonicalUnsignedDecimal(afterValues[0])) return null;
  const afterSequence = Number(afterValues[0]);
  if (!Number.isSafeInteger(afterSequence)) return null;

  const limitValues = searchParams.getAll("limit");
  if (limitValues.length > 1) return null;
  let limit = 100;
  if (limitValues.length === 1) {
    if (!isCanonicalUnsignedDecimal(limitValues[0])) return null;
    limit = Number(limitValues[0]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  }

  const sinceValues = searchParams.getAll("since");
  if (sinceValues.length > 1) return null;
  if (sinceValues.length === 0) return { afterSequence, limit };
  const since = sinceValues[0];
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(since)) return null;
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs) || new Date(sinceMs).toISOString() !== since) return null;
  if (sinceMs > now || sinceMs < now - MAX_DELIVERY_CATCH_UP_AGE_MS) {
    return null;
  }
  return { afterSequence, limit, since };
}

function isCanonicalUnsignedDecimal(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value);
}

export async function registerApplicationInbox(app: FastifyInstance, host: ApplicationInboxHost) {
  const { listInbox, getUnreadCount, markRead, softDelete, markAllRead, getInboxItem,
    listDeliverableNotifications, requireRequestUser } = host;
  app.get("/api/inbox/delivery", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;

    const query = parseDeliveryQuery(req.url);
    if (!query) {
      return reply.status(400).send({ success: false, error: "Invalid delivery query" });
    }
    return { success: true, data: listDeliverableNotifications(userId, query) };
  });

  // GET /api/inbox?limit=&cursor=&unreadOnly=true — 分页查询
  app.get("/api/inbox", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;

    const { limit, cursor, unreadOnly } = req.query as {
      limit?: string;
      cursor?: string;
      unreadOnly?: string;
    };
    const page = listInbox(userId, {
      limit: limit ? parseInt(limit, 10) : 20,
      cursor: cursor || undefined,
      unreadOnly: unreadOnly === "true",
    });
    return { success: true, data: page };
  });

  app.get<{ Params: { id: string } }>("/api/inbox/:id", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;
    const item = getInboxItem(userId, req.params.id);
    if (!item) return reply.status(404).send({ success: false, error: "Notification not found" });
    return { success: true, data: item };
  });

  // GET /api/inbox/unread-count — 未读计数
  app.get("/api/inbox/unread-count", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;

    return { success: true, data: { count: getUnreadCount(userId) } };
  });

  // PATCH /api/inbox/:id — 标记已读
  app.patch<{ Params: { id: string } }>("/api/inbox/:id", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;

    const { id } = req.params;
    const updated = markRead(userId, id);
    if (!updated) {
      return reply.status(404).send({ success: false, error: "Notification not found" });
    }
    return { success: true, data: updated };
  });

  // DELETE /api/inbox/:id — 软删除
  app.delete<{ Params: { id: string } }>("/api/inbox/:id", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;

    const { id } = req.params;
    const ok = softDelete(userId, id);
    if (!ok) {
      return reply.status(404).send({ success: false, error: "Notification not found" });
    }
    return { success: true, data: { deleted: true } };
  });

  // POST /api/inbox/read-all — 批量已读
  app.post("/api/inbox/read-all", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;

    const updated = markAllRead(userId);
    return { success: true, data: { updated } };
  });
}
