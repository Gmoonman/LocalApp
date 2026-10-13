import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ProjectStore, DevelopmentError } from "./projects.cjs";
import type { ReleaseBuildStore } from "./releases.cjs";
import { inspectAppPackage } from "@localapp/dsh-app-platform/app-package";
import { installAppPackage } from "@localapp/dsh-app-platform/app-installer";
import { createAppDataExport, importAppData, inferAppDataIdentity } from "@localapp/dsh-app-platform/app-data-service";
import { getPageDir } from "@localapp/dsh-app-platform/page-storage";
import { readPageMeta } from "@localapp/dsh-app-platform/page-storage";
export interface Preview {
  verification?: boolean;
  buildId?: string;
  id: string;
  projectId?: string;
  productionOwner?: string;
  platformOrigin?: string;
  dataMode?: "test" | "production";
  readSource?: "test" | "production";
  writeSource?: "test" | "production";
  owner: string;
  app: string;
  dataDir: string;
  expires: number;
  origin: string;
  ticketHash?: string;
  cookieHash?: string;
  ticketExpires: number;
}
export interface PreviewHost {
  authorize(request: FastifyRequest, preview: Preview): void;
  cookie(request: FastifyRequest, preview: Preview): string | undefined;
  setCookie(reply: import("fastify").FastifyReply, token: string, preview: Preview): void;
}
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class DevelopmentPreviews {
  private readonly previews = new Map<string, Preview>();
  constructor(
    private readonly dataDir: string,
    private readonly projects: ProjectStore,
    private readonly builds: ReleaseBuildStore,
    private readonly host: PreviewHost,
  ) {}
  async create(
    id: string,
    user: string,
    buildId: string,
    platformOrigin: string,
    verification = false,
  ) {
    const project = this.projects.get(id, user),
      build = this.builds.get(id, user, buildId);
    if (build.status !== "succeeded" || !build.packagePath)
      throw new DevelopmentError("只能预览成功构建");
    for (const [host, preview] of this.previews)
      if (preview.expires < Date.now()) this.previews.delete(host);
    if (this.previews.size >= 100)
      throw new DevelopmentError("预览数量已满，请稍后重试", 429);
    const inspected = await inspectAppPackage(build.packagePath);
    if (inspected.digest !== build.sha256 || inspected.name !== project.name)
      throw new DevelopmentError("构建包已改变");
    const previewId = randomUUID().replaceAll("-", ""),
      owner = "preview" + previewId;
    const configFile = path.join(this.dataDir, "development", "settings.json"),
      settings = fs.existsSync(configFile)
        ? JSON.parse(fs.readFileSync(configFile, "utf8"))
        : {};
    const main = new URL(platformOrigin);
    let origin: string;
    if (settings.previewOrigin) {
      origin = new URL(
        settings.previewOrigin.replaceAll("{previewId}", previewId),
      ).origin;
    } else if (["localhost", "127.0.0.1"].includes(main.hostname)) {
      origin = `${main.protocol}//${owner}.localhost${main.port ? ":" + main.port : ""}`;
    } else throw new DevelopmentError("请管理员配置独立预览域名和 TLS", 503);
    if (origin === main.origin)
      throw new DevelopmentError("预览必须使用不同的域名或端口");
    const root = path.join(this.projects.directory, id, "previews", previewId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    await installAppPackage({
      dataDir: root,
      ownerId: owner,
      packagePath: build.packagePath,
    });
    const ticket = randomBytes(32).toString("hex"),
      preview: Preview = {
        id: previewId, verification, buildId,
        projectId: id,
        productionOwner: project.ownerId,
        platformOrigin: main.origin,
        dataMode: "test",
        owner,
        app: project.name,
        dataDir: root,
        expires: Date.now() + 3600000,
        origin,
        ticketHash: digest(ticket),
        ticketExpires: Date.now() + 60000,
      };
    this.previews.set(previewId, preview);
    return {
      id: previewId,
      url: `${origin}/__development/open?previewId=${previewId}&ticket=${ticket}`,
      expiresAt: new Date(preview.expires).toISOString(),
    };
  }
  list(projectId:string,user:string) {
    const project=this.projects.get(projectId,user);
    return [...this.previews.values()].filter(preview=>preview.projectId===project.id&&preview.productionOwner===user&&preview.expires>Date.now()).map(preview=>({id:preview.id,buildId:preview.buildId,verification:!!preview.verification,expiresAt:new Date(preview.expires).toISOString()})).reverse();
  }
  setDataMode(projectId: string | undefined, user: string, previewId: string, mode: "test" | "production", writeSource: "test" | "production" = "test") {
    const preview = this.previews.get(previewId);
    if (!preview?.projectId) throw new DevelopmentError("预览已结束", 404);
    const project = this.projects.get(projectId ?? preview.projectId, user);
    if (preview.projectId !== project.id || preview.productionOwner !== user || preview.expires < Date.now())
      throw new DevelopmentError("预览已结束", 404);
    if ((mode === "production" || writeSource === "production") && !readPageMeta(this.dataDir, project.ownerId, project.name))
      throw new DevelopmentError("应用尚未上线，没有生产数据", 409);
    if(preview.verification && (mode !== "test" || writeSource !== "test"))throw new DevelopmentError("自动验收只能使用测试数据",403);
    preview.dataMode = mode;
    preview.readSource = mode;
    preview.writeSource = writeSource;
    const ticket = randomBytes(32).toString("hex");
    preview.ticketHash = digest(ticket);
    preview.ticketExpires = Date.now() + 60000;
    return { id: preview.id, dataMode: mode, readSource: mode, writeSource, url: `${preview.origin}/__development/open?previewId=${preview.id}&ticket=${ticket}` };
  }
  async syncData(user: string, previewId: string, direction: "test-to-production" | "production-to-test") {
    if (direction !== "production-to-test") throw new DevelopmentError("仅支持将生产数据复制到测试环境");
    const preview = this.previews.get(previewId);
    if (!preview?.projectId) throw new DevelopmentError("预览已结束", 404);
    const project = this.projects.get(preview.projectId, user);
    if (preview.productionOwner !== user || preview.expires < Date.now()) throw new DevelopmentError("预览已结束", 404);
    if (!readPageMeta(this.dataDir, project.ownerId, project.name)) throw new DevelopmentError("应用尚未上线，没有生产数据", 409);
    const testDirectory = getPageDir(preview.dataDir, preview.owner, preview.app);
    const productionDirectory = getPageDir(this.dataDir, project.ownerId, project.name);
    const source = productionDirectory;
    const target = testDirectory;
    const application = inferAppDataIdentity(target);
    const exported = await createAppDataExport({pageDir: source, application: inferAppDataIdentity(source), archiveApplication: application, preserveUserIdentity: true});
    try {
      const result=await importAppData({pageDir: target, application, archivePath: exported.archivePath, reason: `preview-sync:${direction}`, preserveUserIdentity: true, allowedForeignKeyViolations: exported.foreignKeyViolations});
      return {...result, warning: exported.foreignKeyViolations?.length ? `生产数据已有 ${exported.foreignKeyViolations.length} 条外键关联异常，已原样复制，未新增异常；生产数据未修改。` : undefined};
    } finally { exported.cleanup(); }
  }
  close() { this.previews.clear(); }
  attach(app: FastifyInstance) {
    app.addHook("onRequest", async (req, reply) => {
      const host = req.headers.host ?? "";
      const url = new URL(req.url, "http://preview.invalid");
      const candidates = [...this.previews.values()].filter(p => new URL(p.origin).host === host);
      let requestedId = url.pathname.match(/^\/(?:serve\/)?preview([a-f0-9]{32})(?:\/|$)/)?.[1];
      if (url.pathname === "/__development/open") requestedId = url.searchParams.get("previewId") ?? undefined;
      if (!requestedId && req.headers.referer) {
        try {
          const referrer = new URL(req.headers.referer);
          if (referrer.host === host) requestedId = referrer.pathname.match(/^\/(?:serve\/)?preview([a-f0-9]{32})(?:\/|$)/)?.[1];
        } catch {}
      }
      const authenticated = candidates.filter(p => {
        const token = this.host.cookie(req, p);
        return token && p.cookieHash === digest(token);
      });
      const preview = requestedId
        ? candidates.find(p => p.id === requestedId)
        : authenticated.length === 1 ? authenticated[0] : undefined;
      let looksPreview = /^preview[a-f0-9]{32}\.localhost(?::\d+)?$/.test(host);
      const configFile = path.join(
        this.dataDir,
        "development",
        "settings.json",
      );
      if (fs.existsSync(configFile)) {
        const configured = JSON.parse(
          fs.readFileSync(configFile, "utf8"),
        ).previewOrigin;
        if (configured) {
          const templateHost = new URL(
            configured.replaceAll("{previewId}", "PREVIEWPLACEHOLDER"),
          ).host;
          const expression = templateHost
            .split("previewplaceholder")
            .map((part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("[a-f0-9]{32}");
          looksPreview ||= new RegExp("^" + expression + "$", "i").test(host);
        }
      }
      if (!preview) {
        if (looksPreview)
          return reply.code(404).send({ success: false, error: "预览已结束" });
        return;
      }
      if (preview.expires < Date.now())
        return reply.code(410).send({ success: false, error: "预览已过期" });
      reply.header("Referrer-Policy", "same-origin");
      reply.header("Cache-Control", "no-store");
      if (url.pathname === "/__development/open") {
        const ticket = url.searchParams.get("ticket");
        if (
          req.method !== "GET" ||
          !ticket ||
          preview.ticketExpires < Date.now() ||
          preview.ticketHash !== digest(ticket)
        )
          return reply
            .code(401)
            .send({ success: false, error: "预览凭证已失效" });
        delete preview.ticketHash;
        const cookie = randomBytes(32).toString("hex");
        preview.cookieHash = digest(cookie);
        this.host.setCookie(reply, cookie, preview);
        return reply.redirect(`/${preview.owner}/${preview.app}/`);
      }
      if (
        this.host.cookie(req, preview) === undefined ||
        digest(this.host.cookie(req, preview)!) !== preview.cookieHash
      )
        return reply
          .code(401)
          .send({ success: false, error: "请从开发界面打开预览" });
      const origin = req.headers.origin;
      if (origin && origin !== preview.origin)
        return reply
          .code(403)
          .send({ success: false, error: "预览来源不匹配" });
      this.host.authorize(req, preview);
      if (url.pathname === "/api/me")
        return reply.send({
          success: true,
          data: { id: preview.owner, name: "开发预览", role: "user" },
        });
      if (url.pathname === `/api/pages/${preview.owner}/${preview.app}/meta`) {
        const meta = readPageMeta(preview.dataDir, preview.owner, preview.app);
        return reply.send({
          success: true,
          data: {
            name: preview.app,
            userId: preview.owner,
            description: "开发预览 · 独立测试数据",
            shell: meta?.shell,
            notify: { enabled: false },
            collaboration: { enabled: false },
            lifecycleStatus: "online",
            developmentPreview: true,
            developmentVerification: !!preview.verification,
            developmentParentOrigin: preview.platformOrigin,
          },
        });
      }
      if (url.pathname === "/api/favorites/count")
        return reply.send({ success: true, data: { count: 0 } });
      if (url.pathname === "/api/favorites/check")
        return reply.send({ success: true, data: { favorited: false } });
      const raw = `/serve/${preview.owner}/${preview.app}`;
      if (url.pathname.startsWith(raw + "/api/")) {
        const endpoint = url.pathname.slice(raw.length + 5);
        if (
          !/^(?:queries|mutations|transactions|schema|schemas|me|time|content)(?:\/|$)/.test(
            endpoint,
          )
        )
          return reply
            .code(403)
            .send({ success: false, error: "此操作在开发预览中关闭" });
      } else if (
        !(
          (req.method === "GET" || req.method === "HEAD") &&
          (url.pathname === `/${preview.owner}/${preview.app}/` ||
            url.pathname === `/${preview.owner}/${preview.app}` ||
            url.pathname === raw ||
            url.pathname.startsWith(raw + "/") ||
            url.pathname.startsWith("/_next/static/"))
        )
      )
        return reply
          .code(403)
          .send({ success: false, error: "预览只能访问当前构建" });
    });
  }
}
