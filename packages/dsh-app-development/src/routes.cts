const CREATION_PROMPT = "你帮助用户创建 LocalApp 应用。先理解需求，必要时在普通回复中追问。给出简洁英文应用标识（小写字母数字和连字符），使用 propose_application 工具提交名称和中文需求摘要，供用户点击确认。用户可能提出修改，应重新提交。不能创建应用、编辑文件或执行命令，只有用户确认名称后平台才创建。无需调用 ask_user 工具，直接在对话中询问。";
const DEVELOPMENT_PROMPT = "你在 LocalApp 的应用开发界面工作。当前目录是应用源码。遵循 AGENTS.md 和 LocalApp 开发 Skills；保留 Named SQL 后端，不能编写 hosted JavaScript backend。修改后说明改动和验证结果。源码目录不安装 node_modules，完成修改后平台会自动执行预览编译；不要尝试安装依赖或反复运行缺少依赖的测试。依赖、完整检查和发布由平台提供。开发命令不能访问网络。不要尝试访问平台会话、其他项目或正式应用数据。";
import { registerDevelopmentProjects } from "./project-routes.cjs";
import { registerDevelopmentExecution } from "./execution-routes.cjs";
import { DevelopmentAttachments } from "./attachments.cjs";
import { registerDevelopmentSource } from "./source-routes.cjs";
import { registerDevelopmentNative } from "./native-routes.cjs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  ProjectStore,
  DevelopmentError,
} from "./projects.cjs";
import { DevelopmentBuilds } from "./builds.cjs";
import type { DevelopmentPreviews } from "./previews.cjs";
import { DevelopmentReleases } from "./releases.cjs";
import { ApplicationCreations } from "./creation.cjs";
import type { AgentSettingsStore } from "@localapp/dsh-multiuser/settings";
import type { AgentSettings, AgentCapability } from "@localapp/dsh-multiuser/settings";
import type { PythonEnvironment } from "@localapp/dsh-multiuser/python-environment";
import type { DeepSeekHarness } from "@localapp/dsh-multiuser/harness" with {
  "resolution-mode": "import",
};

