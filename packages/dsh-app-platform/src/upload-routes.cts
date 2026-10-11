import type {} from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseIssueTemplatesConfig, IssueTemplateConfigError } from "./issue-templates.cjs";
import type { ManifestDb, ShellConfig, NotifyConfig } from "./models.cjs";
import { AppInstallError, installAppPackage } from "./app-installer.cjs";
import { AppPackageValidationError, writeAppPackage, type PortablePackageFile } from "./app-package.cjs";
import { getUserTotalSize, readPageMeta, getPageDir } from "./page-storage.cjs";
import { validateNotifyConfig } from "./notify-config.cjs";
import { readManifestState } from "./app-manifest.cjs";

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const MAX_USER_STORAGE = 500 * 1024 * 1024;

function shellPageUrl(baseUrl: string, userId: string, pageName: string): string {
  return `${baseUrl}/${userId}/${pageName}/`;
}

function rawAppResourceUrl(baseUrl: string, userId: string, pageName: string): string {
  return `${baseUrl}/serve/${userId}/${pageName}/`;
}

export interface ApplicationUploadHost {
  dataDir: string;
  userId(request: unknown): string;
  displayName(userId: string): string | undefined;
  publicOrigin(request: unknown): string | null | undefined;
}

export async function registerApplicationUpload(app: FastifyInstance, host: ApplicationUploadHost) {
  app.post("/api/upload", async (req, reply) => {
    const dataDir = host.dataDir;
    const userId = host.userId(req);
    const uploaderDisplayName = host.displayName(userId);
    let pageName: string | undefined;
    let dbConfig: ManifestDb | undefined;
    let shellConfig: ShellConfig | undefined;
    let notifyConfig: NotifyConfig | undefined;
    let manifestBundle: Record<string, unknown> | undefined;
    let multipartFieldError: { path: string; error: string } | undefined;
    const files: Array<{ filename: string; buffer: Buffer }> = [];
    const backendFiles: Array<{ filename: string; buffer: Buffer }> = [];
    const migrations: Array<{ filename: string; buffer: Buffer }> = [];
    const migrationChecksums = new Map<string, string>();
    const filePaths = new Map<number, string>();
    const backendFilePaths = new Map<number, string>();

    const parts = req.parts({ limits: { fileSize: MAX_UPLOAD_SIZE } });
    for await (const part of parts) {
      if (part.type === "field" && (part.fieldname === "pageId" || part.fieldname === "name")) {
        pageName = String(part.value).trim();
      } else if (part.type === "field" && part.fieldname === "dbConfig") {
        try {
          dbConfig = parseMultipartObjectField(String(part.value), "dbConfig") as unknown as ManifestDb;
        } catch (error) {
          multipartFieldError ??= { path: "dbConfig", error: error instanceof Error ? error.message : String(error) };
        }
      } else if (part.type === "field" && part.fieldname === "shellConfig") {
        try {
          shellConfig = parseMultipartObjectField(String(part.value), "shellConfig") as ShellConfig;
        } catch (error) {
          multipartFieldError ??= { path: "shellConfig", error: error instanceof Error ? error.message : String(error) };
        }
      } else if (part.type === "field" && part.fieldname === "notifyConfig") {
        try {
          const validated = validateNotifyConfig(parseMultipartObjectField(String(part.value), "notifyConfig"));
          if (!validated) throw new Error("notifyConfig contains invalid configuration");
          notifyConfig = validated;
        } catch (error) {
          multipartFieldError ??= { path: "notifyConfig", error: error instanceof Error ? error.message : String(error) };
        }
      } else if (part.type === "field" && part.fieldname.startsWith("filepath_")) {
        const index = Number.parseInt(part.fieldname.slice("filepath_".length), 10);
        if (Number.isSafeInteger(index)) filePaths.set(index, String(part.value).trim());
      } else if (part.type === "field" && part.fieldname.startsWith("backendFilepath_")) {
        const index = Number.parseInt(part.fieldname.slice("backendFilepath_".length), 10);
        if (Number.isSafeInteger(index)) backendFilePaths.set(index, String(part.value).trim());
      } else if (part.type === "field" && part.fieldname.startsWith("migrationChecksum_")) {
        migrationChecksums.set(part.fieldname.slice("migrationChecksum_".length), String(part.value).trim());
      } else if (part.type === "file") {
        const buffer = await part.toBuffer();
        if (part.fieldname.startsWith("migration_")) migrations.push({ filename: part.filename, buffer });
        else if (part.fieldname === "manifest") {
          try {
            const parsed: unknown = JSON.parse(buffer.toString("utf8"));
            if (!isRecord(parsed)) throw new Error("manifest.json must contain an object");
            manifestBundle = parsed;
          } catch (error) {
            multipartFieldError ??= { path: "manifest", error: error instanceof Error ? error.message : "Invalid manifest.json" };
          }
        } else if (part.fieldname === "backendFiles") backendFiles.push({ filename: part.filename, buffer });
        else files.push({ filename: part.filename, buffer });
      }
    }

    if (multipartFieldError) {
      return reply.status(400).send({ success: false, code: "UPLOAD_MULTIPART_FIELD_INVALID", ...multipartFieldError });
    }
    if (files.length === 0) return reply.status(400).send({ success: false, error: "No files provided" });
    if (!pageName) return reply.status(400).send({ success: false, error: "Page name is required" });

    const totalUploadSize = files.reduce((total, file) => total + file.buffer.length, 0);
    if (totalUploadSize > MAX_UPLOAD_SIZE) return reply.status(413).send({ success: false, error: "Upload exceeds 50MB limit" });
    if (getUserTotalSize(dataDir, userId) + totalUploadSize > MAX_USER_STORAGE) {
      return reply.status(413).send({ success: false, error: "User storage limit exceeded" });
    }

    const meta = readPageMeta(dataDir, userId, pageName);
    if (!meta) return reply.status(404).send({ success: false, error: "Page not found" });
    if (meta.status === "needs-migration-repair") {
      return reply.status(409).send({ success: false, error: "App is marked needs-migration-repair. Repair platform migrations before uploading." });
    }
    if (manifestBundle) {
      try {
        parseIssueTemplatesConfig(manifestBundle);
      } catch (error) {
        if (error instanceof IssueTemplateConfigError) {
          return reply.status(400).send({ success: false, code: error.code, path: error.path, error: error.message });
        }
        throw error;
      }
    }

    const migrationError = validateDeclaredMigrationChecksums(migrations, migrationChecksums);
    if (migrationError) {
      return reply.status(400).send({ success: false, code: "UPLOAD_MIGRATION_INVALID", path: migrationError.path, error: migrationError.error });
    }

    const pageDir = getPageDir(dataDir, userId, pageName);
    const sourceManifest = manifestBundle
      ? { ...manifestBundle }
      : { ...readManifestState(pageDir, meta).sourceManifest };
    sourceManifest.name = pageName;
    sourceManifest.distDir = "dist";
    if (sourceManifest.db === undefined && dbConfig) sourceManifest.db = dbConfig;
    if (sourceManifest.shell === undefined && shellConfig) sourceManifest.shell = shellConfig;
    if (sourceManifest.notify === undefined && notifyConfig) sourceManifest.notify = notifyConfig;
    if (backendFiles.length > 0 && !isRecord(sourceManifest.backend)) sourceManifest.backend = { root: "backend" };

    const portableFiles: PortablePackageFile[] = [
      { path: "manifest.json", content: Buffer.from(JSON.stringify(sourceManifest)) },
      ...files.map((file, index) => ({ path: `dist/${filePaths.get(index) || file.filename}`, content: file.buffer })),
      ...backendFiles.map((file, index) => ({ path: backendFilePaths.get(index) || file.filename, content: file.buffer })),
      ...migrations.map((migration) => ({ path: `migrations/${migration.filename}`, content: migration.buffer })),
    ];
    if (!portableFiles.some((file) => file.path === "dist/index.html") && meta.currentVersion > 0) {
      const activeIndex = path.join(pageDir, "versions", `v${meta.currentVersion}`, "index.html");
      if (fs.existsSync(activeIndex)) portableFiles.push({ path: "dist/index.html", content: fs.readFileSync(activeIndex) });
    }
    if (!portableFiles.some((file) => file.path === "dist/index.html")) {
      portableFiles.push({ path: "dist/index.html", content: Buffer.from("<!doctype html>") });
    }
    const packageDir = path.join(dataDir, ".staging", "legacy-uploads", crypto.randomUUID());
    const packagePath = path.join(packageDir, `${pageName}.localapp`);
    fs.mkdirSync(packageDir, { recursive: true });
    try {
      const platformVersion = typeof sourceManifest.platformVersion === "string" ? sourceManifest.platformVersion : "^1.0";
      await writeAppPackage({
        outputPath: packagePath,
        metadata: {
          schemaVersion: 1,
          appId: pageName,
          version: `upload-${crypto.randomUUID()}`,
          platformVersion,
        },
        files: portableFiles,
      });
      const outcome = await installAppPackage({
        dataDir,
        ownerId: userId,
        packagePath,
        requireExisting: true,
        ...(uploaderDisplayName ? { uploaderDisplayName } : {}),
      });
      const baseUrl = host.publicOrigin(req) ?? "";
      return {
        success: true,
        data: {
          name: pageName,
          url: shellPageUrl(baseUrl, userId, pageName),
          rawUrl: rawAppResourceUrl(baseUrl, userId, pageName),
          version: outcome.localVersion,
        },
      };
    } catch (error) {
      return sendLegacyInstallError(reply, error);
    } finally {
      fs.rmSync(packageDir, { recursive: true, force: true });
    }
  });
}

