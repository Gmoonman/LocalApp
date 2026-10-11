import type { FastifyInstance, FastifyRequest } from "fastify";
export interface KeyRoutesHost {
  createApiKey(userId: string): { key: string; userId: string; createdAt: string };
  getUserRole(userId: string): string | null;
  listApiKeysByUser(userId: string): Array<{ key: string; createdAt: string }>;
  userId(request: FastifyRequest): string;
}

export async function registerKeyRoutes(app: FastifyInstance, host: KeyRoutesHost) {
  const { createApiKey, getUserRole, listApiKeysByUser } = host;
  app.post("/api/keys", async (req, reply) => {
    const body = req.body as { userId?: unknown } | undefined;
    if (body && Object.prototype.hasOwnProperty.call(body, "userId")
      && (typeof body.userId !== "string" || body.userId.length === 0)) {
      return reply.status(400).send({
        success: false,
        code: "API_KEY_INVALID_USER_ID",
        error: "userId must be a non-empty string",
      });
    }
    const targetUserId = typeof body?.userId === "string" ? body.userId : host.userId(req);
    if (!targetUserId) {
      return { success: false, error: "userId is required" };
    }
    if (targetUserId !== host.userId(req) && getUserRole(host.userId(req)) !== "admin") {
      return reply.status(403).send({
        success: false,
        code: "API_KEY_USER_MISMATCH",
        error: "A user may only create an API key for their own account",
      });
    }

    const record = createApiKey(targetUserId);
    return { success: true, data: record };
  });

  app.get("/api/keys", async (req) => {
    const keys = listApiKeysByUser(host.userId(req));
    return { success: true, data: keys };
  });
}
