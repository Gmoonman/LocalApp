import type {} from "@fastify/multipart";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveWorkspacePath } from "@localapp/dsh-app-platform/workspace-path";
import { ProjectStore, DevelopmentError } from "./projects.cjs";
export class DevelopmentAttachments {
  constructor(private readonly projects: ProjectStore) {}
  register(app: FastifyInstance, host: { user(request: FastifyRequest): string }) {
    const projects = this.projects;
    const base = "/api/development/projects";
  app.post<{ Params: { id: string } }>(
    base + "/:id/attachments",
    async (req) => {
      const unlock = projects.lock(req.params.id, host.user(req));
      try {
        const root = path.join(
          projects.directory,
          req.params.id,
          "attachments",
        );
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        const used = fs
          .readdirSync(root)
          .reduce(
            (sum, name) =>
              sum +
              JSON.parse(fs.readFileSync(path.join(root, name), "utf8")).size,
            0,
          );
        const part = await req.file({
          limits: { fileSize: 20 * 1024 * 1024, files: 1 },
        });
        if (!part) throw new DevelopmentError("请选择文件");
        const bytes = await part.toBuffer();
        if (part.file.truncated || used + bytes.length > 200 * 1024 * 1024)
          throw new DevelopmentError(
            "文件超过限制（单文件 20MB、项目总计 200MB）",
          );
        const id = randomUUID();
        const name = path
          .basename(part.filename.replaceAll("\\", "/"))
          .replace(/[\x00-\x1f]/g, "_")
          .slice(0, 200);
        const safeName = !name || name === "." || name === ".." ? "file" : name;
        const relative = `.localapp-attachments/${id}/${safeName}`;
        const filename = resolveWorkspacePath(
          projects.workspace(req.params.id, host.user(req)),
          relative,
        );
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        fs.writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
        const data = { id, name: safeName, size: bytes.length, path: relative };
        fs.writeFileSync(path.join(root, id + ".json"), JSON.stringify(data), {
          flag: "wx",
          mode: 0o600,
        });
        return { success: true, data };
      } finally {
        unlock();
      }
    },
  );
  }
  prompt(project: string, user: string, ids: unknown) {
    this.projects.get(project, user);
    if (ids === undefined) return "";
    if (
      !Array.isArray(ids) ||
      ids.length > 10 ||
      ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    )
      throw new DevelopmentError("附件标识无效");
    return ids
      .map((id) => {
        const meta = path.join(
          this.projects.directory,
          project,
          "attachments",
          id + ".json",
        );
        if (!fs.existsSync(meta)) throw new DevelopmentError("附件不存在", 404);
        const file = JSON.parse(fs.readFileSync(meta, "utf8"));
        const filename = resolveWorkspacePath(
          this.projects.workspace(project, user),
          file.path,
        );
        if (!fs.existsSync(filename))
          throw new DevelopmentError("附件文件已丢失", 404);
        return `\n用户上传文件：${JSON.stringify(file.name)}，工作区文件路径：${JSON.stringify(file.path)}`;
      })
      .join("");
  }
}