import type MultiuserRuntime from "@localapp/dsh-multiuser" with { "resolution-mode": "import" };
import type { AgentRoutesHost } from "@localapp/dsh-multiuser/agent-routes" with { "resolution-mode": "import" };
import { PUBLIC_AGENT_SKILLS } from "@localapp/dsh-multiuser/public-skills";
const developmentCapabilities: AgentCapability[] = ["files", "skills", "terminal", "jobs", "subagents", "workflow", "web", "schedule", "mcp"];
function policy(saved: AgentSettings, id: string) {
  const key = "development:" + id;
  const defaults = developmentCapabilities.filter(value => value !== "mcp" || saved.mcpServers.length > 0);
  return {
    availableCapabilities: developmentCapabilities,
    enabledCapabilities: (saved.grants[key] ?? defaults).filter(value => developmentCapabilities.includes(value)),
    disabledTools: saved.applications[key]?.disabledTools ?? [],
    enabledSkills: saved.applications[key]?.skills ?? [],
  };
}
export async function registerDevelopmentRoutes(
  app: FastifyInstance,
  options: {
    dataDir: string;
    user(request: import("fastify").FastifyRequest): string;
    isAuthenticated(request: import("fastify").FastifyRequest, userId: string): boolean;
    accountExists?(userId: string): boolean;
    settings: AgentSettingsStore;
    pythonEnvironment(): PythonEnvironment | undefined;
    documents?: AgentRoutesHost["documents"];
    environment?: AgentRoutesHost["environment"];
    createHarness(config: ConstructorParameters<typeof DeepSeekHarness>[0]): DeepSeekHarness;
    projects: ProjectStore;
    attachments?: DevelopmentAttachments;
    registerSource?: (app: FastifyInstance) => Promise<void>;
    builds: DevelopmentBuilds;
    previews: DevelopmentPreviews;
    creations?: ApplicationCreations;
    releases?: DevelopmentReleases;
    runtimeRegistry: MultiuserRuntime;
    nativeClient?: import("./native-routes.cjs").DevelopmentNativeHost["client"];
  },
) {
  const projects = options.projects,
    settings = options.settings;
  const runtimes = new Map<
    string,
    { providerHash: string; providerId: string; providerConfigHash: string; mcpHash: string; harness: DeepSeekHarness; userId: string; projectId: string }
  >();
  const runtimeRegistry = options.runtimeRegistry;
  if (!runtimeRegistry) throw new Error("Multiuser runtime service is required");
  const documentWatches = new Map<NonNullable<ReturnType<NonNullable<AgentRoutesHost["documents"]>>>, () => void>();
  app.addHook("onClose", async () => { for (const remove of documentWatches.values()) remove(); documentWatches.clear(); });
  const skillCatalog = async () => {
    const documents = options.documents?.();
    if (documents?.enabled && options.environment) return documents.catalog(await options.environment());
    return PUBLIC_AGENT_SKILLS.map(skill => ({ ...skill, available: false, unavailableReason: "公共文档扩展尚未启用。" }));
  };
  let accessCheck: Promise<void> | undefined;
  const checkProjectAccess = async () => {
    for (const [key, entry] of [...runtimes]) {
      try {
        checkAccess(entry.projectId, entry.userId);
        const saved = settings.read(entry.userId);
        if (configurationHash(saved, entry.projectId) !== entry.mcpHash || providerConfigHash(saved.providers.find(provider => provider.id === entry.providerId)) !== entry.providerConfigHash) throw new DevelopmentError("开发 Agent 配置已变化");
      }
      catch {
        try { await runtimeRegistry.invalidate(entry.userId, "development:" + entry.projectId); }
        finally { if (runtimes.get(key) === entry) runtimes.delete(key); }
      }
    }
  };
  const accessTimer = setInterval(() => {
    if (accessCheck) return;
    accessCheck = checkProjectAccess().catch(error => { app.log.error(error, "Development project access check failed"); }).finally(() => { accessCheck = undefined; });
  }, 1000);
  accessTimer.unref();
  app.addHook("onClose", async () => { clearInterval(accessTimer); await accessCheck; });
  app.setErrorHandler((error, _req, reply) => {
    reply
      .status(error instanceof DevelopmentError ? error.status : 400)
      .send({ success: false, error: error.message });
  });
  await registerDevelopmentNative(app, {
    user: req => options.user(req), runtime: harness, client: options.nativeClient,
    authorized: (request, user, project) => {
      if (!options.isAuthenticated(request, user)) return false;
      try { projects.get(project, user); return true; } catch { return false; }
    },
  });
  const base = "/api/development/projects";
  app.get<{ Params: { id: string } }>(base + "/:id/agent/settings", async req => {
    const user = options.user(req); checkAccess(req.params.id, user);
    return { success: true, data: { ...policy(settings.read(user), req.params.id), skills: await skillCatalog() } };
  });
  app.put<{ Params: { id: string }; Body: { enabledCapabilities: AgentCapability[]; disabledTools: string[]; enabledSkills?: string[] } }>(base + "/:id/agent/settings", async req => {
    const user = options.user(req), id = req.params.id;
    checkAccess(id, user);
    const saved = settings.read(user), input = req.body, key = "development:" + id;
    if (!input || !Array.isArray(input.enabledCapabilities) || input.enabledCapabilities.some(value => !developmentCapabilities.includes(value)) || !Array.isArray(input.disabledTools)) throw new DevelopmentError("开发 Agent 设置无效");
    const skills = input.enabledSkills ?? saved.applications[key]?.skills ?? [];
    if (!Array.isArray(skills) || skills.some(id => !PUBLIC_AGENT_SKILLS.some(skill => skill.id === id))) throw new DevelopmentError("开发 Agent Skills 设置无效");
    const catalog = await skillCatalog();
    if (input.enabledSkills && skills.some(id => !catalog.some(skill => skill.id === id && skill.available))) throw new DevelopmentError("系统依赖未就绪，无法启用此 Skill；请联系管理员。");
    settings.write(user, { ...saved, grants: { ...saved.grants, [key]: input.enabledCapabilities }, applications: { ...saved.applications, [key]: { skills, disabledTools: input.disabledTools, tools: saved.applications[key]?.tools ?? [] } } });
    await runtimeRegistry.invalidate(user, key);
    runtimes.delete(user + ":" + id);
    return { success: true, data: policy(settings.read(user), id) };
  });
  const releases = options.releases ?? new DevelopmentReleases(
    options.dataDir,
    projects,
    options.builds,
  );
  if (options.registerSource) await options.registerSource(app);
  else await registerDevelopmentSource(app, { dataDir: options.dataDir, projects, user: request => options.user(request) });
  const attachments = options.attachments ?? new DevelopmentAttachments(projects);
  attachments.register(app, { user: request => options.user(request) });
  registerDevelopmentExecution(app, { builds: options.builds, previews: options.previews, releases, user: request => options.user(request) });
  registerDevelopmentProjects(app, { projects, user: request => options.user(request) });
  const creations = options.creations ?? new ApplicationCreations(options.dataDir, projects);
  app.get("/api/development/creations", async req => ({ success: true, data: creations.list(options.user(req)) }));
  app.post<{ Body: { providerId: string } }>(
    "/api/development/creations",
    async (req) => {
      const saved = settings.read(options.user(req));
      const providerId =
        req.body?.providerId ||
        saved.defaultProviderId ||
        saved.providers[0]?.id;
      if (!saved.providers.some((p) => p.id === providerId))
        throw new DevelopmentError("请先配置模型供应商");
      return { success: true, data: creations.create(options.user(req), providerId!) };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/development/creations/:id",
    async (req) => ({
      success: true,
      data: creations.get(req.params.id, options.user(req)),
    }),
  );
  app.post<{ Params: { id: string }; Body: { name: string } }>(
    "/api/development/creations/:id/confirm",
    async (req) => ({
      success: true,
      data: await creations.confirm(req.params.id, options.user(req), req.body?.name),
    }),
  );
  const opening = new Map<string, Promise<DeepSeekHarness>>();
  const continuations=new Map<string,Promise<{accepted:boolean}>>();
  app.post<{Params:{id:string}}>("/api/development/creations/:id/continue",async req=>{
    const user=options.user(req),id=req.params.id,key=user+":"+id;
    let pending=continuations.get(key);
    if(!pending){
      pending=(async()=>{
        const record=creations.get(id,user);
        const prompt=creations.continuationPrompt(id,user,record.sessionId);
        if(record.continued)return {accepted:true};
        const native=await (await harness(id,user,record.providerId)).nativeApi();
        const result=await native.prompt({sessionId:record.sessionId,requestId:"localapp-creation-"+id,mode:"queue",content:[{type:"text",text:prompt}]},new AbortController().signal);
        if(result.accepted)creations.continue(id,user,record.sessionId);
        return result;
      })();
      continuations.set(key,pending);
      void pending.finally(()=>{if(continuations.get(key)===pending)continuations.delete(key);}).catch(()=>{});
    }
    return {success:true,data:await pending};
  });
  async function harness(id: string, user: string, providerId?: string) {
    const key = user + ":" + id;
    const previous = opening.get(key);
    if (previous) await previous;
    const pending = openHarness(id, user, providerId);
    opening.set(key, pending);
    try {
      return await pending;
    } finally {
      if (opening.get(key) === pending) opening.delete(key);
    }
  }
  async function openHarness(id: string, user: string, providerId?: string) {
    checkAccess(id, user);
    const saved = settings.read(user);
    const pythonEnvironment = options.pythonEnvironment();
    const configuration = configurationHash(saved, id);
    const provider = saved.providers.find(
      (p) =>
        p.id ===
        (providerId ??
          (creations.isPlanning(id, user)
            ? creations.get(id, user).providerId
            : saved.defaultProviderId) ??
          saved.providers[0]?.id),
    );
    if (!provider) throw new DevelopmentError("请先配置模型供应商");
    const documents = options.documents?.();
    const catalog = await skillCatalog();
    const skills = !creations.isPlanning(id, user) && policy(saved, id).enabledCapabilities.includes("skills") ? policy(saved, id).enabledSkills.filter(id => catalog.some(skill => skill.id === id && skill.available)) : [];
    if (skills.length && documents?.enabled && !documentWatches.has(documents)) {
      documentWatches.set(documents, documents.onStop(async () => {
        const stopped = await Promise.allSettled([...runtimes].map(async ([key, entry]) => {
          if (!settings.read(entry.userId).applications["development:" + entry.projectId]?.skills.length) return;
          await runtimeRegistry.invalidate(entry.userId, "development:" + entry.projectId);
          if (runtimes.get(key) === entry) runtimes.delete(key);
        }));
        const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Developer document runtimes failed to stop");
      }));
    }
    const hash = createHash("sha256")
        .update(
          JSON.stringify({
            provider,
            planning: creations.isPlanning(id, user),
            pythonEnvironment,
            mcpServers: saved.mcpServers,
            policy: policy(saved, id),
            skills, publicSkillsRoot: skills.length ? documents?.root : undefined,
          }),
        )
        .digest("hex"),
      key = user + ":" + id,
      old = runtimes.get(key);
    if (!old || old.providerHash !== hash) {
      projects.assertIdle(id, user);
      if (old) await runtimeRegistry.invalidate(user, "development:" + id);
    }
    const instance = await runtimeRegistry.acquire({ userId: user, applicationId: "development:" + id, role: "developer", providerId: provider.id }, hash, async () => {
    const nativeRuns = new Map<string, () => void>();
    const instance = options.createHarness({
      llmApiKey: provider.apiKey,
      llmBaseUrl: provider.baseUrl,
      llmModel: provider.model,
      protocol: provider.protocol,
      ownerId: user,
      onNativeAgentDisposed: sessionId => nativeRuns.get(sessionId)?.(),
      onNativePrompt: sessionId => {
        if (creations.isPlanning(id, user)) return () => {};
        if (nativeRuns.has(sessionId)) return () => {};
        const unlock = projects.lock(id, user);
        try { projects.snapshot(id, user, "原生 Agent 修改前自动保存"); }
        catch (error) { unlock(); throw error; }
        const release = () => { unlock(); nativeRuns.delete(sessionId); };
        nativeRuns.set(sessionId, release);
        return release;
      },
      onNativeAgentStatus: (sessionId, status) => {
        if (status !== "idle" || !nativeRuns.has(sessionId)) return;
        try { projects.snapshot(id, user, "原生 Agent 修改后保存"); }
        catch (error) { app.log.error({ err: error, projectId: id, sessionId }, "原生开发快照保存失败"); }
        finally { nativeRuns.get(sessionId)?.(); }
        try { options.builds.start(id, user, "preview"); }
        catch (error) { app.log.error({ err: error, projectId: id, sessionId }, "原生开发预览调度失败"); }
      },
      applicationPrompt: creations.isPlanning(id, user) ? CREATION_PROMPT : DEVELOPMENT_PROMPT,
      applicationTools: creations.isPlanning(id, user) ? [{
        name: "propose_application",
        description: "提出应用名称和需求摘要，等待用户确认后由平台创建应用",
        parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name", "description"] },
        execute: args => ({ proposal: creations.propose(id, user, args), requiresUserConfirmation: true }),
      }] : [],
      root: path.join(projects.directory, id, "agent", user),
      workspaceRoot: projects.workspace(id, user),
      dataRoot: options.dataDir,
      networkBlocked: true,
      autoSessionTitles: true,
      capabilities: creations.isPlanning(id, user)
        ? []
        : policy(saved, id).enabledCapabilities,
      mcpServers: creations.isPlanning(id, user) ? [] : saved.mcpServers,
      disabledTools: creations.isPlanning(id, user) ? [] : policy(saved, id).disabledTools,
      pythonEnvironment,
      skills,
      publicSkillsRoot: skills.length ? documents?.root : undefined,
    });
    try { await instance.initialize(); }
    catch (error) { await instance.close().catch(() => {}); throw error; }
    return instance;
    });
    try {
      checkAccess(id, user);
      if (skills.length && (!documents?.enabled || !options.documents?.()?.enabled)) throw new DevelopmentError("公共文档扩展已停用，请重试");
      if (configurationHash(settings.read(user), id) !== configuration) throw new DevelopmentError("开发 Agent 配置已变化，请重试");
      if (providerConfigHash(settings.read(user).providers.find(value => value.id === provider.id)) !== providerConfigHash(provider)) throw new DevelopmentError("模型供应商已变化，请重试");
    }
    catch (error) { await runtimeRegistry.invalidate(user, "development:" + id); throw error; }
    runtimes.set(key, { providerHash: hash, providerId: provider.id, providerConfigHash: providerConfigHash(provider), mcpHash: configuration, harness: instance, userId: user, projectId: id });
    return instance;
  }
  function checkAccess(id: string, user: string) {
    if (options.accountExists && !options.accountExists(user)) throw new DevelopmentError("账号不存在", 404);
    projects.get(id, user);
  }
  function configurationHash(saved: AgentSettings, id: string) {
    return createHash("sha256").update(JSON.stringify([saved.mcpServers, policy(saved, id), options.pythonEnvironment()])).digest("hex");
  }
  function providerConfigHash(provider: unknown) {
    return createHash("sha256").update(JSON.stringify(provider ?? null)).digest("hex");
  }
  app.get<{ Params: { id: string } }>(
    base + "/:id/agent/sessions",
    async (req) => ({
      success: true,
      data: await (await harness(req.params.id, options.user(req))).listSessions(),
    }),
  );
  app.get<{ Params: { id: string }; Querystring: { sessionId: string } }>(
    base + "/:id/agent/history",
    async (req) => ({
      success: true,
      data: await (
        await harness(req.params.id, options.user(req))
      ).history(req.query.sessionId),
    }),
  );
  app.post<{
    Params: { id: string };
    Body: { token: string; result: unknown };
  }>(base + "/:id/agent/respond", async (req) => {
    projects.get(req.params.id, options.user(req));
    const r = runtimes.get(options.user(req) + ":" + req.params.id);
    if (!r?.harness.result(options.user(req), req.body.token, req.body.result))
      throw new DevelopmentError("交互已结束", 404);
    return { success: true };
  });
  app.post<{ Params: { id: string }; Body: { sessionId: string } }>(
    base + "/:id/agent/cancel",
    async (req) => {
      projects.get(req.params.id, options.user(req));
      const r = runtimes.get(options.user(req) + ":" + req.params.id);
      return { success: !!r?.harness.cancel(options.user(req), req.body.sessionId) };
    },
  );
  app.post<{
    Params: { id: string };
    Body: {
      prompt: string;
      sessionId?: string;
      providerId?: string;
      attachmentIds?: string[];
      continueCreation?: boolean;
    };
  }>(base + "/:id/agent/run", async (req, reply) => {
    if (
      !req.body ||
      typeof req.body.prompt !== "string" ||
      !req.body.prompt.trim() ||
      req.body.prompt.length > 100000
    )
      throw new DevelopmentError("请输入开发需求");
    const uploadedFiles = attachments.prompt(
      req.params.id,
      options.user(req),
      req.body.attachmentIds,
    );
    const sessionId = req.body.sessionId ?? randomUUID();
    if (
      typeof sessionId !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(sessionId)
    )
      throw new DevelopmentError("会话标识无效");
    const planning = creations.isPlanning(req.params.id, options.user(req));
    if (planning) {
      const draft = creations.get(req.params.id, options.user(req));
      if (sessionId !== draft.sessionId)
        throw new DevelopmentError("请使用原创建会话");
    }
    const instance = await harness(
      req.params.id,
      options.user(req),
      req.body.providerId,
    );
    const release = projects.lock(req.params.id, options.user(req));
    let prompt = req.body.prompt;
    try {
      if (planning) creations.invalidateProposal(req.params.id, options.user(req));
      if (req.body.continueCreation)
        prompt = creations.continue(req.params.id, options.user(req), sessionId);
    } catch (error) {
      release();
      throw error;
    }

    try {
      projects.snapshot(req.params.id, options.user(req), "Agent 修改前自动保存");
    } catch (error) {
      release();
      throw error;
    }
    const controller = new AbortController(),
      disconnect = () => controller.abort();
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    reply.raw.on("close", disconnect);
    const emit = (event: unknown) => {
      if (!reply.raw.destroyed)
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      emit({ type: "session", sessionId });
      await instance.run(
        options.user(req),
        {
          sessionId,
          prompt: prompt + uploadedFiles,
          systemPrompt: planning ? CREATION_PROMPT : DEVELOPMENT_PROMPT,
          tools: [],
        },
        emit,
        controller.signal,
      );
    } catch (e) {
      emit({ type: "error", message: (e as Error).message });
    } finally {
      try {
        projects.snapshot(req.params.id, options.user(req), "Agent 修改后保存");
      } catch (error) {
        emit({ type: "error", message: (error as Error).message });
      }
      release();
      reply.raw.off("close", disconnect);
      if (planning)
        emit({
          type: "creation",
          creation: creations.get(req.params.id, options.user(req)),
        });
      reply.raw.end();
    }
  });
}
