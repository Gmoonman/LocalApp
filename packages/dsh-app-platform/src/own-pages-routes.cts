import type { FastifyInstance, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { readPageMeta, getPageDir } from "./page-storage.cjs";
import { removeDirRecursive } from "./file-utils.cjs";
import { closeConnectionsForPage } from "./app-db.cjs";
import { withAppDataMaintenance } from "./app-data-maintenance.cjs";
import { checkPageAccess } from "./access-control.cjs";
import { getAppLifecycleStatus } from "./app-lifecycle.cjs";
export interface OwnApplicationPagesHost {
  dataDir: string;
  visitorId(request: FastifyRequest): string | null | undefined;
  deleteAppObjects(owner: string, name: string): Promise<void>;
}

export async function registerOwnApplicationPages(app: FastifyInstance, host: OwnApplicationPagesHost) {
  const dataDir = () => host.dataDir;
  function requireSession(visitorId: string | null | undefined, reply: any): visitorId is string {
    if (visitorId) return true;
    reply.status(401).send({ success: false, error: "Authentication required" });
    return false;
  }
  app.get<{Querystring:{q?:string;page?:string;limit?:string}}>("/api/market/apps", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const query = (req.query.q ?? "").trim().toLocaleLowerCase();
    const page = Math.max(1, Math.min(Number.parseInt(req.query.page ?? "1", 10) || 1, 100000));
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit ?? "24", 10) || 24, 60));
    const visitor = host.visitorId(req);
    const apps = [];
    if (fs.existsSync(host.dataDir)) for (const owner of fs.readdirSync(host.dataDir, {withFileTypes:true})) {
      if (!owner.isDirectory() || owner.name.startsWith(".")) continue;
      for (const entry of fs.readdirSync(path.join(host.dataDir, owner.name), {withFileTypes:true})) {
        if (!entry.isDirectory()) continue;
        let meta;
        try { meta = readPageMeta(host.dataDir, owner.name, entry.name); } catch { continue; }
        if (!meta || meta.userId !== owner.name || meta.name !== entry.name || meta.currentVersion < 1 || meta.status === "needs-migration-repair" || getAppLifecycleStatus(meta) !== "online" || !checkPageAccess(meta.pageAccess, visitor, meta.userId)) continue;
        const item = {userId:meta.userId, name:meta.name, description:typeof meta.description === "string" ? meta.description : "", currentVersion:meta.currentVersion, updatedAt:meta.updatedAt ?? ""};
        if (query && ![item.name,item.description,item.userId].some(value=>value.toLocaleLowerCase().includes(query))) continue;
        apps.push(item);
      }
    }
    apps.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.userId.localeCompare(b.userId)||a.name.localeCompare(b.name));
    return {success:true,data:{apps:apps.slice((page-1)*limit,page*limit),total:apps.length,page,limit}};
  });
  // ── Session-auth page routes (/api/me/pages) ──

  // GET /api/me/pages — list current user's apps (session auth)
  app.get("/api/me/pages", async (req, reply) => {
    if (!requireSession(host.visitorId(req), reply)) return;
    const { limit } = req.query as { limit?: string };
    const userDir = path.join(dataDir(), host.visitorId(req)!);
    if (!fs.existsSync(userDir)) return { success: true, data: [] };

    const entries = fs.readdirSync(userDir, { withFileTypes: true });
    const pages = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = readPageMeta(dataDir(), host.visitorId(req)!, entry.name);
      if (meta) {
        pages.push({
          userId: meta.userId,
          name: meta.name,
          currentVersion: meta.currentVersion,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          lifecycleStatus: getAppLifecycleStatus(meta),
        });
      }
    }
    if (limit) {
      const n = Math.min(parseInt(limit, 10) || 50, 100);
      return { success: true, data: pages.slice(0, n) };
    }
    return { success: true, data: pages };
  });

  // GET /api/me/pages/:name — get app detail (session auth)
  app.get<{ Params: { name: string } }>("/api/me/pages/:name", async (req, reply) => {
    if (!requireSession(host.visitorId(req), reply)) return;
    const { name } = req.params;
    const meta = readPageMeta(dataDir(), host.visitorId(req)!, name);
    if (!meta) return reply.status(404).send({ success: false, error: "Page not found" });
    return {
      success: true,
      data: {
        name: meta.name,
        userId: meta.userId,
        currentVersion: meta.currentVersion,
        versionCount: meta.versions.length,
        versions: meta.versions,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        lifecycleStatus: getAppLifecycleStatus(meta),
      },
    };
  });

  // DELETE /api/me/pages/:name — delete app (session auth)
  app.delete<{ Params: { name: string } }>("/api/me/pages/:name", async (req, reply) => {
    if (!requireSession(host.visitorId(req), reply)) return;
    const { name } = req.params;
    const meta = readPageMeta(dataDir(), host.visitorId(req)!, name);
    if (!meta) return reply.status(404).send({ success: false, error: "Page not found" });
    if (meta.userId !== host.visitorId(req)!) return reply.status(403).send({ success: false, error: "Forbidden" });
    const pageDir = getPageDir(dataDir(), host.visitorId(req)!, name);
    await withAppDataMaintenance(pageDir, async () => {
      closeConnectionsForPage(pageDir);
      await host.deleteAppObjects(host.visitorId(req)!, name);
      removeDirRecursive(pageDir);
    });
    return { success: true, data: { deleted: true, name } };
  });

  // GET /api/pages/:userId/:name/meta — public page metadata
  app.get<{ Params: { userId: string; name: string } }>("/api/pages/:userId/:name/meta", async (req, reply) => {
    const { userId, name } = req.params;
    const meta = readPageMeta(dataDir(), userId, name);
    if (!meta) return reply.status(404).send({ success: false, error: "Page not found" });
    return {
      success: true,
      data: {
        name: meta.name,
        userId: meta.userId,
        description: meta.description,
        shell: meta.shell,
        notify: meta.notify,
        collaboration: meta.collaboration,
        lifecycleStatus: getAppLifecycleStatus(meta),
      },
    };
  });
}
