import type { FastifyInstance, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { readPageMeta } from "./page-storage.cjs";
import { checkPageAccess } from "./access-control.cjs";

export interface ApplicationShellHost {
  webRoot: string;
  dataDir(request: FastifyRequest): string;
  visitorId(request: FastifyRequest): string | undefined | null;
  userId(request: FastifyRequest): string | undefined | null;
  verification(request: FastifyRequest, owner: string, name: string): { actorId: string } | undefined | null;
  pushPageView(view: { pagePath: string; visitorId: string | null; userId: string | null }): void;
}

const HTML_404 = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not Found</title></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:system-ui;background:#f8f9fa"><div style="text-align:center"><h1 style="font-size:2rem;color:#1a1d23">404</h1><p style="color:#6b7280">Page not found.</p><a href="/" style="color:#2563eb">Back to home</a></div></body></html>`;

export async function registerApplicationShell(app: FastifyInstance, host: ApplicationShellHost) {
  const webOutDir = host.webRoot;
  // Production app entry: PlatformShell from Next.js static export.
  // Raw uploaded app resources remain under /serve/:userId/:name/*.
  app.get<{ Params: { userId: string; name: string } }>(
    "/:userId/:name",
    async (req, reply) => {
      const { userId, name } = req.params;
      const meta = readPageMeta(host.dataDir(req), userId, name);

      if (!meta) {
        return reply.status(404).type("text/html").send(HTML_404);
      }
      const verification = host.verification(req, userId, name);
      const visitorId = verification?.actorId ?? host.visitorId(req);
      if (!verification && !checkPageAccess(meta.pageAccess, visitorId, meta.userId)) {
        if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
        return reply.status(403).send({ success: false, error: "Access denied" });
      }

      host.pushPageView({ pagePath: `/${userId}/${name}`, visitorId: visitorId || null, userId: verification ? null : (host.visitorId(req) || host.userId(req) || null) });

      // Serve Next.js static React platform shell with actual params injected.
      try {
        let html = fs.readFileSync(path.join(webOutDir, "platform-shell/placeholder/placeholder.html"), "utf-8");
        // Replace static placeholder params with actual values in RSC payload
        html = html
          .replace(/\\"platform-shell\\",\\"placeholder\\",\\"placeholder\\"/g, `\\"platform-shell\\",\\"${userId}\\",\\"${name}\\"`)
          .replace(/\[\\"userId\\",\\"placeholder\\"/g, `[\\"userId\\",\\"${userId}\\"`)
          .replace(/\[\\"name\\",\\"placeholder\\"/g, `[\\"name\\",\\"${name}\\"`);
        html = injectNativeShellMetadata(html, userId, name);
        reply.type("text/html").send(html);
      } catch {
        reply.status(404).send({ success: false, error: "Shell not built. Run build:web first." });
      }
    }
  );

}

function injectNativeShellMetadata(html: string, userId: string, name: string): string {
  const resourceBase = `/serve/${userId}/${name}/`;
  const marker = [
    `<template data-localapp-native-shell="true"`,
    ` data-localapp-app-root="root"`,
    ` data-localapp-app-resource-base="${escapeHtmlAttr(resourceBase)}"></template>`,
  ].join("");
  if (html.includes("data-localapp-native-shell")) return html;
  return html.replace("</body>", `${marker}</body>`);
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

