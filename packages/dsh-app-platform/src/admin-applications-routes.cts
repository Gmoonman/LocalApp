import type { FastifyInstance } from "fastify";
import type { Database } from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { readPageMeta, getPageDir, getUserTotalSize } from "./page-storage.cjs";
import { removeDirRecursive, getDirectorySize } from "./file-utils.cjs";
import { closeConnectionsForPage } from "./app-db.cjs";
import { withAppDataMaintenance } from "./app-data-maintenance.cjs";
export interface AdministratorApplicationsHost {
  dataDir: string;
  database(): Database;
  totalUsers(): number;
  deleteAppObjects(owner: string, name: string): Promise<void>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

export async function registerAdministratorApplications(app: FastifyInstance, host: AdministratorApplicationsHost) {
  const dataDir = host.dataDir;

  // GET /api/admin/pages — global page list
  app.get("/api/admin/pages", async (req) => {
    const filterUserId = (req.query as any).userId as string | undefined;
    const page = Math.max(1, parseInt((req.query as any).page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query as any).limit || "20", 10)));

    const allPages: Array<{
      name: string;
      userId: string;
      description: string;
      currentVersion: number;
      totalSize: number;
      createdAt: string;
      updatedAt: string;
    }> = [];

    if (!fs.existsSync(dataDir)) {
      return { success: true, data: [], pagination: { page, limit, total: 0 } };
    }

    const userDirs = fs.readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (!filterUserId || e.name === filterUserId));

    for (const userDir of userDirs) {
      const userPath = path.join(dataDir, userDir.name);
      const pageDirs = fs.readdirSync(userPath, { withFileTypes: true });
      for (const pageDir of pageDirs) {
        if (!pageDir.isDirectory()) continue;
        const meta = readPageMeta(dataDir, userDir.name, pageDir.name);
        if (meta) {
          const totalSize = meta.versions.reduce((sum, v) => sum + v.totalSize, 0);
          allPages.push({
            name: meta.name,
            userId: meta.userId,
            description: meta.description,
            currentVersion: meta.currentVersion,
            totalSize,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
          });
        }
      }
    }

    allPages.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const total = allPages.length;
    const offset = (page - 1) * limit;
    const data = allPages.slice(offset, offset + limit);

