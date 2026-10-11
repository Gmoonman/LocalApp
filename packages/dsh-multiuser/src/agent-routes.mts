import type DocumentTools from "@localapp/dsh-document-tools";
import { resolveUserWorkspace } from "./legacy-history.mjs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DeepSeekHarness, HarnessInput } from "./harness.mjs";
import type MultiuserRuntime from "./index.mjs";
import type NativeClientAssets from "./native-client-assets.mjs";
import type { SystemEnvironment } from "./system-environment.cjs";
import { PUBLIC_AGENT_SKILLS } from "./public-skills.cjs";
import { readPythonEnvironment } from "./python-environment.cjs";
import { AGENT_CAPABILITIES, type AgentSettingsStore } from "./settings.cjs";
import { decodeNativeScope } from "./native-scope.cjs";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
export interface AgentRoutesHost {
  dataDir: string;
  publicUrl?: string;
  settings: AgentSettingsStore;
  documents?(): DocumentTools | undefined;
  runtimes: MultiuserRuntime;
  userId(request: FastifyRequest): string;
  isAuthenticated(request: FastifyRequest, userId: string): boolean;
  resolveApp(userId: string, appId?: string): { id: string; capabilities: typeof AGENT_CAPABILITIES[number][] };
  environment(): ReturnType<SystemEnvironment["check"]>;
  clientAssets(): Promise<NativeClientAssets>;
  createHarness(config: ConstructorParameters<typeof DeepSeekHarness>[0]): DeepSeekHarness;
}
export async function registerAgentRoutes(app: FastifyInstance, host: AgentRoutesHost, options: { nativeClientRoot?: string } = {}) {
  const settings = host.settings;
  const runtimes = host.runtimes;
  const resolveAgentApp = host.resolveApp;
  const settingsFingerprint = (saved: ReturnType<AgentSettingsStore["read"]>, appId: string, providerId: string) => createHash("sha256").update(JSON.stringify([saved.providers.find(provider => provider.id === providerId) ?? null, saved.mcpServers, saved.applications[appId]?.skills ?? [], saved.applications[appId]?.disabledTools ?? []])).digest("hex");
  const active = new Map<string, { fingerprint: string; settingsFingerprint: string; providerId: string; pythonConfiguration: string; harness: DeepSeekHarness; userId: string; appId: string; capabilities: string[]; documents?: DocumentTools }>();
  const opening = new Map<string, Promise<void>>();
  const requests = new Map<string, number>();
  const documentWatches = new Map<DocumentTools, () => void>();
  let permissionCheck: Promise<void> | undefined;
  const checkApplicationAccess = async () => {
    for (const [scope, entry] of [...active]) {
      try {
        const application = resolveAgentApp(entry.userId, entry.appId);
        const saved = settings.read(entry.userId);
        const capabilities = application.capabilities.filter(capability => saved.grants[application.id]?.includes(capability));
        if (JSON.stringify([...capabilities].sort()) !== JSON.stringify([...entry.capabilities].sort())) throw new Error("Application Agent capabilities changed");
        if (JSON.stringify(readPythonEnvironment(host.dataDir) ?? null) !== entry.pythonConfiguration) throw new Error("Agent Python environment changed");
        if (settingsFingerprint(saved, entry.appId, entry.providerId) !== entry.settingsFingerprint) throw new Error("Agent model or tool settings changed");
      }
      catch {
        try { await runtimes.invalidate(entry.userId, entry.appId); }
        finally { if (active.get(scope) === entry) active.delete(scope); }
      }
    }
  };
  const permissionTimer = setInterval(() => {
    if (permissionCheck) return;
    permissionCheck = checkApplicationAccess().catch(error => { app.log.error(error, "Agent application access check failed"); }).finally(() => { permissionCheck = undefined; });
  }, 1000);
  permissionTimer.unref();
  app.addHook("onClose", async () => { clearInterval(permissionTimer); await permissionCheck; });

  app.addHook("onClose", async () => { for (const remove of documentWatches.values()) remove(); documentWatches.clear(); });
  const watchDocuments = (documents: DocumentTools) => {
    if (documentWatches.has(documents)) return;
    const remove = documents.onStop(async () => {
      const stopped = [...active].filter(([, entry]) => entry.documents === documents);
      const results = await Promise.allSettled(stopped.map(async ([scope, entry]) => {
        try { await runtimes.invalidate(entry.userId, entry.appId); }
        finally { if (active.get(scope) === entry) active.delete(scope); }
      }));
      documentWatches.delete(documents);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Document Agent runtimes failed to close");
    });
    documentWatches.set(documents, remove);
  };
  const documentAvailability = async () => {
    const documents = host.documents?.();
    if (documents?.enabled) return documents.catalog(await host.environment());
    return PUBLIC_AGENT_SKILLS.map(skill => ({ ...skill, available: false, unavailableReason: "公共文档扩展尚未启用。" }));
  };
  const openRuntime = async (userId: string, appId?: string, providerId?: string) => {
    const application = resolveAgentApp(userId, appId);
    const saved = settings.read(userId);
    const provider = saved.providers.find((p) => p.id === (providerId || saved.defaultProviderId));
    if (!provider) throw new Error("请先在模型与 Agent 设置中配置供应商和默认模型");
    const configuration = settingsFingerprint(saved, application.id, provider.id);
    const capabilities = application.capabilities.filter((c) => saved.grants[application.id]?.includes(c));
    const preferences = saved.applications[application.id];
    const availableSkills = await documentAvailability();
    const documents = host.documents?.();
    if (documents?.enabled) watchDocuments(documents);
    const skills = capabilities.includes("skills") ? (preferences?.skills ?? []).filter(id => availableSkills.some(s => s.id === id && s.available)) : [];
    const disabledTools = preferences?.disabledTools ?? [];
    const pythonEnvironment = readPythonEnvironment(host.dataDir);
    const pythonConfiguration = JSON.stringify(pythonEnvironment ?? null);
    const fingerprint = createHash("sha256").update(JSON.stringify([provider, capabilities, saved.mcpServers, skills, disabledTools, pythonEnvironment, skills.length ? documents?.root : undefined])).digest("hex");
    const scope = JSON.stringify([userId, application.id]);
    const previous = active.get(scope);
    if (previous && previous.fingerprint !== fingerprint) {
      if ((requests.get(scope) ?? 0) > 0 || previous.harness.isRunning()) throw new Error("Wait for the current Agent turn to finish before switching model providers");
      await runtimes.invalidate(userId, application.id);
      active.delete(scope);
    }
    const root = await resolveUserWorkspace(host.dataDir, userId, application.id, provider.id, saved.providers.map(value => value.id));
    const value = await runtimes.acquire({ userId, applicationId: application.id, role: "user", providerId: provider.id }, fingerprint, async () => {
      const harness = host.createHarness({ llmApiKey: provider.apiKey, llmBaseUrl: provider.baseUrl, llmModel: provider.model, protocol: provider.protocol, autoSessionTitles: true, ownerId: userId, root, capabilities, mcpServers: saved.mcpServers, skills, disabledTools, pythonEnvironment, publicSkillsRoot: documents?.root });
      try { await harness.initialize(); }
      catch (error) { await harness.close().catch(() => {}); throw error; }
      return harness;
    });
    try {
      const current = resolveAgentApp(userId, application.id);
      const currentSettings = settings.read(userId);
      const currentCapabilities = current.capabilities.filter(capability => currentSettings.grants[current.id]?.includes(capability));
      if (current.id !== application.id || JSON.stringify([...currentCapabilities].sort()) !== JSON.stringify([...capabilities].sort())) throw new Error("Application Agent capabilities changed during initialization");
      if (JSON.stringify(readPythonEnvironment(host.dataDir) ?? null) !== pythonConfiguration) throw new Error("Agent Python environment changed during initialization");
      if (settingsFingerprint(currentSettings, application.id, provider.id) !== configuration) throw new Error("Agent model or tool settings changed during initialization");
    } catch (error) {
      await runtimes.invalidate(userId, application.id);
      throw error;
    }
    if (skills.length && !documents?.enabled) {
      await runtimes.invalidate(userId, application.id);
      throw new Error("Document tools plugin stopped during Agent initialization");
    }
    active.set(scope, { fingerprint, settingsFingerprint: configuration, providerId: provider.id, pythonConfiguration, harness: value, userId, appId: application.id, capabilities, documents: skills.length ? documents : undefined });
    return value;
  };
  const runtime = async (userId: string, appId?: string, providerId?: string, reserve?: () => void) => {
    const scope = JSON.stringify([userId, resolveAgentApp(userId, appId).id]);
    const previous = opening.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => pending);
    opening.set(scope, tail);
    await previous;
    try { const harness = await openRuntime(userId, appId, providerId); reserve?.(); return harness; }
    finally { release(); if (opening.get(scope) === tail) opening.delete(scope); }
  };
  const leaseRuntime = async (userId: string, appId?: string, providerId?: string, request?: FastifyRequest) => {
    if (request && !host.isAuthenticated(request, userId)) throw new Error("Agent authentication is no longer valid");
    const scope = JSON.stringify([userId, resolveAgentApp(userId, appId).id]);
    const harness = await runtime(userId, appId, providerId, () => requests.set(scope, (requests.get(scope) ?? 0) + 1));
    let released = false;
    const leased = { harness, release: () => {
      if (released) return;
      released = true;
      const count = (requests.get(scope) ?? 1) - 1;
      if (count) requests.set(scope, count); else requests.delete(scope);
    } };
    if (request && !host.isAuthenticated(request, userId)) {
      leased.release();
      await runtimes.invalidate(userId, resolveAgentApp(userId, appId).id);
      throw new Error("Agent authentication changed during initialization");
    }
    return leased;
  };
  const clientAssets = () => host.clientAssets();
  app.register(async pages => {
    pages.addHook("onRequest", async (req, reply) => {
      try {
        const scope = decodeNativeScope((req.params as { scope: string }).scope);
        await runtime(host.userId(req), scope.appId, scope.providerId);
      } catch (error) { return reply.status(400).send({ success: false, error: String(error) }); }
    });
    pages.get("/api/agent/native/:scope/", async (req, reply) => {
      const scope = (req.params as { scope: string }).scope;
      const base = "/api/agent/native/" + scope + "/";
      if (!new URL(req.raw.url ?? "/", "http://localapp.invalid").pathname.endsWith("/")) return reply.redirect(base);
      const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"><base href="' + base + '"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="client/entry.css"></head><body><div id="root"></div><script type="module" src="client/entry.js"></script></body></html>';
      reply.header("Cache-Control", "no-store");
      const selected = decodeNativeScope(scope);
      const native = await (await runtime(host.userId(req), selected.appId, selected.providerId)).nativeApi();
      return reply.type("text/html; charset=utf-8").send(await (await clientAssets()).renderIndex(html, native.schedule));
    });
    const resourceHandler: import("fastify").RouteHandlerMethod = async (req, reply) => {
      const prefix = "/api/agent/native/" + (req.params as { scope: string }).scope;
      const selected = decodeNativeScope((req.params as { scope: string }).scope);
      const native = await (await runtime(host.userId(req), selected.appId, selected.providerId)).nativeApi();
      const original = req.raw.url; req.raw.url = original?.slice(prefix.length);
      reply.hijack();
      try { if (!await (await clientAssets()).resource(req.raw, reply.raw, native.schedule)) { reply.raw.writeHead(404); reply.raw.end(); } }
      catch (error) { if (!reply.raw.headersSent) reply.raw.writeHead(500); reply.raw.end(); app.log.error({ err: error }, "Native client resource failed"); }
      finally { req.raw.url = original; }
    };
    pages.get("/api/agent/native/:scope/plugins/", resourceHandler);
    pages.get("/api/agent/native/:scope/plugins/*", resourceHandler);
    pages.get("/api/agent/native/:scope/client/*", async (req, reply) => {
      const filename = (req.params as { "*": string })["*"];
      if (!options.nativeClientRoot || !/^(?:entry\.(?:js|css)|assets\/[a-zA-Z0-9_.-]+\.(?:woff2?|ttf))$/.test(filename)) return reply.status(404).send();
      try {
        const bytes = await fs.promises.readFile(path.join(options.nativeClientRoot, filename));
        const mime = filename.endsWith(".js") ? "application/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".woff2") ? "font/woff2" : filename.endsWith(".woff") ? "font/woff" : "font/ttf";
        return reply.type(mime).send(bytes);
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.status(404).send(); throw error; }
    });
  });
  // dsh owns RPC parsing; dispatch before Fastify consumes the raw body.
  // Enable reviewed session operations explicitly; application tools and
  // developer permissions are wired in the following migration.
  // Preserve upgrade bytes before @fastify/websocket routes the same request
  // through authentication hooks. This observer never consumes the socket.
  const nativeUpgrades = new WeakMap<IncomingMessage, { socket: Duplex; head: Buffer }>();
  const captureUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (/^\/api\/agent\/native\/(?:[^/]+\/)?api\/remote\.mux$/.test(new URL(request.url ?? "/", "http://localapp.invalid").pathname)) nativeUpgrades.set(request, { socket, head });
  };
  app.server.prependListener("upgrade", captureUpgrade);
  const connectionChecks = new Set<() => void>();
  app.addHook("onClose", async () => {
    app.server.removeListener("upgrade", captureUpgrade);
    for (const close of [...connectionChecks]) close();
  });
  app.register(async nativeScope => {
    nativeScope.addHook("onRequest", async (req, reply) => {
      const query = req.query as { appId?: string; providerId?: string };
      let native;
      let releaseRuntime = () => {};
      const encoded = (req.params as { scope?: string }).scope;
      try {
        const scope = encoded === undefined ? query : decodeNativeScope(encoded);
        const leased = await leaseRuntime(host.userId(req), scope.appId, scope.providerId, req);
        releaseRuntime = leased.release;
        native = await leased.harness.nativeApi();
      }
      catch (error) { releaseRuntime(); return reply.status(400).send({ success: false, error: String(error) }); }
      const originalUrl = req.raw.url;
      const prefix = encoded === undefined ? "/api/agent/native" : "/api/agent/native/" + encoded;
      req.raw.url = originalUrl?.slice(prefix.length);
      reply.hijack();
      try {
        const upgrade = nativeUpgrades.get(req.raw);
        nativeUpgrades.delete(req.raw);
        if (upgrade) {
          const userId = host.userId(req);
          const scope = encoded === undefined ? query : decodeNativeScope(encoded);
          const admittedApp = resolveAgentApp(userId, scope.appId).id;
          const authorized = () => {
            try { return host.isAuthenticated(req, userId) && resolveAgentApp(userId, scope.appId).id === admittedApp; }
            catch { return false; }
          };
          if (!authorized()) { upgrade.socket.destroy(); return; }
          // Follow streams outlive their initial HTTP authentication. Recheck
          // the original credentials and application access until the socket closes.
          const timer = setInterval(() => { if (!authorized()) upgrade.socket.destroy(); }, 1000);
          timer.unref();
          const close = () => { clearInterval(timer); connectionChecks.delete(close); upgrade.socket.destroy(); };
          connectionChecks.add(close);
          upgrade.socket.once("close", close);
        }
        const handled = upgrade
          ? await native.transport.upgrade(host.userId(req), req.raw, upgrade.socket, upgrade.head)
          : await native.transport.http(host.userId(req), req.raw, reply.raw);
        if (!handled) {
          reply.raw.writeHead(404); reply.raw.end();
        }
      } catch (error) {
        if (!reply.raw.headersSent) reply.raw.writeHead(500);
        reply.raw.end(); app.log.error({ err: error }, "Native session request failed");
      } finally { req.raw.url = originalUrl; releaseRuntime(); }
    });
    for (const prefix of ["/api/agent/native", "/api/agent/native/:scope"]) {
      nativeScope.get(prefix + "/api/remote.mux", async () => {});
      nativeScope.post(prefix + "/api/$events/result", async () => {});
      nativeScope.post(prefix + "/api/workspace/initializeDefault", async () => {});
      for(const method of ["archiveSession","unarchiveSession","pinSession","unpinSession"])nativeScope.post(prefix+"/api/workspace/"+method,async()=>{});
      nativeScope.post(prefix + "/api/settings/describe", async () => {});
      for (const method of ["clear", "complete", "create", "edit", "get", "pause", "resume"]) nativeScope.post(prefix + "/api/goals/" + method, async () => {});
      for (const method of ["catalog", "delete", "history", "list", "update"]) nativeScope.post(prefix + "/api/schedule/" + method, async () => {});
      nativeScope.post(prefix + "/api/commands/list", async () => {});
      nativeScope.post(prefix + "/api/skills/list", async () => {});
      nativeScope.post(prefix + "/api/fileReferences/list", async () => {});
      nativeScope.post(prefix + "/api/job/kill", async () => {});
      nativeScope.post(prefix + "/api/userQuestions/answer", async () => {});
      for (const method of ["list", "page", "create", "prompt", "cancel", "rename", "search", "modelCatalog", "selectModel", "uploadFileBinary", "fork", "attachment", "projections", "updateQueue"]) nativeScope.post(prefix + "/api/session/" + method, async () => {});
    }
  });
  const restoreSchedules = async (onlyUser?: string) => {
    for (const userId of onlyUser ? [onlyUser] : settings.users()) {
      const saved = settings.read(userId);
      for (const [appId, grants] of Object.entries(saved.grants)) {
        if (!grants.includes("schedule")) continue;
        const provider = saved.providers.find(value => value.id === saved.defaultProviderId);
        if (!provider) continue;
        const hash = (values: string[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
        const associated = fs.existsSync(path.join(host.dataDir, "agent", "associations", hash([userId, appId]) + ".json"));
        const legacy = saved.providers.some(value => fs.existsSync(path.join(host.dataDir, "agent", hash([userId, appId, value.id]))));
        if (!associated && !legacy) continue;
        try { await runtime(userId, appId, provider.id); }
        catch { app.log.warn({ userId, appId }, "Agent scheduled work could not be restored"); }
      }
    }
  };
  await restoreSchedules();
  app.get("/api/agent/settings", async (req) => ({ success: true, data: { ...settings.publicSettings(host.userId(req)), settingsUrl: `${(host.publicUrl || `${req.protocol}://${req.headers.host}`).replace(/\/$/, "")}/my/models` }, capabilities: AGENT_CAPABILITIES }));
  app.put("/api/agent/settings", async (req, reply) => {
    try {
      const data = settings.write(host.userId(req), req.body);
      await runtimes.invalidate(host.userId(req));
      await restoreSchedules(host.userId(req));
      return { success: true, data };
    } catch (error) { return reply.status(400).send({ success: false, error: error instanceof Error ? error.message : "Invalid settings" }); }
  });
  const appPreferences = async (userId: string, appId: string) => {
    const application = resolveAgentApp(userId, appId);
    if (application.id === "platform" && !application.capabilities.length) throw new Error("请选择应用");
    const saved = settings.read(userId);
    const preferences = saved.applications[application.id] ?? { skills: [], disabledTools: [], tools: [] };
    const skillCatalog = await documentAvailability();
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
      const application = resolveAgentApp(host.userId(req), req.body?.appId);
      if (application.id === "platform" || !Array.isArray(req.body.tools)) throw new Error("Invalid application tools");
      const saved = settings.read(host.userId(req));
      const preferences = saved.applications[application.id] ?? { skills: [], disabledTools: [], tools: [] };
      settings.write(host.userId(req), { ...saved, applications: { ...saved.applications, [application.id]: { ...preferences, tools: req.body.tools.map(({ name, description }) => ({ name, description })) } } });
      return { success: true };
    } catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
  });
  app.get<{ Querystring: { appId: string } }>("/api/agent/app-settings", async (req, reply) => {
    try { return { success: true, data: await appPreferences(host.userId(req), req.query.appId) }; }
    catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
  });
  app.put<{ Body: { appId: string; enabledCapabilities: string[]; enabledSkills: string[]; disabledTools: string[] } }>("/api/agent/app-settings", async (req, reply) => {
    try {
      const input = req.body;
      const application = resolveAgentApp(host.userId(req), input?.appId);
      if ((application.id === "platform" && !application.capabilities.length) || !Array.isArray(input.enabledCapabilities) || input.enabledCapabilities.some((capability) => !application.capabilities.some((declared) => declared === capability))) throw new Error("Invalid application capabilities");
      if (!Array.isArray(input.enabledSkills) || input.enabledSkills.some(id => !PUBLIC_AGENT_SKILLS.some(s => s.id === id))) throw new Error("Invalid public skills");
      const catalog = await documentAvailability();
      if (input.enabledSkills.some(id => !catalog.some(s => s.id === id && s.available))) throw new Error("系统文档处理依赖未就绪，无法启用此 Skill；请联系管理员。");
      const saved = settings.read(host.userId(req));
      settings.write(host.userId(req), { ...saved, grants: { ...saved.grants, [application.id]: input.enabledCapabilities }, applications: { ...saved.applications, [application.id]: { skills: input.enabledSkills, disabledTools: input.disabledTools, tools: saved.applications[application.id]?.tools ?? [] } } });
      await runtimes.invalidate(host.userId(req), application.id);
      await restoreSchedules(host.userId(req));
      return { success: true, data: await appPreferences(host.userId(req), application.id) };
    } catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
  });
  app.get<{ Querystring: { appId?: string; providerId?: string } }>("/api/agent/sessions", async (req, reply) => {
    try { return { success: true, data: await (await runtime(host.userId(req), req.query.appId, req.query.providerId)).listSessions() }; }
    catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
  });
  app.get<{ Params: { id: string }; Querystring: { appId?: string; providerId?: string } }>("/api/agent/sessions/:id", async (req, reply) => {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(req.params.id)) return reply.status(400).send({ success: false, error: "Invalid session id" });
    try { return { success: true, data: await (await runtime(host.userId(req), req.query.appId, req.query.providerId)).history(req.params.id) }; }
    catch { return reply.status(404).send({ success: false, error: "Conversation not found" }); }
  });
  app.post<{ Body: { sessionId: string; appId?: string; providerId?: string } }>("/api/agent/cancel", async (req, reply) => {
    if (!req.body || typeof req.body.sessionId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(req.body.sessionId)) return reply.status(400).send({ success: false, error: "Invalid session" });
    try { return { success: (await runtime(host.userId(req), req.body.appId, req.body.providerId)).cancel(host.userId(req), req.body.sessionId) }; }
    catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
  });
  app.get<{ Querystring: { sessionId: string; appId?: string; providerId?: string } }>("/api/agent/events", async (req, reply) => {
    if (typeof req.query.sessionId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(req.query.sessionId)) return reply.status(400).send({ success: false, error: "Invalid session" });
    let harness: InstanceType<typeof DeepSeekHarness>;
    try { harness = await runtime(host.userId(req), req.query.appId, req.query.providerId); }
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
    if (!req.body || typeof req.body.token !== "string" || !runtimes.forUser<InstanceType<typeof DeepSeekHarness>>(host.userId(req)).some((harness) => harness.result(host.userId(req), req.body.token, req.body.result))) return reply.status(404).send({ success: false, error: "Unknown tool call" });
    return { success: true };
  });
  app.post<{ Body: HarnessInput }>("/api/agent/native-context", async (req, reply) => {
    const input = req.body;
    if (!input || typeof input.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId) || typeof input.systemPrompt !== "string" || input.systemPrompt.length > 100000 || !Array.isArray(input.tools) || input.tools.length > 100 || input.tools.some(tool => !tool || typeof tool.name !== "string" || !tool.name || typeof tool.description !== "string" || !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) || new Set(input.tools.map(tool => tool.name)).size !== input.tools.length) return reply.code(400).send({ success: false, error: "Invalid application context" });
    let leased: Awaited<ReturnType<typeof leaseRuntime>> | undefined;
    try {
      leased = await leaseRuntime(host.userId(req), input.appId, input.providerId, req);
      const harness = leased.harness;
      const application = resolveAgentApp(host.userId(req), input.appId);
      const disabled = settings.read(host.userId(req)).applications[application.id]?.disabledTools ?? [];
      await harness.bindNativeApplication(host.userId(req), { ...input, prompt: "", tools: input.tools.filter(tool => !disabled.includes(tool.name)) });
      return { success: true };
    } catch (error) { return reply.code(400).send({ success: false, error: (error as Error).message }); }
    finally { leased?.release(); }
  });
  app.post<{ Body: HarnessInput }>("/api/agent/run", async (req, reply) => {
    const input = req.body;
    if (!input || typeof input.sessionId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(input.sessionId) || typeof input.prompt !== "string" || !input.prompt.trim() || typeof input.systemPrompt !== "string" || !Array.isArray(input.tools) || input.tools.length > 100 || input.tools.some((t) => !t || typeof t.name !== "string" || !t.name || typeof t.description !== "string" || !t.parameters || typeof t.parameters !== "object" || Array.isArray(t.parameters)) || new Set(input.tools.map((t) => t.name)).size !== input.tools.length) return reply.status(400).send({ success: false, error: "Invalid agent request" });
    let leased: Awaited<ReturnType<typeof leaseRuntime>>;
    try { leased = await leaseRuntime(host.userId(req), input.appId, input.providerId, req); }
    catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
    const harness = leased.harness;
    try {
      if (input.appId && input.appId !== "platform") {
        const application = resolveAgentApp(host.userId(req), input.appId);
        const saved = settings.read(host.userId(req));
        const preferences = saved.applications[application.id] ?? { skills: [], disabledTools: [], tools: [] };
        settings.write(host.userId(req), { ...saved, applications: { ...saved.applications, [application.id]: { ...preferences, tools: input.tools.map(({ name, description }) => ({ name, description })) } } });
        input.tools = input.tools.filter((tool) => !preferences.disabledTools.includes(tool.name));
      }
      const controller = new AbortController();
      const disconnect = () => controller.abort();
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      reply.raw.on("close", disconnect);
      const emit = (event: unknown) => { if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
      try { await harness.run(host.userId(req), input, emit, controller.signal); }
      catch (err) { emit({ type: "error", message: err instanceof Error ? err.message : String(err) }); }
      finally { reply.raw.off("close", disconnect); reply.raw.end(); }
    } finally { leased.release(); }
  });
}
