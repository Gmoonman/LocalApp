import { createApplicationCollaboration, type ApplicationCollaborationHost } from "./collaboration-handler.cjs";
import { handleApplicationNotification } from "./notify-handler.cjs";
import { handleApplicationData, handleActionRequest } from "./data-handler.cjs";
import { registerApplicationResources } from "./resource-routes.cjs";
import { registerApplicationShell } from "./shell-routes.cjs";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { getPageDir, readPageMeta } from "./page-storage.cjs";
import { matchAppApiRoute } from "./app-api-contract.cjs";
import type { VisitorContext } from "./record-access.cjs";
import { shouldRegisterNotify } from "./notify-policy.cjs";
import {
  VERIFICATION_APP_COOKIE,
  VERIFICATION_ME_COOKIE,
  VERIFICATION_SHELL_COOKIE,
  type VerificationCheck,
  type VerificationSessionContext,
} from "./verification-sessions.cjs";

declare module "fastify" {
  interface FastifyRequest {
    verificationSession?: VerificationSessionContext | null;
  }
}

import { createApplicationCrdt } from "./crdt-handler.cjs";
import { handleContentUpload as uploadContent, handleContentRead as readContent } from "./content-handler.cjs";
import { ContentBundles, BundleError, canExportFile, validateBundleFiles } from "./content-bundles.cjs";
import { openObject } from "./content-storage.cjs";
import type * as ContentStorage from "./content-storage.cjs";
import type { ApplicationNotificationHost } from "./notify-handler.cjs";
import type { ApplicationShellHost } from "./shell-routes.cjs";
import type { VerificationSessionStore } from "./verification-sessions.cjs";
import type { createDesktopActionRoutes } from "./desktop-actions-routes.cjs";
import type { createDeviceActionRoutes } from "./device-actions-routes.cjs";
import type {} from "@fastify/cookie";
export interface ApplicationEntryHost {
  onStop?(cleanup: () => void): void;
  collaborationEnabled?:boolean;
  deviceServicesEnabled?:boolean;
  createCrdt?: typeof createApplicationCrdt;
  createCollaboration?: typeof createApplicationCollaboration;
  webRoot: string;
  dataDir(request?: FastifyRequest): string;
  previewData?(request: FastifyRequest): { databasePath: string; ownerId: string; readSource: "test" | "production"; writeSource: "test" | "production" } | undefined;
  visitorId(request: FastifyRequest): string | null | undefined;
  visitorName(request: FastifyRequest): string | null | undefined;
  userId(request: FastifyRequest): string | null | undefined;
  now(request: FastifyRequest): string | undefined;
  keyOwner(key: string): string | null;
  user: ApplicationCollaborationHost["user"];
  userCount(): number;
  pushPageView: ApplicationShellHost["pushPageView"];
  notifications: Pick<ApplicationNotificationHost, "resolveRecipients" | "persistNotifications">;
  storage: Pick<typeof ContentStorage, "putObject" | "getObject"> & Partial<Pick<typeof ContentStorage, "openObject">>;
  sessions: VerificationSessionStore;
  desktopAction: ReturnType<typeof createDesktopActionRoutes>["handleDesktopActionCreation"];
  deviceAction: ReturnType<typeof createDeviceActionRoutes>["handleDeviceActionCreation"];
}
export async function registerApplicationEntry(app: FastifyInstance, host: ApplicationEntryHost) {
  const { user: findUserById, keyOwner: validateApiKey, pushPageView, desktopAction: handleDesktopActionCreation, deviceAction: handleDeviceActionCreation } = host;
  const { resolveRecipients, persistNotifications } = host.notifications;
  const handleContentUpload = (req: FastifyRequest, reply: FastifyReply, owner: string, name: string, pageDir?: string, responseContentBase?: string, uploader?: string) => uploadContent(req, reply, owner, name, pageDir, host.storage, responseContentBase, uploader);
  const handleContentRead = (req: FastifyRequest, reply: FastifyReply, owner: string, name: string, key: string) => readContent(req, reply, owner, name, key, host.storage);
const HTML_404 = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not Found</title></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:system-ui;background:#f8f9fa"><div style="text-align:center"><h1 style="font-size:2rem;color:#1a1d23">404</h1><p style="color:#6b7280">Page not found.</p><a href="/" style="color:#2563eb">Back to home</a></div></body></html>`;


function buildServerTime(now: string): { now: string; today: string } {
  return {
    now,
    today: now.slice(0, 10),
  };
}

  const crdt = host.collaborationEnabled===false ? undefined : (host.createCrdt ?? createApplicationCrdt)({ visitorId: host.visitorId, verification: request => request.verificationSession, user: host.user, validateApiKey: host.keyOwner });
  const unavailable=async(_req:FastifyRequest,reply:FastifyReply,..._args:unknown[])=>reply.code(404).send({success:false,error:"Plugin is not enabled"});
  const { handleCrdtAwareness, handleCrdtEvents, handleCrdtSync, handleCrdtUpdate } = crdt ?? {handleCrdtAwareness:unavailable,handleCrdtEvents:unavailable,handleCrdtSync:unavailable,handleCrdtUpdate:unavailable};
  app.addHook("onClose", async () => crdt?.dispose());
  host.onStop?.(() => crdt?.dispose());
  const collaboration = host.collaborationEnabled===false ? undefined : (host.createCollaboration ?? createApplicationCollaboration)({
    visitor: visitorFromReq, user: findUserById,
    verification: request => request.verificationSession,
  });
  const { handleCollaborationEvents, handleCollaborationCommit, handlePresenceEvents, handlePresenceLeaseMutation } = collaboration ?? {handleCollaborationEvents:unavailable,handleCollaborationCommit:unavailable,handlePresenceEvents:unavailable,handlePresenceLeaseMutation:unavailable};
  app.addHook("onClose", async () => collaboration?.dispose());
  host.onStop?.(() => collaboration?.dispose());
  const bundles = new ContentBundles(path.join(host.dataDir(), ".content-bundles"), host.storage.openObject ?? openObject);
  app.addHook("onClose", async () => { await bundles.close(); });
  host.onStop?.(() => bundles.close());
  const webOutDir = host.webRoot;
  const dataDir = host.dataDir;

  // Serve Next.js HTML pages for auth routes
  function serveNextHtml(page: string) {
    const filePath = path.join(webOutDir, `${page}.html`);
    return async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const html = fs.readFileSync(filePath, "utf-8");
        reply.type("text/html").send(html);
      } catch {
        reply.status(404).send({ success: false, error: "Page not found" });
      }
    };
  }

  app.get("/", serveNextHtml("index"));
  app.get("/market", serveNextHtml("market"));
  app.get("/market.txt", async (_req, reply) => {
    try { return reply.type("text/x-component").send(fs.readFileSync(path.join(host.webRoot, "market.txt"))); }
    catch { return reply.status(404).send(""); }
  });

  app.get("/setup", async (_req, reply) => {
    if (host.userCount() !== 0) return reply.status(404).type("text/html").send(HTML_404);
    return serveNextHtml("setup")(_req, reply);
  });

  app.get("/setup.txt", async (_req, reply) => {
    if (host.userCount() !== 0) return reply.status(404).send("");
    try {
      return reply.type("text/plain; charset=utf-8").send(fs.readFileSync(path.join(webOutDir, "setup.txt"), "utf-8"));
    } catch {
      return reply.status(404).send("");
    }
  });

  app.get("/api/home/stats", async (req) => {
    let totalPages = 0;
    let totalSchemas = 0;
    let totalDeploys = 0;
    let monthDeploys = 0;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    if (fs.existsSync(dataDir(req))) {
      const userDirs = fs.readdirSync(dataDir(req), { withFileTypes: true });
      for (const userDir of userDirs) {
        if (!userDir.isDirectory()) continue;
        const userPath = path.join(dataDir(req), userDir.name);
        const pageDirs = fs.readdirSync(userPath, { withFileTypes: true });
        for (const pageDir of pageDirs) {
          if (!pageDir.isDirectory()) continue;
          const meta = readPageMeta(dataDir(req), userDir.name, pageDir.name);
          if (!meta) continue;

          totalPages += 1;
          totalSchemas += meta.schemas?.length ?? 0;
          totalDeploys += meta.versions.length;
          for (const version of meta.versions) {
            const createdAt = new Date(version.createdAt);
            if (!Number.isNaN(createdAt.getTime()) && createdAt >= monthStart) {
              monthDeploys += 1;
            }
          }
        }
      }
    }

    return {
      success: true,
      data: {
        users: host.userCount(),
        pages: totalPages,
        schemas: totalSchemas,
        deploys: totalDeploys,
        monthDeploys,
      },
    };
  });

  await registerApplicationShell(app, {
    webRoot: webOutDir,
    dataDir: request => dataDir(request),
    visitorId: request => host.visitorId(request),
    userId: request => host.userId(request),
    verification: (request, owner, name) => resolveVerification(app, request, owner, name, VERIFICATION_SHELL_COOKIE),
    pushPageView,
  });

  await registerApplicationResources(app, {
    dataDir: request => dataDir(request),
    visitorId: request => host.visitorId(request),
    validateApiKey,
    verification: (request, owner, name) => {
      request.verificationSession = resolveVerification(app, request, owner, name, VERIFICATION_APP_COOKIE);
      return request.verificationSession;
    },
    handleApi: async (req, reply, meta, userId, pageName, restPath) => {
      const isDesktopActionCreation = restPath === "api/desktop-actions" && req.method === "POST";
      const isDeviceActionCreation = restPath === "api/device-actions" && req.method === "POST";
      if(host.deviceServicesEnabled===false && (isDesktopActionCreation||isDeviceActionCreation||restPath==="api/notify"))return unavailable(req,reply);
        if (restPath === "api/_verification/report" && req.method === "POST") {
          return handleVerificationReport(app, req, reply, userId, pageName);
        }

        if (req.verificationSession && (isDesktopActionCreation || isDeviceActionCreation || restPath === "api/notify")) {
          return reply.status(409).send({
            success: false,
            error: "This platform side effect is disabled during isolated verification",
            code: "verification_side_effect_blocked",
          });
        }

        if (isDesktopActionCreation) {
          return handleDesktopActionCreation(req, reply, meta, userId, pageName);
        }
        if (isDeviceActionCreation) {
          return handleDeviceActionCreation(req, reply, meta, userId, pageName);
        }

        const appRoute = matchAppApiRoute(req.method, restPath.slice("api".length));

        if (appRoute.kind === "time") {
          return { success: true, data: buildServerTime(host.now(req) ?? new Date().toISOString()) };
        }

        if (restPath === "api/collaboration/commit" && req.method === "POST") {
          return handleCollaborationCommit(req, reply, dataDir(req), userId, pageName);
        }

        if (restPath === "api/collaboration/events" && req.method === "GET") {
          return handleCollaborationEvents(req, reply, dataDir(req), userId, pageName);
        }

        if (restPath === "api/crdt/sync" && req.method === "POST") {
          return handleCrdtSync(req, reply, dataDir(req), userId, pageName);
        }

        if (restPath === "api/crdt/update" && req.method === "POST") {
          return handleCrdtUpdate(req, reply, dataDir(req), userId, pageName);
        }

        if (restPath === "api/crdt/events" && req.method === "GET") {
          return handleCrdtEvents(req, reply, dataDir(req), userId, pageName);
        }

        if (restPath === "api/crdt/awareness" && req.method === "POST") {
          return handleCrdtAwareness(req, reply, dataDir(req), userId, pageName);
        }

        if (restPath === "api/presence/events" && req.method === "GET") {
          return handlePresenceEvents(req, reply, userId, pageName);
        }

        if (restPath === "api/presence/heartbeat" && req.method === "POST") {
          return handlePresenceLeaseMutation(req, reply, userId, pageName, "heartbeat");
        }

        if (restPath === "api/presence/leave" && req.method === "POST") {
          return handlePresenceLeaseMutation(req, reply, userId, pageName, "leave");
        }

        if (appRoute.kind === "action") {
          return handleActionRequest(req, reply, dataDir(req), userId, pageName, appRoute.name);
        }

        if (restPath === "api/content/bundles" || restPath.startsWith("api/content/bundles/")) {
          const visitor = host.visitorId(req);
          if (!visitor) return reply.status(401).send({ success:false, error:"Authentication required" });
          if (req.verificationSession) return reply.status(409).send({success:false,error:"打包任务不支持隔离验证会话"});
          const preview = host.previewData?.(req);
          const owner = preview?.readSource === "production" ? preview.ownerId : userId;
          const directory = preview?.readSource === "production" ? path.dirname(preview.databasePath) : getPageDir(dataDir(req),userId,pageName);
          const scope = `${userId}/${pageName}`;
          const locations = [{ owner, directory }];
          if (preview && preview.readSource !== preview.writeSource) {
            const writeOwner = preview.writeSource === "production" ? preview.ownerId : userId;
            locations.push({owner:writeOwner,directory:preview.writeSource === "production" ? path.dirname(preview.databasePath) : getPageDir(dataDir(req),userId,pageName)});
          }
          const authorize = (file: {key:string}) => locations.some(location => canExportFile(location.directory,file.key,visitor,preview?.ownerId ?? meta.userId));
          const parts = restPath.split("/");
          const withDownload = (job: import("./content-bundles.cjs").BundleJob) => ({...job,
            ...(job.state === "completed" ? {downloadUrl:`/serve/${userId}/${pageName}/api/content/bundles/${job.id}/download`} : {}),
          });
          try {
            if (req.method === "POST" && parts.length === 3) {
              const body = req.body as { files?:unknown; idempotencyKey?:unknown } | null;
              const files = validateBundleFiles(body?.files);
              const objectKeys = files.map(file => {
                const candidates = locations.filter(location => canExportFile(location.directory,file.key,visitor,preview?.ownerId ?? meta.userId));
                if (!candidates.length) throw new BundleError(403,`无权读取文件：${file.key} (${file.path})`);
                return candidates.map(location => `${location.owner}/${pageName}/${file.key}`);
              });
              return reply.status(202).send({success:true,data:withDownload(bundles.create(scope,visitor,files,body?.idempotencyKey,authorize,objectKeys))});
            }
            if (req.method === "GET" && parts.length === 4) return {success:true,data:withDownload(bundles.get(parts[3],scope,visitor))};
            if (req.method === "GET" && parts.length === 5 && parts[4] === "download") {
              const result = bundles.download(parts[3],scope,visitor,authorize);
              reply.header("Cache-Control","private, no-store").header("X-Content-Type-Options","nosniff").header("Content-Disposition",`attachment; filename="${parts[3]}.zip"`);
              return reply.type("application/zip").send(fs.createReadStream(result));
            }
            return reply.status(404).send({success:false,error:"Unknown bundle endpoint"});
          } catch(error) {
            if (error instanceof BundleError) return reply.status(error.status).send({success:false,error:error.message});
            throw error;
          }
        }

        // Content upload/read routes: /serve/{userId}/{name}/api/content/upload|{key}
        if (appRoute.kind === "content-upload") {
          const source = host.previewData?.(req);
          const owner = source?.writeSource === "production" ? source.ownerId : userId;
          const directory = source?.writeSource === "production" ? path.dirname(source.databasePath) : getPageDir(dataDir(req), userId, pageName);
          return handleContentUpload(req, reply, owner, pageName, directory, `/serve/${userId}/${pageName}/api/content/`, host.visitorId(req) ?? undefined);
        }
        if (appRoute.kind === "content-read") {
          return handleContentRead(req, reply, host.previewData?.(req)?.readSource === "production" ? host.previewData!(req)!.ownerId : userId, pageName, appRoute.key);
        }

        // Notify endpoint: POST /serve/{userId}/{name}/api/notify
        // 端点存在性由 manifest.notify.enabled 控制；不存在时回落到 CRUD（最终 404）。
        if (restPath === "api/notify" && req.method === "POST" && shouldRegisterNotify(meta)) {
          return handleApplicationNotification(req, reply, meta, userId, pageName, {
            dataDir: request => dataDir(request), visitorId: request => host.visitorId(request),
            resolveRecipients, persistNotifications,
          });
        }

        return handleCrudRequest(req, reply, dataDir(req), userId, pageName, restPath, appRoute);
    },
  });

