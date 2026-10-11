import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ProjectStore, DevelopmentError } from "./projects.cjs";
import type { ReleaseBuildStore } from "./releases.cjs";
import { inspectAppPackage } from "@localapp/dsh-app-platform/app-package";
import { installAppPackage } from "@localapp/dsh-app-platform/app-installer";
import { readPageMeta } from "@localapp/dsh-app-platform/page-storage";
export interface Preview {
  id: string;
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
  cookie(request: FastifyRequest): string | undefined;
  setCookie(reply: import("fastify").FastifyReply, token: string): void;
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
      if (!settings.previewOrigin.includes("{previewId}"))
        throw new DevelopmentError(
          "预览域名必须包含 {previewId}，确保每个预览独立",
          503,
        );
      origin = new URL(
        settings.previewOrigin.replaceAll("{previewId}", previewId),
      ).origin;
    } else if (["localhost", "127.0.0.1"].includes(main.hostname)) {
      origin = `${main.protocol}//${owner}.localhost${main.port ? ":" + main.port : ""}`;
    } else throw new DevelopmentError("请管理员配置独立预览域名和 TLS", 503);
    if (new URL(origin).host === main.host)
      throw new DevelopmentError("预览不能使用平台域名");
    const root = path.join(this.projects.directory, id, "previews", previewId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    await installAppPackage({
      dataDir: root,
      ownerId: owner,
      packagePath: build.packagePath,
    });
    const ticket = randomBytes(32).toString("hex"),
      preview: Preview = {
        id: previewId,
        owner,
        app: project.name,
        dataDir: root,
        expires: Date.now() + 3600000,
        origin,
        ticketHash: digest(ticket),
        ticketExpires: Date.now() + 60000,
      };
    this.previews.set(new URL(origin).host, preview);
    return {
      id: previewId,
      url: `${origin}/__development/open?ticket=${ticket}`,
      expiresAt: new Date(preview.expires).toISOString(),
    };
  }
  close() { this.previews.clear(); }
  attach(app: FastifyInstance) {
    app.addHook("onRequest", async (req, reply) => {
      const host = req.headers.host ?? "",
        preview = this.previews.get(host);
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
      reply.header("Referrer-Policy", "no-referrer");
      reply.header("Cache-Control", "no-store");
      const url = new URL(req.url, "http://preview.invalid");
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
        this.host.setCookie(reply, cookie);
        return reply.redirect(`/${preview.owner}/${preview.app}/`);
      }
      if (
        this.host.cookie(req) === undefined ||
        digest(this.host.cookie(req)!) !== preview.cookieHash
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
