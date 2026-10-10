import type { FastifyInstance } from "fastify";
import path from "node:path";
import { readPythonEnvironment } from "../lib/python-environment.js";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { AgentSettingsStore, AGENT_CAPABILITIES } from "../lib/agent-settings.js";
import { PUBLIC_AGENT_SKILLS } from "../lib/public-agent-skills.js";
import { systemAgentEnvironment, publicSkillAvailability } from "../lib/system-agent-environment.js";
import { resolveAgentApp } from "../lib/agent-app.js";

export async function agentRoutes(app: FastifyInstance) {
  const { DeepSeekHarness } = await import("../lib/deepseek-harness.mjs");
  const settings = new AgentSettingsStore(app.config.dataDir);
  const { Context } = await import("@deepseek-ai/cordis");
  const { default: MultiuserRuntime } = await import("@localapp/dsh-multiuser");
  const context = new Context();
  await context.plugin(MultiuserRuntime, { capacity: 100 });
  const runtimes = context.localappMultiuser;
  app.addHook("preClose", () => runtimes.close());
  app.addHook("onClose", () => context.fiber.dispose());
  const runtime = async (userId: string, appId?: string, providerId?: string) => {
    const application = resolveAgentApp(app.config.dataDir, userId, appId);
    const saved = settings.read(userId);
    const provider = saved.providers.find((p) => p.id === (providerId || saved.defaultProviderId));
    if (!provider) throw new Error("请先在模型与 Agent 设置中配置供应商和默认模型");
    const capabilities = application.capabilities.filter((c) => saved.grants[application.id]?.includes(c));
    const preferences = saved.applications[application.id];
    const availableSkills = publicSkillAvailability(await systemAgentEnvironment(app.config.dataDir));
    const skills = capabilities.includes("skills") ? (preferences?.skills ?? []).filter(id => availableSkills.some(s => s.id === id && s.available)) : [];
    const disabledTools = preferences?.disabledTools ?? [];
    const key = JSON.stringify([userId, application.id, provider.id]);
    const pythonEnvironment = readPythonEnvironment(app.config.dataDir);
    const fingerprint = createHash("sha256").update(JSON.stringify([provider, capabilities, saved.mcpServers, skills, disabledTools, pythonEnvironment])).digest("hex");
    return runtimes.acquire({ userId, applicationId: application.id, role: "user", providerId: provider.id }, fingerprint, async () => {
      const root = path.join(app.config.dataDir, "agent", createHash("sha256").update(key).digest("hex"));
      const harness = new DeepSeekHarness({ llmApiKey: provider.apiKey, llmBaseUrl: provider.baseUrl, llmModel: provider.model, protocol: provider.protocol, autoSessionTitles: true, ownerId: userId, root, capabilities, mcpServers: saved.mcpServers, skills, disabledTools, pythonEnvironment });
      try { await harness.initialize(); }
      catch (error) { await harness.close().catch(() => {}); throw error; }
      return harness;
    });
  };
  // dsh owns RPC parsing; dispatch before Fastify consumes the raw body.
  // Read-only endpoints are enabled first; mutation and streams are wired with
  // application tools and developer permissions in the following migration.
  app.register(async nativeScope => {
    nativeScope.addHook("onRequest", async (req, reply) => {
      const query = req.query as { appId?: string; providerId?: string };
      let native;
      try { native = await (await runtime(req.userId, query.appId, query.providerId)).nativeApi(); }
      catch (error) { return reply.status(400).send({ success: false, error: String(error) }); }
      const originalUrl = req.raw.url;
      req.raw.url = originalUrl?.replace(/^\/api\/agent\/native(?=\/)/, "");
      reply.hijack();
      try {
        if (!await native.transport.http(req.userId, req.raw, reply.raw)) {
          reply.raw.writeHead(404); reply.raw.end();
        }
      } catch (error) {
        if (!reply.raw.headersSent) reply.raw.writeHead(500);
        reply.raw.end(); app.log.error({ err: error }, "Native session request failed");
      } finally { req.raw.url = originalUrl; }
    });
    for (const method of ["list", "page"]) nativeScope.post("/api/agent/native/api/session/" + method, async () => {});
  });
  const restoreSchedules = async (onlyUser?: string) => {
    for (const userId of onlyUser ? [onlyUser] : settings.users()) {
      const saved = settings.read(userId);
      for (const [appId, grants] of Object.entries(saved.grants)) {
        if (!grants.includes("schedule")) continue;
        for (const provider of saved.providers) {
          const key = JSON.stringify([userId, appId, provider.id]);
          if (!fs.existsSync(path.join(app.config.dataDir, "agent", createHash("sha256").update(key).digest("hex")))) continue;
          try { await runtime(userId, appId, provider.id); }
          catch { app.log.warn({ userId, appId }, "Agent scheduled work could not be restored"); }
        }
      }
    }
  };
  await restoreSchedules();
  app.get("/api/agent/settings", async (req) => ({ success: true, data: { ...settings.publicSettings(req.userId), settingsUrl: `${(app.config.publicUrl || `${req.protocol}://${req.headers.host}`).replace(/\/$/, "")}/my/models` }, capabilities: AGENT_CAPABILITIES }));
  app.put("/api/agent/settings", async (req, reply) => {
    try {
      const data = settings.write(req.userId, req.body);
      await runtimes.invalidate(req.userId);
      await restoreSchedules(req.userId);
      return { success: true, data };
    } catch (error) { return reply.status(400).send({ success: false, error: error instanceof Error ? error.message : "Invalid settings" }); }
  });
  const appPreferences = async (userId: string, appId: string) => {
    const application = resolveAgentApp(app.config.dataDir, userId, appId);
    if (application.id === "platform") throw new Error("请选择应用");
    const saved = settings.read(userId);
    const preferences = saved.applications[application.id] ?? { skills: [], disabledTools: [], tools: [] };
    const skillCatalog = publicSkillAvailability(await systemAgentEnvironment(app.config.dataDir));
    let builtins: Array<{ name: string; description: string }> = [];
    let toolsNotice = "";
    if (saved.defaultProviderId) {
      try { builtins = (await runtime(userId, application.id)).toolCatalog(); }
      catch { toolsNotice = "DSH 工具列表暂时无法加载，请检查模型和 MCP 设置。仍可修改应用能力。"; }
    } else toolsNotice = "配置模型供应商后可查看 DSH 工具。";
    return { appId: application.id, capabilities: application.capabilities, enabledCapabilities: saved.grants[application.id] ?? [], skills: skillCatalog.map(({ unavailableReason, ...s }) => ({ ...s, ...(s.available ? {} : { unavailableReason }) })), enabledSkills: preferences.skills.filter(id => skillCatalog.some(s => s.id === id && s.available)), disabledTools: preferences.disabledTools, toolsNotice, tools: [...builtins.map((tool) => ({ ...tool, source: "dsh" })), ...preferences.tools.map((tool) => ({ ...tool, source: "app" }))] };
  };
  app.post<{ Body: { appId: string; tools: Array<{ name: string; description: string }> } }>("/api/agent/app-tools", async (req, reply) => {
    try {
      const application = resolveAgentApp(app.config.dataDir, req.userId, req.body?.appId);
      if (application.id === "platform" || !Array.isArray(req.body.tools)) throw new Error("Invalid application tools");
      const saved = settings.read(req.userId);
      const preferences = saved.applications[application.id] ?? { skills: [], disabledTools: [], tools: [] };
      settings.write(req.userId, { ...saved, applications: { ...saved.applications, [application.id]: { ...preferences, tools: req.body.tools.map(({ name, description }) => ({ name, description })) } } });
      return { success: true };
    } catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
  });
  app.get<{ Querystring: { appId: string } }>("/api/agent/app-settings", async (req, reply) => {
    try { return { success: true, data: await appPreferences(req.userId, req.query.appId) }; }
    catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
  });
  app.put<{ Body: { appId: string; enabledCapabilities: string[]; enabledSkills: string[]; disabledTools: string[] } }>("/api/agent/app-settings", async (req, reply) => {
    try {
      const input = req.body;
      const application = resolveAgentApp(app.config.dataDir, req.userId, input?.appId);
      if (application.id === "platform" || !Array.isArray(input.enabledCapabilities) || input.enabledCapabilities.some((capability) => !application.capabilities.some((declared) => declared === capability))) throw new Error("Invalid application capabilities");
      if (!Array.isArray(input.enabledSkills) || input.enabledSkills.some(id => !PUBLIC_AGENT_SKILLS.some(s => s.id === id))) throw new Error("Invalid public skills");
      const catalog = publicSkillAvailability(await systemAgentEnvironment(app.config.dataDir));
      if (input.enabledSkills.some(id => !catalog.some(s => s.id === id && s.available))) throw new Error("系统文档处理依赖未就绪，无法启用此 Skill；请联系管理员。");
      const saved = settings.read(req.userId);
      settings.write(req.userId, { ...saved, grants: { ...saved.grants, [application.id]: input.enabledCapabilities }, applications: { ...saved.applications, [application.id]: { skills: input.enabledSkills, disabledTools: input.disabledTools, tools: saved.applications[application.id]?.tools ?? [] } } });
      await runtimes.invalidate(req.userId, application.id);
      await restoreSchedules(req.userId);
      return { success: true, data: await appPreferences(req.userId, application.id) };
    } catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
  });
  app.get<{ Querystring: { appId?: string; providerId?: string } }>("/api/agent/sessions", async (req, reply) => {
    try { return { success: true, data: await (await runtime(req.userId, req.query.appId, req.query.providerId)).listSessions() }; }
    catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
  });
  app.get<{ Params: { id: string }; Querystring: { appId?: string; providerId?: string } }>("/api/agent/sessions/:id", async (req, reply) => {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(req.params.id)) return reply.status(400).send({ success: false, error: "Invalid session id" });
    try { return { success: true, data: await (await runtime(req.userId, req.query.appId, req.query.providerId)).history(req.params.id) }; }
    catch { return reply.status(404).send({ success: false, error: "Conversation not found" }); }
  });
  app.post<{ Body: { sessionId: string; appId?: string; providerId?: string } }>("/api/agent/cancel", async (req, reply) => {
    if (!req.body || typeof req.body.sessionId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(req.body.sessionId)) return reply.status(400).send({ success: false, error: "Invalid session" });
    try { return { success: (await runtime(req.userId, req.body.appId, req.body.providerId)).cancel(req.userId, req.body.sessionId) }; }
    catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
  });
  app.get<{ Querystring: { sessionId: string; appId?: string; providerId?: string } }>("/api/agent/events", async (req, reply) => {
    if (typeof req.query.sessionId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(req.query.sessionId)) return reply.status(400).send({ success: false, error: "Invalid session" });
    let harness: InstanceType<typeof DeepSeekHarness>;
    try { harness = await runtime(req.userId, req.query.appId, req.query.providerId); }
    catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
    let dispose: () => void;
    try { dispose = harness.subscribe(req.query.sessionId, (event: any) => { if (!reply.raw.destroyed) { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); if (event.type === "connection_closed") reply.raw.end(); } }); }
    catch (error) { return reply.status(429).send({ success: false, error: (error as Error).message }); }
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    reply.raw.write(": connected\n\n");
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n"); }, 15_000);
    reply.raw.on("close", () => { clearInterval(heartbeat); dispose(); });
  });
  app.post<{ Body: { token: string; result: unknown } }>("/api/agent/tool-result", async (req, reply) => {
    if (!req.body || typeof req.body.token !== "string" || !runtimes.forUser<InstanceType<typeof DeepSeekHarness>>(req.userId).some((harness) => harness.result(req.userId, req.body.token, req.body.result))) return reply.status(404).send({ success: false, error: "Unknown tool call" });
    return { success: true };
  });
  app.post<{ Body: import("../lib/deepseek-harness.mjs", { with: { "resolution-mode": "import" } }).HarnessInput }>("/api/agent/run", async (req, reply) => {
    const input = req.body;
    if (!input || typeof input.sessionId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(input.sessionId) || typeof input.prompt !== "string" || !input.prompt.trim() || typeof input.systemPrompt !== "string" || !Array.isArray(input.tools) || input.tools.length > 100 || input.tools.some((t) => !t || typeof t.name !== "string" || !t.name || typeof t.description !== "string" || !t.parameters || typeof t.parameters !== "object" || Array.isArray(t.parameters)) || new Set(input.tools.map((t) => t.name)).size !== input.tools.length) return reply.status(400).send({ success: false, error: "Invalid agent request" });
    let harness: InstanceType<typeof DeepSeekHarness>;
    try { harness = await runtime(req.userId, input.appId, input.providerId); }
    catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
    if (input.appId && input.appId !== "platform") {
      const application = resolveAgentApp(app.config.dataDir, req.userId, input.appId);
      const saved = settings.read(req.userId);
      const preferences = saved.applications[application.id] ?? { skills: [], disabledTools: [], tools: [] };
      settings.write(req.userId, { ...saved, applications: { ...saved.applications, [application.id]: { ...preferences, tools: input.tools.map(({ name, description }) => ({ name, description })) } } });
      input.tools = input.tools.filter((tool) => !preferences.disabledTools.includes(tool.name));
    }
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    reply.raw.on("close", disconnect);
    const emit = (event: unknown) => { if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
    try { await harness.run(req.userId, input, emit, controller.signal); }
    catch (err) { emit({ type: "error", message: err instanceof Error ? err.message : String(err) }); }
    finally { reply.raw.off("close", disconnect); reply.raw.end(); }
  });
}
