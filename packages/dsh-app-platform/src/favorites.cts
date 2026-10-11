import type { Database } from "sql.js";
export interface FavoritesPersistence { database(): Database; flush(): void }
export interface FavoriteRecord {
  id: number;
  userId: string;
  pagePath: string;
  pageName: string | null;
  ownerName: string | null;
  createdAt: string;
}
export interface RecentVisitRecord {
  pagePath: string;
  lastVisitedAt: string;
}
export class FavoritesStore {
  constructor(private readonly persistence: FavoritesPersistence) {}
  // ── Favorites ──


  addFavorite(userId: string, pagePath: string, pageName?: string, ownerName?: string): void {
    const d = this.persistence.database();
    d.run(
      "INSERT OR IGNORE INTO favorites (user_id, page_path, page_name, owner_name) VALUES (?, ?, ?, ?)",
      [userId, pagePath, pageName ?? null, ownerName ?? null]
    );
    this.persistence.flush();
  }

  removeFavorite(userId: string, pagePath: string): void {
    const d = this.persistence.database();
    d.run("DELETE FROM favorites WHERE user_id = ? AND page_path = ?", [userId, pagePath]);
    this.persistence.flush();
  }

  isFavorited(userId: string, pagePath: string): boolean {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT 1 FROM favorites WHERE user_id = ? AND page_path = ?");
    stmt.bind([userId, pagePath]);
    const result = stmt.step();
    stmt.free();
    return result;
  }

  getFavoriteCount(pagePath: string): number {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT COUNT(*) as cnt FROM favorites WHERE page_path = ?");
    stmt.bind([pagePath]);
    stmt.step();
    const count = (stmt.getAsObject() as { cnt: number }).cnt;
    stmt.free();
    return count;
  }

  listUserFavorites(userId: string, limit: number): FavoriteRecord[] {
    const d = this.persistence.database();
    const stmt = d.prepare(
      "SELECT id, user_id, page_path, page_name, owner_name, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
    );
    stmt.bind([userId, limit]);
    const result: FavoriteRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id: number; user_id: string; page_path: string; page_name: string | null; owner_name: string | null; created_at: string };
      result.push({
        id: row.id,
        userId: row.user_id,
        pagePath: row.page_path,
        pageName: row.page_name,
        ownerName: row.owner_name,
        createdAt: row.created_at,
      });
    }
    stmt.free();
    return result;
  }

  // ── Visit History ──


  listRecentVisits(userId: string, limit: number): RecentVisitRecord[] {
    const d = this.persistence.database();
    const stmt = d.prepare(`
      SELECT page_path, MAX(created_at) as last_visited_at
      FROM page_views
      WHERE user_id = ?
      GROUP BY page_path
      ORDER BY last_visited_at DESC
      LIMIT ?
    `);
    stmt.bind([userId, limit]);
    const result: RecentVisitRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { page_path: string; last_visited_at: string };
      result.push({ pagePath: row.page_path, lastVisitedAt: row.last_visited_at });
    }
    stmt.free();
    return result;
  }
}
