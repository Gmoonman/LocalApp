import type { FastifyInstance, FastifyRequest } from "fastify";
import { ProjectStore, DevelopmentError, sourceBytes, type SourceFile } from "./projects.cjs";
import { readPageMeta } from "@localapp/dsh-app-platform/page-storage";
import { validateName } from "@localapp/dsh-app-platform/validate-name";
export interface DevelopmentSourceHost {
  dataDir: string;
  projects: ProjectStore;
  user(request: FastifyRequest): string;
}
/** Source import and synchronization share the authenticated application owner. */
export async function registerDevelopmentSource(app: FastifyInstance, host: DevelopmentSourceHost) {
  const projects = host.projects;
  const base = "/api/development/projects";
  // An app's source is never inferred from its compiled assets.
  const appSource = [
    "/api/development/apps/:owner/:name/source",
    "/api/development/apps/:name/source",
  ];
  function ownedApp(owner: string, name: string, user: string) {
    if (owner !== user)
      throw new DevelopmentError("只有应用拥有者可以编辑应用", 403);
    if (validateName(name)) throw new DevelopmentError("应用名称无效");
    if (!readPageMeta(host.dataDir, user, name))
      throw new DevelopmentError("应用不存在", 404);
  }
  for (const route of appSource) {
    app.get<{ Params: { owner?: string; name: string } }>(
      route,
      async (req) => {
        ownedApp(req.params.owner ?? host.user(req), req.params.name, host.user(req));
        return {
          success: true,
          data:
            projects.list(host.user(req)).find((p) => p.name === req.params.name) ??
            null,
        };
      },
    );
    app.post<{
      Params: { owner?: string; name: string };
      Body: { files: Record<string, SourceFile> };
    }>(route, { bodyLimit: 40 * 1024 * 1024 }, async (req) => {
      ownedApp(req.params.owner ?? host.user(req), req.params.name, host.user(req));
      const files = req.body?.files;
      if (
        !files ||
        typeof files !== "object" ||
        Array.isArray(files) ||
        Object.keys(files).length > 5000 ||
        Object.values(files).some(
          (v) => sourceBytes(v).length > 2 * 1024 * 1024,
        ) ||
        Buffer.byteLength(JSON.stringify(files)) > 32 * 1024 * 1024
      )
        throw new DevelopmentError("源码文件无效或超过大小限制");
      let manifest, pkg;
      try {
        manifest = JSON.parse(
          sourceBytes(files["manifest.json"]).toString("utf8"),
        );
        pkg = JSON.parse(sourceBytes(files["package.json"]).toString("utf8"));
      } catch {
        throw new DevelopmentError(
          "请选择包含 manifest.json 和 package.json 的应用源码目录",
        );
      }
      if (
        manifest.name !== req.params.name ||
        !pkg.scripts?.test ||
        !pkg.scripts?.build
      )
        throw new DevelopmentError(
          "源码应用名称必须匹配，且保留 test 和 build 脚本",
        );
      return {
        success: true,
        data: projects.create(host.user(req), req.params.name, files),
      };
    });
  }
  app.get<{ Params: { id: string } }>(base + "/:id/source", async (req) => {
    return { success: true, data: projects.exportSource(req.params.id, host.user(req)) };
  });
  app.post<{
    Params: { id: string };
    Body: { files: Record<string, SourceFile>; expectedDigest: string };
  }>(base + "/:id/source", { bodyLimit: 40 * 1024 * 1024 }, async (req) => {
    return {
      success: true,
      data: projects.replaceSource(
        req.params.id,
        host.user(req),
        req.body.files,
        req.body.expectedDigest,
      ),
    };
  });
}
