import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { RequestUserResolution } from "@localapp/dsh-multiuser/request-identity";
import type { FavoriteRecord, RecentVisitRecord } from "./favorites.cjs";
export interface ApplicationFavoritesHost {
  addFavorite(userId: string, pagePath: string, pageName?: string, ownerName?: string): void;
  removeFavorite(userId: string, pagePath: string): void;
  isFavorited(userId: string, pagePath: string): boolean;
  getFavoriteCount(pagePath: string): number;
  listUserFavorites(userId: string, limit: number): FavoriteRecord[];
  listRecentVisits(userId: string, limit: number): RecentVisitRecord[];
  requireRequestUser(request: FastifyRequest, reply: FastifyReply): string | null;
  resolveRequestUser(request: FastifyRequest): RequestUserResolution;
}

export async function registerApplicationFavorites(app: FastifyInstance, host: ApplicationFavoritesHost) {
  const { addFavorite, removeFavorite, isFavorited, getFavoriteCount, listUserFavorites,
    listRecentVisits, requireRequestUser, resolveRequestUser } = host;
  // POST /api/favorites — add favorite
  app.post("/api/favorites", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;
    const { pagePath, pageName, ownerName } = req.body as { pagePath: string; pageName?: string; ownerName?: string };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath is required" });
    addFavorite(userId, pagePath, pageName, ownerName);
    return { success: true, data: { favorited: true } };
  });

  // DELETE /api/favorites/:pagePath — remove favorite
  app.delete("/api/favorites/:pagePath", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;
    const { pagePath } = req.params as { pagePath: string };
    removeFavorite(userId, decodeURIComponent(pagePath));
    return { success: true, data: { favorited: false } };
  });

  // GET /api/favorites/check?pagePath=... — check if favorited
  app.get("/api/favorites/check", async (req, reply) => {
    const { pagePath } = req.query as { pagePath: string };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath is required" });
    const resolution = resolveRequestUser(req);
    if (!resolution.ok && resolution.reason === "invalid-api-key") {
      return reply.status(401).send({ success: false, error: "Invalid API key" });
    }
    const favorited = resolution.ok ? isFavorited(resolution.userId, pagePath) : false;
    return { success: true, data: { favorited } };
  });

  // GET /api/favorites/count?pagePath=... — get favorite count
  app.get("/api/favorites/count", async (req, reply) => {
    const { pagePath } = req.query as { pagePath: string };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath is required" });
    const count = getFavoriteCount(pagePath);
    return { success: true, data: { count } };
  });

  // GET /api/me/favorites?limit=N — list current user's favorites
  app.get("/api/me/favorites", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;
    const { limit } = req.query as { limit?: string };
    const n = Math.min(parseInt(limit ?? "50", 10) || 50, 100);
    const data = listUserFavorites(userId, n);
    return { success: true, data };
  });

  // GET /api/me/recent?limit=N — list current user's recent visits
  app.get("/api/me/recent", async (req, reply) => {
    const userId = requireRequestUser(req, reply);
    if (!userId) return;
    const { limit } = req.query as { limit?: string };
    const n = Math.min(parseInt(limit ?? "10", 10) || 10, 50);
    const data = listRecentVisits(userId, n);
    return { success: true, data };
  });
}