async function handleCrudRequest(
  req: FastifyRequest, reply: FastifyReply, dataDir: string,
  userId: string, pageName: string, restPath: string,
  appRoute = matchAppApiRoute(req.method, restPath.slice("api".length)),
) {
  return handleApplicationData(req, reply, dataDir, userId, pageName, restPath, {
    visitor: visitorFromReq(req), verification: req.verificationSession, now: host.now(req), previewData: host.previewData?.(req),
  }, appRoute);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visitorFromReq(req: FastifyRequest): VisitorContext {
  if (req.verificationSession) {
    return { id: req.verificationSession.actorId, name: req.verificationSession.actorName };
  }
  const visitorId = host.visitorId(req);
  if (visitorId) {
    return { id: visitorId, name: host.visitorName(req) ?? null };
  }
  // /serve 路径不挂 authPlugin；API Key 用户在此解析为 visitor 身份
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey) {
    const userId = validateApiKey(apiKey);
    if (userId) {
      const user = findUserById(userId);
      return { id: userId, name: user?.name ?? null };
    }
  }
  return { id: null, name: null };
}

function resolveVerification(
  app: FastifyInstance,
  req: FastifyRequest,
  owner: string,
  appName: string,
  cookieName: string,
): VerificationSessionContext | null {
  return host.sessions?.resolve(req.cookies?.[cookieName], owner, appName) ?? null;
}

