import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fs from "node:fs";
import path from "node:path";


const HTML_404 = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not Found</title></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:system-ui;background:#f8f9fa"><div style="text-align:center"><h1 style="font-size:2rem;color:#1a1d23">404</h1><p style="color:#6b7280">Page not found.</p><a href="/" style="color:#2563eb">Back to home</a></div></body></html>`;
function serveNextHtml(webOutDir: string, page: string) {
  const filePath = path.join(webOutDir, `${page}.html`);
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const html = fs.readFileSync(filePath, "utf-8");
      reply.type("text/html").send(html);
    } catch {
      reply.status(404).type("text/html").send(HTML_404);
    }
  };
}

const ADMIN_PAGES = new Set(["dashboard", "analytics", "users", "pages", "orgs", "settings", "system", "peers"]);

type CanonicalMyPage = { page: string; exportedPath: string; flight: boolean };

function canonicalMyPage(req: FastifyRequest, sub: string): CanonicalMyPage | null {
  const rawPath = (req.raw.url ?? "").split("?", 1)[0];
  if (!rawPath.startsWith("/my/")) return null;
  const rawSub = rawPath.slice("/my/".length);
  if (!rawSub || rawSub !== sub || rawSub.includes("%") || rawSub.includes("\\")) return null;

  const flight = rawSub.endsWith(".txt");
  const page = flight ? rawSub.slice(0, -".txt".length) : rawSub;
  const isSimplePage = /^[A-Za-z0-9_-]+$/.test(page);
  const isAppSettings = /^apps\/[A-Za-z0-9_-]+\/settings$/.test(page);
  if (!isSimplePage && !isAppSettings) return null;

  const exportedPath = isAppSettings ? `apps/placeholder/settings${flight ? ".txt" : ""}` : rawSub;
  return { page, exportedPath, flight };
}

export interface PersonalPagesHost {
  webRoot: string;
  visitor(request: FastifyRequest): string | null | undefined;
  userRole(userId: string): string | null;
}
export async function registerPersonalPages(app: FastifyInstance, host: PersonalPagesHost) {
  const webOutDir = host.webRoot;
  app.get("/my", async (_req, reply) => {
    return reply.redirect("/my/info");
  });

  app.get<{ Params: { "*": string } }>("/my/*", async (req, reply) => {
    const sub = req.params["*"];
    if (!sub) return reply.redirect("/my/info");

    const canonical = canonicalMyPage(req, sub);
    if (!canonical) return reply.status(404).send("");

    const visitorId = host.visitor(req);
    if (!visitorId) {
      return reply.redirect("/");
    }

    if (ADMIN_PAGES.has(canonical.page)) {
      const role = host.userRole(visitorId);
      if (role !== "admin") return reply.redirect("/");
    }

    // Next.js App Router prefetch requests /my/<page>.txt?_rsc=...
    // These files are RSC flight payloads emitted to web/out/my/<page>.txt.
    if (canonical.flight) {
      const myDir = path.resolve(webOutDir, "my");
      const target = path.resolve(myDir, canonical.exportedPath);
      if (!target.startsWith(myDir + path.sep)) {
        return reply.status(404).send("");
      }
      try {
        const body = fs.readFileSync(target, "utf-8");
        return reply.type("text/plain; charset=utf-8").send(body);
      } catch {
        return reply.status(404).send("");
      }
    }

    return serveNextHtml(webOutDir, `my/${canonical.exportedPath}`)(req, reply);
  });
}
