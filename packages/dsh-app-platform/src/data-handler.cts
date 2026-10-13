import type { FastifyRequest, FastifyReply } from "fastify";
import path from "node:path";
import fs from "node:fs";
import {exportDatabaseSnapshot,evictConnectionForDbPath} from "./app-db.cjs";
import { getPageDir, readPageMeta } from "./page-storage.cjs";
import { matchAppApiRoute } from "./app-api-contract.cjs";
import { loadBackendContract, loadDefaultBackendContract } from "./backend-contract.cjs";
import { createAppNamedSqlRuntime, classifyAppRuntimeError } from "./app-runtime.cjs";
import type { VisitorContext } from "./record-access.cjs";

export interface ApplicationRequestContext {
  visitor: VisitorContext;
  verification?: { version: number; databasePath: string } | null;
  now?: string;
  previewData?: {databasePath:string;ownerId:string;readSource:"test"|"production";writeSource:"test"|"production"};
  readOnlyProduction?: {databasePath:string;ownerId:string};
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
    if (context.readOnlyProduction && appRoute.kind !== "named-query")
      return reply.status(403).send({success:false,error:"生产数据只读",code:"preview_production_read_only"});
    const production = context.previewData;
    const useProduction = production && (appRoute.kind === "named-query" ? production.readSource : production.writeSource) === "production";
    const selectedProduction = useProduction ? production : context.readOnlyProduction;
    const pageDir = getPageDir(dataDir, userId, pageName);
    let snapshotDirectory: string | undefined;
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
      let databasePath = context.verification?.databasePath ?? pageDir;
      if (selectedProduction) {
        if (!fs.existsSync(selectedProduction.databasePath))
          return reply.status(404).send({success:false,error:"生产数据库不存在"});
        if (appRoute.kind !== "named-query") databasePath = selectedProduction.databasePath;
        else {
        snapshotDirectory = fs.mkdtempSync(path.join(pageDir, ".production-read-"));
        databasePath = path.join(snapshotDirectory,"data.db");
        fs.writeFileSync(databasePath,await exportDatabaseSnapshot(selectedProduction.databasePath),{mode:0o600});
      }
        }
      const runtime = createAppNamedSqlRuntime({
        contract,
        dbPath: databasePath,
        context: () => ({
          visitorId: production?.ownerId ?? selectedProduction?.ownerId ?? visitor.id,
          ownerId: production?.ownerId ?? selectedProduction?.ownerId ?? userId,
          now: new Date(context.now ?? Date.now()),
        }),
      });
      const result = await runtime.execute(appRoute, req.body);
      const sourcePrefix = selectedProduction ? `/serve/${selectedProduction.ownerId}/${pageName}/api/content/` : null;
      const rewriteContent = (value: unknown): unknown => {
        if (typeof value === "string" && sourcePrefix && value.startsWith(sourcePrefix))
          return `/serve/${userId}/${pageName}/api/content/` + value.slice(sourcePrefix.length);
        if (Array.isArray(value)) return value.map(rewriteContent);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewriteContent(item)]));
        return value;
      };
      return { success: true, data: sourcePrefix ? rewriteContent(result) : result };
    } catch (err: unknown) {
      const response = classifyAppRuntimeError(err, visitor.id !== null);
      return reply.status(response.status).send(response.body);
    } finally {
      if (snapshotDirectory) {
        evictConnectionForDbPath(path.join(snapshotDirectory,"data.db"));
        fs.rmSync(snapshotDirectory,{recursive:true,force:true});
      }
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

