import type {} from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface WorkspaceRouteStore {
  workspaceDir: string;
  archiveLimits: { maxCompressedBytes: number };
  list(user: string): unknown;
  create(input: { name: string; ownerId: string }): Promise<unknown>;
  clone(input: { name: string; repositoryUrl: string; ownerId: string; signal: AbortSignal }): Promise<unknown>;
  importArchive(input: { name: string; ownerId: string; archivePath: string }): Promise<unknown>;
  readFile(id: string, user: string, path: string): Promise<string>;
  writeFile(id: string, user: string, path: string, content: string): Promise<void>;
  remove(id: string, user: string): Promise<boolean>;
  build(id: string, user: string): Promise<unknown>;
  install(id: string, user: string): Promise<unknown>;
}
export interface WorkspaceRoutesHost {
  store: WorkspaceRouteStore;
  user(request: import("fastify").FastifyRequest): string;
  isAdministrator(user: string): boolean;
}
export async function registerWorkspaces(app: FastifyInstance, host: WorkspaceRoutesHost): Promise<void> {
  const workspaceStore = host.store;
  const requireExecutionAdmin = (user: string, reply: FastifyReply) => {
    if (host.isAdministrator(user)) return true;
    reply.status(403).send({ success: false, error: "Administrator execution required" });
    return false;
  };
  app.get("/api/workspaces", async (request) => ({ success: true, data: workspaceStore.list(host.user(request)) }));

  app.post("/api/workspaces", async (request, reply) => {
    try {
      const body = request.body as { name?: unknown } | null;
      const workspace = await workspaceStore.create({ name: requireString(body?.name, "name"), ownerId: host.user(request) });
      return reply.status(201).send({ success: true, data: workspace });
    } catch (error) {
      return workspaceError(reply, error);
    }
  });

  app.post("/api/workspaces/clone", async (request, reply) => {
    if (!requireExecutionAdmin(host.user(request), reply)) return;
    const abort = new AbortController();
    let complete = false;
    const cancel = () => { if (!complete) abort.abort(); };
    request.raw.once("aborted", cancel);
    reply.raw.once("close", cancel);
    try {
      const body = request.body as { name?: unknown; repositoryUrl?: unknown } | null;
      const workspace = await workspaceStore.clone({
        name: requireString(body?.name, "name"),
        repositoryUrl: requireString(body?.repositoryUrl, "repositoryUrl"),
        ownerId: host.user(request),
        signal: abort.signal,
      });
      complete = true;
      return reply.status(201).send({ success: true, data: workspace });
    } catch (error) {
      return workspaceError(reply, error);
    } finally {
      request.raw.off("aborted", cancel);
      reply.raw.off("close", cancel);
    }
  });

  app.post("/api/workspaces/import", async (request, reply) => {
    const uploadDirectory = path.join(workspaceStore.workspaceDir, ".uploads");
    fs.mkdirSync(uploadDirectory, { recursive: true });
    const archivePath = path.join(uploadDirectory, `${randomUUID()}.zip`);
    try {
      const query = request.query as { name?: unknown };
      let multipartName: unknown;
      let archiveReceived = false;
      const parts = request.parts({
        limits: { files: 1, fileSize: workspaceStore.archiveLimits.maxCompressedBytes },
      });
      for await (const part of parts) {
        if (part.type === "field") {
          if (part.fieldname === "name") multipartName = part.value;
          continue;
        }
        if (archiveReceived) throw new Error("Only one workspace archive is allowed");
        archiveReceived = true;
        let compressedBytes = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            compressedBytes += chunk.length;
            if (compressedBytes > workspaceStore.archiveLimits.maxCompressedBytes) callback(new Error("Workspace archive limit exceeded: compressed size"));
            else callback(null, chunk);
          },
        });
        await pipeline(part.file, limiter, fs.createWriteStream(archivePath, { flags: "wx", mode: 0o600 }));
        if (part.file.truncated) throw new Error("Workspace archive limit exceeded: compressed size");
      }
      if (!archiveReceived) throw new Error("Workspace archive is required");
      const name = requireString(query.name ?? multipartName, "name");
      const workspace = await workspaceStore.importArchive({ name, ownerId: host.user(request), archivePath });
      return reply.status(201).send({ success: true, data: workspace });
    } catch (error) {
      return workspaceError(reply, error);
    } finally {
      fs.rmSync(archivePath, { force: true });
    }
  });

  app.get("/api/workspaces/:id/file", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const query = request.query as { path?: unknown };
      const relativePath = requireString(query.path, "path");
      const content = await workspaceStore.readFile(id, host.user(request), relativePath);
      return { success: true, data: { path: relativePath, content } };
    } catch (error) {
      return workspaceError(reply, error);
    }
  });

  app.put("/api/workspaces/:id/file", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as { path?: unknown; content?: unknown } | null;
      await workspaceStore.writeFile(
        id,
        host.user(request),
        requireString(body?.path, "path"),
        requireString(body?.content, "content", true),
      );
      return reply.status(204).send();
    } catch (error) {
      return workspaceError(reply, error);
    }
  });

  app.delete("/api/workspaces/:id", async (request, reply) => {
    try {
      const removed = await workspaceStore.remove((request.params as { id: string }).id, host.user(request));
      if (!removed) return reply.status(404).send({ success: false, error: "Workspace not found" });
      return reply.status(204).send();
    } catch (error) {
      return workspaceError(reply, error);
    }
  });

  app.post("/api/workspaces/:id/build", async (request, reply) => {
    if (!requireExecutionAdmin(host.user(request), reply)) return;
    try {
      const task = await workspaceStore.build((request.params as { id: string }).id, host.user(request));
      return reply.status(201).send({ success: true, data: task });
    } catch (error) {
      return workspaceError(reply, error);
    }
  });

  app.post("/api/workspaces/:id/install", async (request, reply) => {
    if (!requireExecutionAdmin(host.user(request), reply)) return;
    try {
      const task = await workspaceStore.install((request.params as { id: string }).id, host.user(request));
      return reply.status(201).send({ success: true, data: task });
    } catch (error) {
      return workspaceError(reply, error);
    }
  });
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${field} is required`);
  return value;
}

function workspaceError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "WORKSPACE_NOT_FOUND" || message === "WORKSPACE_FILE_NOT_FOUND") {
    return reply.status(404).send({ success: false, error: "Workspace not found" });
  }
  if (message === "ADMIN_EXECUTION_REQUIRED") return reply.status(403).send({ success: false, error: "Administrator execution required" });
  const status = /already exists/i.test(message) ? 409 : 400;
  return reply.status(status).send({ success: false, error: message });
}

