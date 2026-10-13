import type { FastifyInstance, FastifyRequest } from "fastify";
import { DevelopmentError } from "./projects.cjs";
import type { DevelopmentBuilds } from "./builds.cjs";
import type { DevelopmentPreviews } from "./previews.cjs";
import type { DevelopmentReleases } from "./releases.cjs";
export interface DevelopmentExecutionHost {
  builds: Pick<DevelopmentBuilds, "list" | "start" | "get" | "cancel">;
  previews: DevelopmentPreviews;
  releases: DevelopmentReleases;
  user(request: FastifyRequest): string;
}
export function registerDevelopmentExecution(app: FastifyInstance, host: DevelopmentExecutionHost) {
  const base = "/api/development/projects";
  app.get<{ Params: { id: string } }>(base + "/:id/builds", async (req) => ({
    success: true,
    data: host.builds.list(req.params.id, host.user(req)),
  }));
  app.post<{
    Params: { id: string };
    Body: { purpose?: "release" | "preview" };
  }>(base + "/:id/builds", async (req) => {
    if (req.body?.purpose && !["preview", "release"].includes(req.body.purpose))
      throw new DevelopmentError("构建类型无效");
    return {
      success: true,
      data: host.builds.start(
        req.params.id,
        host.user(req),
        req.body?.purpose ?? "release",
      ),
    };
  });
  app.get<{ Params: { id: string; buildId: string } }>(
    base + "/:id/builds/:buildId",
    async (req) => ({
      success: true,
      data: host.builds.get(req.params.id, host.user(req), req.params.buildId),
    }),
  );
  app.post<{ Params: { id: string; buildId: string } }>(
    base + "/:id/builds/:buildId/cancel",
    async (req) => {
      host.builds.cancel(req.params.id, host.user(req), req.params.buildId);
      return { success: true };
    },
  );
  app.post<{ Params: { id: string }; Body: { buildId: string } }>(
    base + "/:id/previews",
    async (req) => ({
      success: true,
      data: await host.previews.create(
        req.params.id,
        host.user(req),
        req.body.buildId,
        `${req.headers["x-forwarded-proto"] ?? req.protocol}://${req.headers.host}`,
      ),
    }),
  );
  app.post<{ Params: { id: string; previewId: string }; Body: { mode?: "test" | "production"; readSource?: "test" | "production"; writeSource?: "test" | "production" } }>(
    "/api/development/previews/:previewId/data-mode", async (req) => {
      const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : req.protocol;
      if (req.headers.origin && req.headers.origin !== `${protocol}://${req.headers.host}`)
        throw new DevelopmentError("请从应用开发页面切换数据", 403);
      const readSource = req.body?.readSource ?? req.body?.mode;
      const writeSource = req.body?.writeSource ?? "test";
      if (!readSource || !["test", "production"].includes(readSource) || !["test", "production"].includes(writeSource)) throw new DevelopmentError("数据模式无效");
      return { success: true, data: host.previews.setDataMode(undefined, host.user(req), req.params.previewId, readSource, writeSource) };
    },
  );
  app.post<{ Params: { previewId: string }; Body: { direction: "test-to-production" | "production-to-test"; confirmed: boolean } }>(
    "/api/development/previews/:previewId/sync-data", async (req) => {
      const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : req.protocol;
      if (req.headers.origin && req.headers.origin !== `${protocol}://${req.headers.host}`)
        throw new DevelopmentError("请从应用开发页面同步数据", 403);
      if (req.body?.confirmed !== true || req.body?.direction !== "production-to-test")
        throw new DevelopmentError("请确认同步方向及数据覆盖范围");
      return {success: true, data: await host.previews.syncData(host.user(req), req.params.previewId, req.body.direction)};
    },
  );
  app.get<{ Params: { id: string } }>(
    base + "/:id/release-target",
    async (req) => ({
      success: true,
      data: host.releases.target(req.params.id, host.user(req)),
    }),
  );
  app.post<{
    Params: { id: string };
    Body: { buildId: string; expectedVersion: number; idempotencyKey: string };
  }>(base + "/:id/releases", async (req) => ({
    success: true,
    data: await host.releases.release(
      req.params.id,
      host.user(req),
      req.body.buildId,
      req.body.expectedVersion,
      req.body.idempotencyKey,
    ),
  }));
}
