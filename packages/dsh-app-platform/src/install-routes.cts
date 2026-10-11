import type {} from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  activateAppVersion,
  AppInstallError,
  installAppPackage,
  rollbackAppVersion,
} from "./app-installer.cjs";
import { MAX_APP_PACKAGE_BYTES } from "./app-package.cjs";
import { readPageMeta } from "./page-storage.cjs";
import { validateName } from "./validate-name.cjs";

export interface ApplicationInstallHost {
  dataDir: string;
  userId(request: unknown): string;
  user(userId: string): { displayName?: string | null } | undefined | null;
}

export async function registerApplicationInstall(app: FastifyInstance, host: ApplicationInstallHost) {
  app.post("/api/me/apps/install", async (req, reply) => {
    const uploadDir = path.join(host.dataDir, ".staging", "app-uploads", crypto.randomUUID());
    const packagePath = path.join(uploadDir, "application.localapp");
    fs.mkdirSync(uploadDir, { recursive: true });
    try {
      let received = false;
      const parts = req.parts({ limits: { files: 1, fileSize: MAX_APP_PACKAGE_BYTES } });
      for await (const part of parts) {
        if (part.type !== "file") continue;
        if (received || part.fieldname !== "package") {
          part.file.resume();
          throw new AppInstallError("APP_PACKAGE_REQUIRED", "Exactly one package file is required", 400);
        }
        if (path.extname(part.filename).toLowerCase() !== ".localapp") {
          part.file.resume();
          throw new AppInstallError("APP_PACKAGE_REQUIRED", "Application package filename must end in .localapp", 400);
        }
        received = true;
        await pipeline(part.file, fs.createWriteStream(packagePath, { flags: "wx", mode: 0o600 }));
        if (part.file.truncated) {
          throw new AppInstallError("APP_PACKAGE_TOO_LARGE", `Application package exceeds ${MAX_APP_PACKAGE_BYTES} bytes`, 413);
        }
      }
      if (!received) throw new AppInstallError("APP_PACKAGE_REQUIRED", "Application package file is required", 400);
      const user = host.user(host.userId(req));
      const outcome = await installAppPackage({
        dataDir: host.dataDir,
        ownerId: host.userId(req),
        packagePath,
        ...(user?.displayName ? { uploaderDisplayName: user.displayName } : {}),
      });
      return reply.status(outcome.idempotent ? 200 : 201).send({ success: true, data: outcome });
    } catch (error) {
      return sendInstallError(reply, error);
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  app.get<{ Params: { name: string } }>("/api/me/apps/:name/versions", async (req, reply) => {
    const nameError = validateName(req.params.name);
    if (nameError) return reply.status(400).send({ success: false, code: "APP_NAME_INVALID", error: nameError });
    const meta = readPageMeta(host.dataDir, host.userId(req), req.params.name);
    if (!meta) return reply.status(404).send({ success: false, code: "APP_NOT_FOUND", error: "Application not found" });
    return {
      success: true,
      data: {
        name: meta.name,
        currentVersion: meta.currentVersion,
        currentAppVersion: meta.currentAppVersion ?? null,
        versions: meta.versions,
      },
    };
  });

  app.post<{ Params: { name: string; version: string } }>("/api/me/apps/:name/versions/:version/activate", async (req, reply) => {
    const nameError = validateName(req.params.name);
    if (nameError) return reply.status(400).send({ success: false, code: "APP_NAME_INVALID", error: nameError });
    const localVersion = Number(req.params.version);
    if (!Number.isSafeInteger(localVersion) || localVersion < 1) {
      return reply.status(400).send({ success: false, code: "APP_VERSION_INVALID", error: "Version must be a positive deployment sequence" });
    }
    try {
      const outcome = await activateAppVersion({
        dataDir: host.dataDir,
        ownerId: host.userId(req),
        name: req.params.name,
        localVersion,
      });
      return { success: true, data: outcome };
    } catch (error) {
      return sendInstallError(reply, error);
    }
  });

  app.post<{ Params: { name: string } }>("/api/me/apps/:name/rollback", async (req, reply) => {
    const nameError = validateName(req.params.name);
    if (nameError) return reply.status(400).send({ success: false, code: "APP_NAME_INVALID", error: nameError });
    try {
      const outcome = await rollbackAppVersion({
        dataDir: host.dataDir,
        ownerId: host.userId(req),
        name: req.params.name,
      });
      return { success: true, data: outcome };
    } catch (error) {
      return sendInstallError(reply, error);
    }
  });
}

function sendInstallError(
  reply: { status: (code: number) => { send: (payload: unknown) => unknown } },
  error: unknown,
): unknown {
  if (error instanceof AppInstallError) {
    return reply.status(error.statusCode).send({
      success: false,
      code: error.code,
      ...(error.path ? { path: error.path } : {}),
      error: error.message,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return reply.status(400).send({ success: false, code: "APP_INSTALL_FAILED", error: message });
}
