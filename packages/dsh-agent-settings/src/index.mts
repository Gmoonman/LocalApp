import { Context, Service } from "@deepseek-ai/cordis";
import {registerAgentSettingsRoutes,type AgentSettingsRoutesHost} from "./routes.mjs";
import type {FastifyInstance} from "fastify";
import { AgentSettingsStore } from "./settings.cjs";
export {AgentSettingsStore,AGENT_CAPABILITIES,createSqliteSettingsPersistence} from "./settings.cjs";
export type {AgentSettings as UserAgentSettings,AgentProvider,AgentMcpServer,AgentAppPreferences,AgentCapability,SettingsPersistence} from "./settings.cjs";
export default class AgentSettings extends Service {
    private active = true;
    constructor(ctx: Context) { super(ctx, "localappAgentSettings"); ctx.effect(() => () => { this.active = false; }); }
    registerRoutes(app:FastifyInstance,host:AgentSettingsRoutesHost){
      if(!this.active)throw new Error("Agent settings plugin is stopped");
      app.register(async scope=>{scope.addHook("onRequest",async(_req,reply)=>{if(!this.active)return reply.code(503).send({success:false,error:"Agent settings plugin is stopped"});});return registerAgentSettingsRoutes(scope,host);});
    }
    createStore(...args: ConstructorParameters<typeof AgentSettingsStore>) { if (!this.active)
        throw new Error("Agent settings plugin is stopped"); return new AgentSettingsStore(...args); }
}
declare module "@deepseek-ai/cordis" {
    interface Context {
        localappAgentSettings: AgentSettings;
    }
}
