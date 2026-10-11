import type {} from "@fastify/multipart";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  writePageMeta,
  type PageMeta,
} from "./page-storage.cjs";
import {
  materializeManifest,
  readManifestState,
  writePlatformManifest,
  removePlatformManifest,
} from "./app-manifest.cjs";
import {
  AppDataError,
  createAppBackup,
  deleteAppBackup,
  getAppBackup,
  getAppBackupPath,
  listAppBackups,
  restoreAppBackup,
} from "./app-backups.cjs";
import {
  createAppDataExport,
  importAppData,
  resetApplicationData,
  type AppDataIdentity,
} from "./app-data-service.cjs";
import { closeConnectionsForPage, withDbQueue } from "./app-db.cjs";
import { listAppObjects } from "./content-storage.cjs";

import { resolveOwnedApplication, applicationSettingsPayload as settingsPayload, applicationSettingsError as error, type ApplicationSettingsHost } from "./settings-routes.cjs";
function confirmationMatches(body: unknown, name: string): boolean {
  return typeof body === "object" && body !== null && (body as { confirmName?: unknown }).confirmName === name;
}

function dataError(reply: FastifyReply, caught: unknown) {
  if (caught && typeof caught === "object") {
    const code = "code" in caught ? String(caught.code) : "";
    const name = "name" in caught ? String(caught.name) : "";
    if (code === "ENOSPC" || code === "EDQUOT" || name === "QuotaExceededError" || name === "StorageFull") {
      return error(reply, 507, "APP_DATA_STORAGE_EXHAUSTED", "Application data storage has insufficient capacity");
    }
  }
  if (!(caught instanceof AppDataError)) throw caught;
  const status = caught.code === "APP_DATA_OPERATION_BUSY" || caught.code === "APP_DATA_MAINTENANCE"
    || caught.code === "APP_MIGRATIONS_UNAVAILABLE"
    ? 409
    : caught.code.endsWith("NOT_FOUND")
      ? 404
      : caught.code === "APP_ARCHIVE_LIMIT_EXCEEDED"
        ? 413
        : caught.code === "APP_DATABASE_SCHEMA_INCOMPATIBLE" || caught.code === "APP_DATABASE_FOREIGN_KEY_INVALID"
          ? 422
          : caught.code === "APP_DATA_ROLLBACK_FAILED"
            ? 503
            : 400;
  return error(reply, status, caught.code, caught.message);
}

function attachmentName(name: string, suffix: string, extension: "zip" | "db"): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, "-") || "app";
  return `${safe}-${suffix}.${extension}`;
}

function appIdentity(meta: PageMeta): AppDataIdentity {
  return { owner: meta.userId, name: meta.name, version: meta.currentVersion };
}

function archiveLimits(host: ApplicationDataSettingsHost) {
  return {
    maxCompressedBytes: host.appDataArchiveMaxBytes,
    maxExpandedBytes: host.appDataExpandedMaxBytes,
    maxFileEntries: host.appDataArchiveMaxFiles,
  };
}

