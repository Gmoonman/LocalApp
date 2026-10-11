import type { Database } from "sql.js";
export interface AnalyticsPersistence { database(): Database; flush(): void }

export interface RequestLogEntry {
  path: string;
  method: string;
  status: number;
  durationMs: number;
  userId: string | null;
  visitorId: string | null;
}

export interface PageViewEntry {
  pagePath: string;
  visitorId: string | null;
  userId?: string | null;
}

export function initializeAnalyticsSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      method TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      user_id TEXT,
      visitor_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_request_logs_path ON request_logs(path)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_path TEXT NOT NULL,
      visitor_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(page_path)`);

  // Add user_id column to page_views if missing
  {
    const cols = db.prepare("PRAGMA table_info(page_views)");
    const colNames: string[] = [];
    while (cols.step()) {
      const row = cols.getAsObject() as { name: string };
      colNames.push(row.name);
    }
    cols.free();
    if (!colNames.includes("user_id")) {
      db.run("ALTER TABLE page_views ADD COLUMN user_id TEXT");
    }
  }

  db.run(`CREATE INDEX IF NOT EXISTS idx_page_views_user ON page_views(user_id)`);

}

export class AnalyticsStore {
  constructor(private readonly persistence: AnalyticsPersistence) {}
  insertRequestLogs(entries: RequestLogEntry[]): void {
    if (entries.length === 0) return;
    const d = this.persistence.database();
    const stmt = d.prepare("INSERT INTO request_logs (path, method, status, duration_ms, user_id, visitor_id) VALUES (?, ?, ?, ?, ?, ?)");
    for (const e of entries) {
      stmt.run([e.path, e.method, e.status, e.durationMs, e.userId, e.visitorId]);
    }
    stmt.free();
    this.persistence.flush();
  }

  insertPageViews(entries: PageViewEntry[]): void {
    if (entries.length === 0) return;
    const d = this.persistence.database();
    const stmt = d.prepare("INSERT INTO page_views (page_path, visitor_id, user_id) VALUES (?, ?, ?)");
    for (const e of entries) {
      stmt.run([e.pagePath, e.visitorId, e.userId ?? null]);
    }
    stmt.free();
    this.persistence.flush();
  }

  cleanOldLogs(days = 30): void {
    const d = this.persistence.database();
    d.run(`DELETE FROM request_logs WHERE created_at < datetime('now', '-${days} days')`);
    d.run(`DELETE FROM page_views WHERE created_at < datetime('now', '-${days} days')`);
    this.persistence.flush();
  }

}
