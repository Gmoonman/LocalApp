import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fs, { createReadStream } from "node:fs";
import path from "node:path";
import { getPageDir, readPageMeta, type PageMeta } from "./page-storage.cjs";
import { checkPageAccess } from "./access-control.cjs";
import { isAppOffline } from "./app-lifecycle.cjs";

export interface ApplicationResourcesHost {
  dataDir(request: FastifyRequest): string;
  visitorId(request: FastifyRequest): string | null | undefined;
  validateApiKey(key: string): string | null;
  verification(request: FastifyRequest, owner: string, name: string): { actorId: string; version: number } | null | undefined;
  handleApi(request: FastifyRequest, reply: FastifyReply, meta: PageMeta, owner: string, name: string, restPath: string): unknown;
}

const CSP_HEADER = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'";

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".webp": "image/webp",
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
  };
  return mimeMap[ext] || "application/octet-stream";
}

function sendOfflineAppError(reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  return reply.status(503).send({
    success: false,
    code: "APP_OFFLINE",
    error: "Application is offline",
  });
}

export async function registerApplicationResources(app: FastifyInstance, host: ApplicationResourcesHost) {
  // Raw app resource entry for /serve/:userId/:name (no trailing slash)
  // With ignoreTrailingSlash, this also handles the trailing-slash case via the wildcard route below.
  // This specific route is needed because /serve/:userId/:name without /* won't match the wildcard.
  app.get<{ Params: { userId: string; name: string } }>(
    "/serve/:userId/:name",
    async (req, reply) => {
      const { userId, name } = req.params;

      const meta = readPageMeta(host.dataDir(req), userId, name);
      if (!meta) return reply.status(404).send({ success: false, error: "Page not found" });
      if (isAppOffline(meta)) return sendOfflineAppError(reply);

      // Redirect /serve/:userId/:name → /serve/:userId/:name/ to ensure correct
      // relative asset resolution in browsers (e.g. ./assets/app.js).
      const urlPath = req.url.split("?")[0];
      if (!urlPath.endsWith("/")) {
        const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
        return reply.redirect(301, `/serve/${userId}/${name}/${qs}`);
      }

      const verification = host.verification(req, userId, name);
      const visitorId = verification?.actorId ?? host.visitorId(req);
      if (!verification && !checkPageAccess(meta.pageAccess, visitorId, meta.userId)) {
        if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
        return reply.status(403).send({ success: false, error: "Access denied" });
      }

      const version = verification?.version ?? meta.currentVersion;
      const versionDir = path.join(getPageDir(host.dataDir(req), userId, name), "versions", `v${version}`);
      const indexPath = path.join(versionDir, "index.html");
      if (fs.existsSync(indexPath)) {
        return sendAppFile(req, reply, indexPath, "index.html");
      }
      return reply.status(404).send({ success: false, error: "index.html not found" });
    },
  );

  // Combined static file serving + CRUD API
  app.all<{ Params: { userId: string; name: string; wildcard: string } }>(
    "/serve/:userId/:name/*",
    { bodyLimit: 2 * 1024 * 1024 },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const urlParts = req.url.split("?");
      const pathParts = urlParts[0].split("/");
      const userId = pathParts[2];
      const pageName = pathParts[3];
      const restPath = pathParts.slice(4).join("/");

      const meta = readPageMeta(host.dataDir(req), userId, pageName);
      if (!meta) {
        return reply.status(404).send({ success: false, error: "Page not found" });
      }
      if (isAppOffline(meta)) return sendOfflineAppError(reply);

      const verification = host.verification(req, userId, pageName);
      const isDesktopActionCreation = restPath === "api/desktop-actions" && req.method === "POST";
      const isDeviceActionCreation = restPath === "api/device-actions" && req.method === "POST";
      const actionApiKey = isDesktopActionCreation || isDeviceActionCreation ? req.headers["x-api-key"] : undefined;
      const pageVisitorId = verification?.actorId ?? (typeof actionApiKey === "string"
        ? host.validateApiKey(actionApiKey)
        : host.visitorId(req));

      // Page-level access control
      if (!verification && !checkPageAccess(meta.pageAccess, pageVisitorId, meta.userId)) {
        if (!pageVisitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
        return reply.status(403).send({ success: false, error: "Access denied" });
      }

      if (restPath.startsWith("api/")) return host.handleApi(req, reply, meta, userId, pageName, restPath);

      // Static file serving
      const version = verification?.version ?? meta.currentVersion;
      const versionDir = path.join(getPageDir(host.dataDir(req), userId, pageName), "versions", `v${version}`);

      if (restPath === ".localapp" || restPath.startsWith(".localapp/")) {
        return reply.status(404).send({ success: false, error: "File not found" });
      }

      let filePath = path.join(versionDir, restPath || "index.html");
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return sendAppFile(req, reply, filePath, restPath);
      }

      // SPA fallback: if not a static asset (no extension), serve index.html
      const indexPath = path.join(versionDir, "index.html");
      if (fs.existsSync(indexPath) && !restPath.includes(".")) {
        return sendAppFile(req, reply, indexPath, restPath);
      }

      return reply.status(404).send({ success: false, error: "File not found" });
    }
  );
}

/**
 * Vite emits bundled assets as `assets/<name>-<contentHash>.<ext>`, so the URL
 * already changes whenever the bytes change. Anything else under an app version
 * directory (index.html, or a file the app itself shipped) keeps its name across
 * versions and must revalidate instead.
 */
function isImmutableAppAsset(restPath: string): boolean {
  return /(?:^|\/)assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(restPath);
}

/**
 * Serves one file from an app version directory with the validators the platform
 * shell already has and app resources used to lack: without them every visit
 * re-downloaded the whole bundle, and a revalidation could not answer 304.
 */
function sendAppFile(req: FastifyRequest, reply: FastifyReply, filePath: string, restPath: string): FastifyReply {
  const stat = fs.statSync(filePath);
  const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  reply.header("ETag", etag);
  reply.header("Last-Modified", stat.mtime.toUTCString());
  reply.header("Cache-Control", isImmutableAppAsset(restPath) ? "public, max-age=31536000, immutable" : "no-cache");
  reply.header("Content-Security-Policy", CSP_HEADER);
  const ifNoneMatch = req.headers["if-none-match"];
  if (typeof ifNoneMatch === "string" && ifNoneMatch.split(",").some((value) => value.trim() === etag)) {
    return reply.status(304).send();
  }
  return reply.type(getMimeType(filePath)).send(createReadStream(filePath));
}

