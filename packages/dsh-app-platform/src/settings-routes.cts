import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { readPageMeta, writePageMeta, getPageDir } from "./page-storage.cjs";
import type { PageMeta } from "./page-storage.cjs";
import { materializeManifest, PlatformManifestValidationError, readManifestState, writePlatformManifest } from "./app-manifest.cjs";
import { getAppLifecycleStatus } from "./app-lifecycle.cjs";
export interface ApplicationSettingsHost {
  dataDir: string;
  visitorId(request: FastifyRequest): string | null | undefined;
}

const PLATFORM_EDITABLE_KEYS = ["description", "pageAccess", "shell", "db", "notify", "lifecycle"] as const;

export function applicationSettingsError(reply: FastifyReply, status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return reply.status(status).send({ success: false, code, error: message, ...extra });
}

export function resolveOwnedApplication(
  host: ApplicationSettingsHost,
  req: FastifyRequest<{ Params: { name: string } }>,
  reply: FastifyReply,
): { meta: PageMeta; pageDir: string; visitorId: string } | null {
  const visitorId = host.visitorId(req);
  if (!visitorId) {
    applicationSettingsError(reply, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    return null;
  }
  const meta = readPageMeta(host.dataDir, visitorId, req.params.name);
  if (!meta) {
    applicationSettingsError(reply, 404, "APP_NOT_FOUND", "Application not found");
    return null;
  }
  if (meta.userId !== visitorId) {
    applicationSettingsError(reply, 403, "APP_SETTINGS_FORBIDDEN", "Only the application owner can manage settings");
    return null;
  }
  return {
    meta,
    pageDir: getPageDir(host.dataDir, visitorId, req.params.name),
    visitorId,
  };
}

export function applicationSettingsPayload(meta: PageMeta, pageDir: string) {
  const state = readManifestState(pageDir, meta);
  return {
    app: {
      name: meta.name,
      userId: meta.userId,
      description: meta.description,
      currentVersion: meta.currentVersion,
      versionCount: meta.versions.length,
      versions: meta.versions,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lifecycleStatus: getAppLifecycleStatus(meta),
    },
    ...state,
    platformEditableKeys: PLATFORM_EDITABLE_KEYS,
  };
}

export async function registerApplicationSettings(app: FastifyInstance, host: ApplicationSettingsHost) {
  app.get<{ Params: { name: string } }>("/api/me/pages/:name/settings", async (req, reply) => {
    const owned = resolveOwnedApplication(host, req, reply);
    if (!owned) return;
    return { success: true, data: applicationSettingsPayload(owned.meta, owned.pageDir) };
  });

  app.put<{ Params: { name: string }; Body: unknown }>(
    "/api/me/pages/:name/settings/manifest-platform",
    async (req, reply) => {
      const owned = resolveOwnedApplication(host, req, reply);
      if (!owned) return;
      try {
        writePlatformManifest(owned.pageDir, req.body as Record<string, unknown>);
        const state = readManifestState(owned.pageDir, owned.meta);
        const updatedMeta = materializeManifest(owned.meta, state.effectiveManifest);
        updatedMeta.updatedAt = new Date().toISOString();
        writePageMeta(host.dataDir, owned.visitorId, owned.meta.name, updatedMeta);
        return { success: true, data: applicationSettingsPayload(updatedMeta, owned.pageDir) };
      } catch (caught) {
        if (caught instanceof PlatformManifestValidationError) {
          const forbidden = !PLATFORM_EDITABLE_KEYS.includes(caught.field as typeof PLATFORM_EDITABLE_KEYS[number]);
          return applicationSettingsError(
            reply,
            400,
            forbidden ? "PLATFORM_MANIFEST_FIELD_FORBIDDEN" : "PLATFORM_MANIFEST_INVALID",
            caught.message,
            { field: caught.field },
          );
        }
        throw caught;
      }
    },
  );

  app.put<{ Params: { name: string }; Body: unknown }>(
    "/api/me/pages/:name/lifecycle",
    async (req, reply) => {
      const owned = resolveOwnedApplication(host, req, reply);
      if (!owned) return;
      const status = typeof req.body === "object" && req.body !== null
        ? (req.body as { status?: unknown }).status
        : undefined;
      if (status !== "online" && status !== "offline") {
        return applicationSettingsError(
          reply,
          400,
          "APP_LIFECYCLE_STATUS_INVALID",
          "Application lifecycle status must be online or offline",
        );
      }

      const current = readManifestState(owned.pageDir, owned.meta);
      writePlatformManifest(owned.pageDir, {
        ...current.platformManifest,
        lifecycle: { status },
      });
      const state = readManifestState(owned.pageDir, owned.meta);
      const updatedMeta = materializeManifest(owned.meta, state.effectiveManifest);
      updatedMeta.updatedAt = new Date().toISOString();
      writePageMeta(host.dataDir, owned.visitorId, owned.meta.name, updatedMeta);
      return { success: true, data: applicationSettingsPayload(updatedMeta, owned.pageDir) };
    },
  );

}
