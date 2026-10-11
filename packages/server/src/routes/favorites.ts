import type { FastifyInstance } from "fastify";
import { addFavorite, removeFavorite, isFavorited, getFavoriteCount, listUserFavorites, listRecentVisits } from "../lib/meta-sqlite.js";
import { requireRequestUser, resolveRequestUser } from "../plugins/auth.js";

import { registerApplicationFavorites, type ApplicationFavoritesHost } from "@localapp/dsh-app-platform/favorites-routes";
export function createApplicationFavoritesHost(): ApplicationFavoritesHost {
  return { addFavorite, removeFavorite, isFavorited, getFavoriteCount, listUserFavorites,
    listRecentVisits, requireRequestUser, resolveRequestUser };
}
export async function favoritesRoutes(app: FastifyInstance) {
  await registerApplicationFavorites(app, createApplicationFavoritesHost());
}
