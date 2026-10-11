import type { FastifyRequest, FastifyReply } from "fastify";
import path from "node:path";
import { getPageDir, readPageMeta } from "./page-storage.cjs";
import { matchAppApiRoute } from "./app-api-contract.cjs";
import { loadBackendContract, loadDefaultBackendContract } from "./backend-contract.cjs";
import { createAppNamedSqlRuntime, classifyAppRuntimeError } from "./app-runtime.cjs";
import type { VisitorContext } from "./record-access.cjs";

export interface ApplicationRequestContext {
  visitor: VisitorContext;
  verification?: { version: number; databasePath: string } | null;
  now?: string;
}

export async function handleApplicationData(
  req: FastifyRequest,
  reply: FastifyReply,
  dataDir: string,
  userId: string,
  pageName: string,
  restPath: string,
  context: ApplicationRequestContext,
  appRoute = matchAppApiRoute(req.method, restPath.slice("api".length)),
) {
  // Page-level schemas endpoint: api/_schemas
  if (appRoute.kind === "schemas") {
    const meta = readPageMeta(dataDir, userId, pageName);
    if (!meta) return reply.status(404).send({ success: false, error: "Page not found" });
    const schemas = (meta.schemas ?? []).map((s) => ({
      name: s.name,
      fields: s.fields,
      business: s.business,
      routeAccess: s.routeAccess,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
    return { success: true, data: schemas };
  }

  if (appRoute.kind === "named-query" || appRoute.kind === "named-mutation" || appRoute.kind === "named-mutation-transaction") {
    const pageDir = getPageDir(dataDir, userId, pageName);
    const meta = readPageMeta(dataDir, userId, pageName);
    const contractDir = meta
      ? path.join(pageDir, "versions", `v${context.verification?.version ?? meta.currentVersion}`)
      : pageDir;
    const visitor = context.visitor;
    try {
      let contract;
      try {
        contract = meta?.backend
          ? loadBackendContract(contractDir, meta.backend, { allowDisabledHostedActions: true })
          : loadDefaultBackendContract(contractDir, { allowDisabledHostedActions: true });
      } catch (err: any) {
        if (!/backend root does not exist/i.test(err?.message ?? "")) throw err;
        contract = meta?.backend
          ? loadBackendContract(pageDir, meta.backend, { allowDisabledHostedActions: true })
          : loadDefaultBackendContract(pageDir, { allowDisabledHostedActions: true });
      }
      const runtime = createAppNamedSqlRuntime({
        contract,
        dbPath: context.verification?.databasePath ?? pageDir,
        context: () => ({
          visitorId: visitor.id,
          ownerId: userId,
          now: new Date(context.now ?? Date.now()),
        }),
      });
      const result = await runtime.execute(appRoute, req.body);
      return { success: true, data: result };
    } catch (err: unknown) {
      const response = classifyAppRuntimeError(err, visitor.id !== null);
      return reply.status(response.status).send(response.body);
    }
  }

  // 其余平台辅助端点（time/me/users/groups等）由上层 wildcard 处理器分流；
  // 未识别路径统一返回 404。REST CRUD / transitions / db-exec / legacy-upload
  // 已由 restrict-app-api-to-named-sql 变更移除，应用层数据通道现由 named SQL 唯一承担。
  return reply.status(404).send({ success: false, error: "Not found" });
}

export async function handleActionRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  dataDir: string,
  userId: string,
  pageName: string,
  actionName: string,
) {
  const pageDir = getPageDir(dataDir, userId, pageName);
  const meta = readPageMeta(dataDir, userId, pageName);
  if (!meta) return reply.status(404).send({ success: false, error: "Page not found" });

  return reply.status(410).send({
    success: false,
    error: "Hosted backend actions are disabled. Use named SQL, transaction mutation, or a platform primitive instead.",
    code: "hosted_actions_disabled",
  });
}

