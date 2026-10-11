import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SubscriptionStore, SubscriptionLevel } from "./subscriptions.cjs";
export interface SubscriptionRoutesHost {
  userId(request: FastifyRequest): string | null;
  store: Pick<SubscriptionStore, "upsertSubscription" | "deleteSubscription" | "listSubscriptionsByUser" | "getSubscriptionStatus">;
}

const ALLOWED_LEVELS = new Set(["all", "important", "muted"]);

function requireAuth(req: FastifyRequest, reply: FastifyReply, host: SubscriptionRoutesHost): string | null {
  const userId = host.userId(req);
  if (!userId) {
    reply.status(401).send({ success: false, error: "Authentication required" });
    return null;
  }
  return userId;
}

function validateSubscriptionBody(body: unknown): { app_owner: string; app_name: string; level: SubscriptionLevel } | { error: string } {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  const { app_owner, app_name, level } = obj;
  if (typeof app_owner !== "string" || app_owner.length === 0) {
    return { error: "app_owner is required" };
  }
  if (typeof app_name !== "string" || app_name.length === 0) {
    return { error: "app_name is required" };
  }
  if (typeof level !== "string" || !ALLOWED_LEVELS.has(level)) {
    return { error: "level must be one of: all, important, muted" };
  }
  return { app_owner, app_name, level: level as SubscriptionLevel };
}

export async function registerApplicationSubscriptions(app: FastifyInstance, host: SubscriptionRoutesHost) {
  // POST /api/subscriptions — 创建或更新订阅
  app.post("/api/subscriptions", async (req, reply) => {
    const userId = requireAuth(req, reply, host);
    if (!userId) return;

    const validation = validateSubscriptionBody(req.body);
    if ("error" in validation) {
      return reply.status(400).send({ success: false, error: validation.error });
    }

    const existed = host.store.getSubscriptionStatus(userId, validation.app_owner, validation.app_name);
    host.store.upsertSubscription(userId, validation.app_owner, validation.app_name, validation.level);

    return reply.status(existed ? 200 : 201).send({
      success: true,
      data: {
        app_owner: validation.app_owner,
        app_name: validation.app_name,
        level: validation.level,
      },
    });
  });

  // DELETE /api/subscriptions/:owner/:name — 退订
  app.delete<{ Params: { owner: string; name: string } }>(
    "/api/subscriptions/:owner/:name",
    async (req, reply) => {
      const userId = requireAuth(req, reply, host);
      if (!userId) return;

      const { owner, name } = req.params;
      host.store.deleteSubscription(userId, owner, name);
      return { success: true, data: { unsubscribed: true } };
    },
  );

  // GET /api/subscriptions — 列出当前用户全部订阅
  app.get("/api/subscriptions", async (req, reply) => {
    const userId = requireAuth(req, reply, host);
    if (!userId) return;

    const subs = host.store.listSubscriptionsByUser(userId);
    return { success: true, data: subs };
  });

  // GET /api/subscriptions/:owner/:name/status — 查询订阅状态
  app.get<{ Params: { owner: string; name: string } }>(
    "/api/subscriptions/:owner/:name/status",
    async (req, reply) => {
      const userId = requireAuth(req, reply, host);
      if (!userId) return;

      const { owner, name } = req.params;
      const status = host.store.getSubscriptionStatus(userId, owner, name);
      return { success: true, data: status };
    },
  );
}
