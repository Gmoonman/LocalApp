import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { ProjectStore, DevelopmentError, sourceBytes, sourceDisplay } from "./projects.cjs";
import { templateSource } from "./template.cjs";
export interface DevelopmentProjectHost {
  projects: ProjectStore;
  user(request: FastifyRequest): string;
}
export function registerDevelopmentProjects(app: FastifyInstance, host: DevelopmentProjectHost) {
  const projects = host.projects;
  const base = "/api/development/projects";
  app.get(base, async (req) => ({
    success: true,
    data: projects.list(host.user(req)),
  }));
  app.post<{ Body: { name: string } }>(base, async (req, reply) => {
    if (!req.body || typeof req.body.name !== "string")
      throw new DevelopmentError("请输入项目名称");
    const project = projects.create(
      host.user(req),
      req.body.name,
      templateSource(req.body.name),
    );
    return reply.status(201).send({ success: true, data: project });
  });
  app.get<{ Params: { id: string } }>(base + "/:id", async (req) => ({
    success: true,
    data: {
      ...projects.get(req.params.id, host.user(req)),
      busy: projects.busy(req.params.id, host.user(req)),
    },
  }));
  app.get<{ Params: { id: string } }>(base + "/:id/files", async (req) => ({
    success: true,
    data: projects.files(req.params.id, host.user(req)),
  }));
  app.get<{ Params: { id: string } }>(
    base + "/:id/source-manifest",
    async (req) => ({
      success: true,
      data: Object.entries(projects.sourceFiles(req.params.id, host.user(req))).map(
        ([file, content]) => {
          const bytes = sourceBytes(content);
          return {
            path: file,
            bytes: bytes.length,
            hash: createHash("sha256").update(bytes).digest("hex"),
          };
        },
      ),
    }),
  );
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    base + "/:id/file",
    async (req) => {
      if (typeof req.query.path !== "string")
        throw new DevelopmentError("缺少文件路径");
      return {
        success: true,
        data: projects.read(req.params.id, host.user(req), req.query.path),
      };
    },
  );
  app.put<{
    Params: { id: string };
    Body: { path: string; content: string; hash: string | null };
  }>(base + "/:id/file", async (req) => {
    if (
      !req.body ||
      typeof req.body.path !== "string" ||
      typeof req.body.content !== "string" ||
      !(req.body.hash === null || typeof req.body.hash === "string")
    )
      throw new DevelopmentError("保存需要文件内容和版本摘要");
    projects.write(
      req.params.id,
      host.user(req),
      req.body.path,
      req.body.content,
      req.body.hash,
    );
    return {
      success: true,
      data: projects.read(req.params.id, host.user(req), req.body.path),
    };
  });
  app.get<{ Params: { id: string } }>(base + "/:id/versions", async (req) => ({
    success: true,
    data: projects.versions(req.params.id, host.user(req)),
  }));
  app.get<{ Params: { id: string }; Querystring: { version: string } }>(
    base + "/:id/diff",
    async (req) => {
      const previous = projects.versionFiles(
        req.params.id,
        host.user(req),
        req.query.version,
      );
      const changes = [];
      const current = projects.sourceFiles(req.params.id, host.user(req));
      const files = Object.keys(current);
      for (const file of new Set([...files, ...Object.keys(previous)])) {
        const after = files.includes(file)
            ? sourceDisplay(current[file])
            : null,
          before = sourceDisplay(previous[file] ?? null);
        if (before !== after) changes.push({ path: file, before, after });
      }
      return { success: true, data: changes };
    },
  );
  app.post<{ Params: { id: string }; Body: { version: string } }>(
    base + "/:id/restore",
    async (req) => ({
      success: true,
      data: projects.restore(req.params.id, host.user(req), req.body.version),
    }),
  );
}