export interface ApplicationDataSettingsHost extends ApplicationSettingsHost {
  appDataArchiveMaxBytes: number; appDataExpandedMaxBytes: number; appDataArchiveMaxFiles: number;
}
export async function registerApplicationDataSettings(app: FastifyInstance, host: ApplicationDataSettingsHost) {
  app.get<{ Params: { name: string } }>("/api/me/pages/:name/data", async (req, reply) => {
    const owned = resolveOwnedApplication(host, req, reply);
    if (!owned) return;
    const dbPath = path.join(owned.pageDir, "app.db");
    const database = await withDbQueue(dbPath, async () => {
      closeConnectionsForPage(owned.pageDir);
      return fs.existsSync(dbPath) ? { exists: true, size: fs.statSync(dbPath).size } : { exists: false, size: 0 };
    });
    const objects = await listAppObjects(owned.meta.userId, owned.meta.name);
    return {
      success: true,
      data: {
        database,
        files: { count: objects.length, size: objects.reduce((total, object) => total + object.size, 0) },
        backups: listAppBackups(owned.pageDir),
      },
    };
  });

  app.get<{ Params: { name: string } }>("/api/me/pages/:name/data/export", async (req, reply) => {
    const owned = resolveOwnedApplication(host, req, reply);
    if (!owned) return;
    try {
      const exported = await createAppDataExport({
        pageDir: owned.pageDir,
        application: appIdentity(owned.meta),
        limits: archiveLimits(host),
      });
      const cleanup = () => exported.cleanup();
      reply.raw.once("close", cleanup);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", `attachment; filename="${attachmentName(owned.meta.name, stamp, "zip")}"`);
      reply.header("Cache-Control", "no-store");
      return reply.send(fs.createReadStream(exported.archivePath));
    } catch (caught) {
      return dataError(reply, caught);
    }
  });

  app.post<{ Params: { name: string }; Body: { name?: string } }>("/api/me/pages/:name/data/backups", async (req, reply) => {
    const owned = resolveOwnedApplication(host, req, reply);
    if (!owned) return;
    try {
      const backup = await createAppBackup(owned.pageDir, {
        name: req.body?.name,
        source: "manual",
        application: appIdentity(owned.meta),
        limits: archiveLimits(host),
      });
      return { success: true, data: backup };
    } catch (caught) {
      return dataError(reply, caught);
    }
  });

  app.get<{ Params: { name: string; backupId: string } }>("/api/me/pages/:name/data/backups/:backupId/download", async (req, reply) => {
    const owned = resolveOwnedApplication(host, req, reply);
    if (!owned) return;
    try {
      const backupPath = getAppBackupPath(owned.pageDir, req.params.backupId);
      const backup = getAppBackup(owned.pageDir, req.params.backupId);
      const extension = backup.format === "zip" ? "zip" : "db";
      reply.header("Content-Type", backup.format === "zip" ? "application/zip" : "application/vnd.sqlite3");
      reply.header("Content-Disposition", `attachment; filename="${attachmentName(owned.meta.name, `backup-${req.params.backupId}`, extension)}"`);
      reply.header("Cache-Control", "no-store");
      return reply.send(fs.createReadStream(backupPath));
    } catch (caught) {
      return dataError(reply, caught);
    }
  });

  app.post<{ Params: { name: string; backupId: string }; Body: unknown }>("/api/me/pages/:name/data/backups/:backupId/restore", async (req, reply) => {
    const owned = resolveOwnedApplication(host, req, reply);
    if (!owned) return;
    if (!confirmationMatches(req.body, owned.meta.name)) return error(reply, 400, "APP_CONFIRMATION_MISMATCH", "Application name confirmation does not match");
    try {
      await restoreAppBackup(owned.pageDir, req.params.backupId, {
        application: appIdentity(owned.meta),
        limits: archiveLimits(host),
      });
      return { success: true, data: { restored: true, backupId: req.params.backupId } };
    } catch (caught) {
      return dataError(reply, caught);
    }
  });

  app.delete<{ Params: { name: string; backupId: string } }>("/api/me/pages/:name/data/backups/:backupId", async (req, reply) => {
    const owned = resolveOwnedApplication(host, req, reply);
    if (!owned) return;
    try {
      await deleteAppBackup(owned.pageDir, req.params.backupId);
      return { success: true, data: { deleted: true, backupId: req.params.backupId } };
    } catch (caught) {
      return dataError(reply, caught);
    }
  });

  app.post<{ Params: { name: string } }>("/api/me/pages/:name/data/import", async (req, reply) => {
    const owned = resolveOwnedApplication(host, req, reply);
    if (!owned) return;
    let confirmName = "";
    fs.mkdirSync(path.join(owned.pageDir, ".data-operations"), { recursive: true });
    const archivePath = path.join(owned.pageDir, ".data-operations", `upload-${crypto.randomUUID()}.zip`);
    let archiveReceived = false;
    try {
      for await (const part of req.parts({ limits: { fileSize: host.appDataArchiveMaxBytes, files: 1 } })) {
        if (part.type === "field" && part.fieldname === "confirmName") confirmName = String(part.value);
        if (part.type === "file" && part.fieldname === "archive") {
          archiveReceived = true;
          await pipeline(part.file, fs.createWriteStream(archivePath, { mode: 0o600 }));
          if (part.file.truncated) throw new AppDataError("APP_ARCHIVE_LIMIT_EXCEEDED", "Compressed archive exceeds size limit");
        }
      }
    } catch (caught) {
      fs.rmSync(archivePath, { force: true });
      if (caught instanceof AppDataError) return dataError(reply, caught);
      return error(reply, 413, "APP_ARCHIVE_LIMIT_EXCEEDED", "Compressed archive exceeds size limit");
    }
    try {
      if (confirmName !== owned.meta.name) return error(reply, 400, "APP_CONFIRMATION_MISMATCH", "Application name confirmation does not match");
      if (!archiveReceived) return error(reply, 400, "APP_ARCHIVE_FILE_REQUIRED", "Application data ZIP file is required");
      const imported = await importAppData({
        pageDir: owned.pageDir,
        application: appIdentity(owned.meta),
        archivePath,
        reason: "import",
        limits: archiveLimits(host),
      });
      return { success: true, data: { imported: true, ...imported } };
    } catch (caught) {
      return dataError(reply, caught);
    } finally {
      fs.rmSync(archivePath, { force: true });
    }
  });

  app.post<{ Params: { name: string }; Body: unknown }>("/api/me/pages/:name/data/factory-reset", async (req, reply) => {
    const owned = resolveOwnedApplication(host, req, reply);
    if (!owned) return;
    if (!confirmationMatches(req.body, owned.meta.name)) return error(reply, 400, "APP_CONFIRMATION_MISMATCH", "Application name confirmation does not match");
    const platformPath = path.join(owned.pageDir, "manifest.platform.json");
    const platformBytes = fs.existsSync(platformPath) ? fs.readFileSync(platformPath) : null;
    try {
      const reset = await resetApplicationData({
        pageDir: owned.pageDir,
        application: appIdentity(owned.meta),
        limits: archiveLimits(host),
      });
      try {
        removePlatformManifest(owned.pageDir);
        const state = readManifestState(owned.pageDir, owned.meta);
        const updatedMeta = materializeManifest(owned.meta, state.effectiveManifest);
        updatedMeta.updatedAt = new Date().toISOString();
        writePageMeta(host.dataDir, owned.visitorId, owned.meta.name, updatedMeta);
      } catch (caught) {
        await restoreAppBackup(owned.pageDir, reset.safetyBackupId, {
          application: appIdentity(owned.meta),
          limits: archiveLimits(host),
        });
        if (platformBytes) writePlatformManifest(owned.pageDir, JSON.parse(platformBytes.toString("utf8")) as Record<string, unknown>);
        throw caught;
      }
      return { success: true, data: { reset: true, safetyBackupId: reset.safetyBackupId } };
    } catch (caught) {
      return dataError(reply, caught);
    }
  });
}