async function handleVerificationReport(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  owner: string,
  appName: string,
) {
  const context = req.verificationSession;
  if (!context || context.owner !== owner || context.app !== appName) {
    return reply.status(401).send({ success: false, error: "Active verification session required" });
  }
  const body = req.body as { status?: unknown; checks?: unknown } | undefined;
  if (!body || !["passed", "failed"].includes(String(body.status)) || !Array.isArray(body.checks)) {
    return reply.status(400).send({ success: false, error: "status and checks are required" });
  }
  const checks = body.checks.filter(isVerificationCheck);
  if (checks.length !== body.checks.length) {
    return reply.status(400).send({ success: false, error: "Invalid verification check" });
  }
  host.sessions.report(context, {
    status: body.status as "passed" | "failed",
    checks,
  });
  reply.clearCookie(VERIFICATION_SHELL_COOKIE, { path: `/${owner}/${appName}` });
  reply.clearCookie(VERIFICATION_APP_COOKIE, { path: `/serve/${owner}/${appName}` });
  reply.clearCookie(VERIFICATION_ME_COOKIE, { path: "/api/me" });
  return { success: true, data: { id: context.id, status: body.status } };
}

function isVerificationCheck(value: unknown): value is VerificationCheck {
  if (!isRecord(value)) return false;
  return ["http", "api", "dom", "console", "interaction", "identity"].includes(String(value.phase))
    && ["passed", "failed", "pending"].includes(String(value.status))
    && typeof value.summary === "string"
    && (value.suggestion === undefined || typeof value.suggestion === "string");
}

}
