import type { FastifyInstance, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { getPageDir, readPageMeta } from "./page-storage.cjs";
import { closeConnectionsForPage, withDbQueue } from "./app-db.cjs";
import { assertAppDataWritable } from "./app-data-maintenance.cjs";

export interface ApplicationDatabaseHost { dataDir: string; userId(request: FastifyRequest): string }
export async function registerApplicationDatabase(app: FastifyInstance, host: ApplicationDatabaseHost) {
  app.get<{ Querystring: { name?: string } }>("/api/db/snapshot", async (req, reply) => {
    const pageName = req.query.name;
    if (!pageName) {
      return reply.status(400).send({ success: false, error: "name is required" });
    }

    const pageDir = getPageDir(host.dataDir, host.userId(req), pageName);
    const meta = readPageMeta(host.dataDir, host.userId(req), pageName);
    if (!meta) {
      return reply.status(404).send({ success: false, error: "Page not found" });
    }

    const dbPath = path.join(pageDir, "app.db");
    const bytes = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : Buffer.alloc(0);
    return reply.type("application/octet-stream").send(bytes);
  });

  app.post<{ Body: { name?: string; backup?: string } }>("/api/db/restore", async (req, reply) => {
    const { name, backup } = req.body ?? {};
    if (!name || !backup) {
      return reply.status(400).send({ success: false, error: "name and backup are required" });
    }
    if (!/^v[12]$/.test(backup)) {
      return reply.status(400).send({ success: false, error: "Invalid backup" });
    }

    const pageDir = getPageDir(host.dataDir, host.userId(req), name);
    const meta = readPageMeta(host.dataDir, host.userId(req), name);
    if (!meta) {
      return reply.status(404).send({ success: false, error: "Page not found" });
    }

    const backupPath = path.join(pageDir, `app.db.backup.${backup}`);
    if (!fs.existsSync(backupPath)) {
      return reply.status(404).send({ success: false, error: `Backup ${backup} not found` });
    }

    const dbPath = path.join(pageDir, "app.db");
    await withDbQueue(dbPath, async () => {
      assertAppDataWritable(pageDir);
      closeConnectionsForPage(pageDir);
      fs.copyFileSync(backupPath, dbPath);
    });
    return { success: true, data: { name, backup } };
  });
}