function validateDeclaredMigrationChecksums(
  migrations: Array<{ filename: string; buffer: Buffer }>,
  declared: Map<string, string>,
): { path: string; error: string } | null {
  for (const migration of migrations) {
    const expected = declared.get(migration.filename);
    if (!expected) return { path: migration.filename, error: `Migration ${migration.filename} checksum missing` };
    const actual = crypto.createHash("sha256").update(migration.buffer).digest("hex");
    if (expected !== actual) return { path: migration.filename, error: `Migration ${migration.filename} checksum mismatch` };
  }
  return null;
}

function sendLegacyInstallError(
  reply: { status: (code: number) => { send: (payload: unknown) => unknown } },
  error: unknown,
): unknown {
  if (error instanceof AppPackageValidationError) {
    return reply.status(400).send({ success: false, code: "UPLOAD_PACKAGE_INVALID", ...(error.path ? { path: error.path } : {}), error: error.message });
  }
  if (error instanceof AppInstallError) {
    const migrationApply = error.code === "APP_MIGRATION_APPLY_FAILED";
    const migrationConflict = error.code === "APP_MIGRATION_CONFLICT";
    const manifestInvalid = error.code === "APP_MANIFEST_INVALID";
    const message = migrationConflict ? error.message.replace("missing from this package", "missing from this upload") : error.message;
    return reply.status(migrationApply ? 422 : error.statusCode).send({
      success: false,
      ...(migrationApply ? { code: "UPLOAD_MIGRATION_APPLY_FAILED" } : {}),
      ...(migrationConflict ? { code: "UPLOAD_MIGRATION_CONFLICT" } : {}),
      ...(manifestInvalid ? { code: "UPLOAD_MANIFEST_INVALID" } : {}),
      ...(error.path ? { path: error.path } : {}),
      error: message,
    });
  }
  return reply.status(400).send({ success: false, error: error instanceof Error ? error.message : String(error) });
}

function parseMultipartObjectField(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} must contain valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${field} must contain an object`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
