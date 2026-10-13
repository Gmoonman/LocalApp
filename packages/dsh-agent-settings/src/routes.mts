import type {FastifyInstance,FastifyRequest} from "fastify";
import {AGENT_CAPABILITIES,type AgentSettingsStore} from "./settings.cjs";
import {PUBLIC_AGENT_SKILLS} from "@localapp/dsh-execution-environment/public-skills";
export interface AgentSettingsRoutesHost {
 settings:AgentSettingsStore;publicUrl?:string;
 userId(request:FastifyRequest):string;
 resolveApp(userId:string,appId?:string):{id:string;capabilities:typeof AGENT_CAPABILITIES[number][]};
 documentAvailability():Promise<Array<{id:string;name:string;description:string;dependencies:string;available:boolean;unavailableReason?:string}>>;
 runtime(userId:string,appId?:string):Promise<{toolCatalog():Array<{name:string;description:string}>}>;
 changed(userId:string,appId?:string):Promise<void>;
}
export async function registerAgentSettingsRoutes(app:FastifyInstance,host:AgentSettingsRoutesHost){
 const settings=host.settings,resolveAgentApp=host.resolveApp,documentAvailability=host.documentAvailability,runtime=host.runtime;
  app.get("/api/agent/settings", async (req) => ({ success: true, data: { ...settings.publicSettings(host.userId(req)), settingsUrl: `${(host.publicUrl || `${req.protocol}://${req.headers.host}`).replace(/\/$/, "")}/my/models` }, capabilities: AGENT_CAPABILITIES }));
  app.put("/api/agent/settings", async (req, reply) => {
    try {
      const data = settings.write(host.userId(req), req.body);
      await host.changed(host.userId(req));
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
      await host.changed(host.userId(req), application.id);
      return { success: true, data: await appPreferences(host.userId(req), application.id) };
    } catch (error) { return reply.status(400).send({ success: false, error: (error as Error).message }); }
  });
}