    return { success: true, data, pagination: { page, limit, total } };
  });

  // GET /api/admin/pages/:userId/:name — page detail
  app.get<{ Params: { userId: string; name: string } }>("/api/admin/pages/:userId/:name", async (req, reply) => {
    const { userId, name } = req.params;
    const meta = readPageMeta(dataDir, userId, name);
    if (!meta) {
      return reply.status(404).send({ success: false, error: "Page not found" });
    }

    const pageDir = getPageDir(dataDir, userId, name);
    const storageUsed = fs.existsSync(pageDir) ? getDirectorySize(pageDir) : 0;

    return {
      success: true,
      data: {
        ...meta,
        storageBytes: storageUsed,
        storageUsed: formatSize(storageUsed),
      },
    };
  });

  // DELETE /api/admin/pages/:userId/:name — delete page
  app.delete<{ Params: { userId: string; name: string } }>("/api/admin/pages/:userId/:name", async (req, reply) => {
    const { userId, name } = req.params;
    const meta = readPageMeta(dataDir, userId, name);
    if (!meta) {
      return reply.status(404).send({ success: false, error: "Page not found" });
    }

    const pageDir = getPageDir(dataDir, userId, name);
    await withAppDataMaintenance(pageDir, async () => {
      closeConnectionsForPage(pageDir);
      await host.deleteAppObjects(userId, name);
      removeDirRecursive(pageDir);
    });

    return { success: true, data: { deleted: true, userId, name } };
  });

  // GET /api/admin/stats — system overview
  app.get("/api/admin/stats", async () => {
    let totalUsers = 0;
    let totalPages = 0;
    let totalStorage = 0;
    let totalSchemas = 0;
    const recentDeploys: Array<{ pageName: string; userId: string; version: number; createdAt: string }> = [];

    totalUsers = host.totalUsers();

    if (fs.existsSync(dataDir)) {
      const userDirs = fs.readdirSync(dataDir, { withFileTypes: true });

      for (const userDir of userDirs) {
        if (!userDir.isDirectory()) continue;
        totalStorage += getUserTotalSize(dataDir, userDir.name);
        const userPath = path.join(dataDir, userDir.name);
        const pageDirs = fs.readdirSync(userPath, { withFileTypes: true });
        for (const pageDir of pageDirs) {
          if (!pageDir.isDirectory()) continue;
          const meta = readPageMeta(dataDir, userDir.name, pageDir.name);
          if (meta) {
            totalPages++;
            if (meta.schemas) totalSchemas += meta.schemas.length;
            // Collect latest version as recent deploy
            const latestVersion = meta.versions[meta.versions.length - 1];
            if (latestVersion) {
              recentDeploys.push({
                pageName: meta.name,
                userId: meta.userId,
                version: latestVersion.version,
                createdAt: latestVersion.createdAt,
              });
            }
          }
        }
      }
    }

    recentDeploys.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      success: true,
      data: {
        users: { total: totalUsers },
        pages: { total: totalPages, totalSize: formatSize(totalStorage), totalBytes: totalStorage },
        schemas: { total: totalSchemas },
        recentDeploys: recentDeploys.slice(0, 10),
      },
    };
  });

  // --- Analytics routes ---

  function parsePeriod(period: string): string {
    if (period === "1d") return "-1 days";
    if (period === "30d") return "-30 days";
    return "-7 days";
  }

  function queryScalar(sql: string, params?: (string | number | null | Uint8Array)[]): Record<string, unknown> {
    const d = host.database();
    const stmt = d.prepare(sql);
    if (params) stmt.bind(params);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }

  // GET /api/admin/analytics/overview?period=7d
  app.get("/api/admin/analytics/overview", async (req) => {
    const period = (req.query as any).period || "7d";
    const interval = parsePeriod(period);

    const totalRequests = (queryScalar("SELECT COUNT(*) as c FROM request_logs WHERE created_at >= datetime('now', ?)", [interval]) as { c: number }).c;
    const uniqueVisitors = (queryScalar("SELECT COUNT(DISTINCT COALESCE(visitor_id, user_id)) as c FROM request_logs WHERE created_at >= datetime('now', ?)", [interval]) as { c: number }).c;
    const pageViews = (queryScalar("SELECT COUNT(*) as c FROM page_views WHERE created_at >= datetime('now', ?)", [interval]) as { c: number }).c;
    const avgRow = queryScalar("SELECT AVG(duration_ms) as avg FROM request_logs WHERE created_at >= datetime('now', ?)", [interval]) as { avg: number | null };
    const errors = (queryScalar("SELECT COUNT(*) as c FROM request_logs WHERE status >= 400 AND created_at >= datetime('now', ?)", [interval]) as { c: number }).c;

    return {
      success: true,
      data: {
        period,
        totalRequests,
        uniqueVisitors,
        pageViews,
        avgResponseMs: avgRow.avg ? Math.round(avgRow.avg) : 0,
        errorRate: totalRequests > 0 ? Number(((errors / totalRequests) * 100).toFixed(1)) : 0,
      },
    };
  });

  // GET /api/admin/analytics/trends?range=7d
  app.get("/api/admin/analytics/trends", async (req) => {
    const range = (req.query as any).range || "7d";
    const interval = parsePeriod(range);
    const d = host.database();

    // Get dates with requests
    const reqStmt = d.prepare("SELECT DATE(created_at) as date, COUNT(*) as requests FROM request_logs WHERE created_at >= datetime('now', ?) GROUP BY DATE(created_at) ORDER BY date");
    reqStmt.bind([interval]);
    const reqByDate: Record<string, number> = {};
    while (reqStmt.step()) {
      const row = reqStmt.getAsObject() as { date: string; requests: number };
      reqByDate[row.date] = row.requests;
    }
    reqStmt.free();

    // Get page views by date
    const pvStmt = d.prepare("SELECT DATE(created_at) as date, COUNT(*) as views FROM page_views WHERE created_at >= datetime('now', ?) GROUP BY DATE(created_at)");
    pvStmt.bind([interval]);
    const pvByDate: Record<string, number> = {};
    while (pvStmt.step()) {
      const row = pvStmt.getAsObject() as { date: string; views: number };
      pvByDate[row.date] = row.views;
    }
    pvStmt.free();

    // Get new users by date
    const userStmt = d.prepare("SELECT DATE(created_at) as date, COUNT(*) as cnt FROM users WHERE created_at >= datetime('now', ?) AND provider = 'local' GROUP BY DATE(created_at)");
    userStmt.bind([interval]);
    const usersByDate: Record<string, number> = {};
    while (userStmt.step()) {
      const row = userStmt.getAsObject() as { date: string; cnt: number };
      usersByDate[row.date] = row.cnt;
    }
    userStmt.free();

    // Merge all dates
    const allDates = new Set([...Object.keys(reqByDate), ...Object.keys(pvByDate), ...Object.keys(usersByDate)]);
    const trends = [...allDates].sort().map((date) => ({
      date,
      requests: reqByDate[date] || 0,
      pageViews: pvByDate[date] || 0,
      newUsers: usersByDate[date] || 0,
    }));

    return { success: true, data: trends };
  });

  // GET /api/admin/analytics/pages?period=7d&limit=20
  app.get("/api/admin/analytics/pages", async (req) => {
    const period = (req.query as any).period || "7d";
    const limit = Math.min(100, Math.max(1, parseInt((req.query as any).limit || "20", 10)));
    const interval = parsePeriod(period);
    const d = host.database();

    const stmt = d.prepare("SELECT page_path as pagePath, COUNT(*) as views, COUNT(DISTINCT visitor_id) as uniqueVisitors FROM page_views WHERE created_at >= datetime('now', ?) GROUP BY page_path ORDER BY views DESC LIMIT ?");
    stmt.bind([interval, limit]);

    const pages: Array<{ pagePath: string; pageName: string; userId: string; views: number; uniqueVisitors: number }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { pagePath: string; views: number; uniqueVisitors: number };
      const parts = row.pagePath.split("/").filter(Boolean);
      pages.push({
        pagePath: row.pagePath,
        pageName: parts[1] || row.pagePath,
        userId: parts[0] || "",
        views: row.views,
        uniqueVisitors: row.uniqueVisitors,
      });
    }
    stmt.free();

    return { success: true, data: pages };
  });

}
