import { registerDependencyRoutes } from "./dependency-routes.cjs";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { registerPersonalPages, type PersonalPagesHost } from "./personal-pages.cjs";
import { registerAgentRoutes, type AgentRoutesHost } from "./agent-routes.mjs";
import { registerLlmRoutes, type LlmRoutesHost } from "./llm-routes.cjs";
import { Context, Service } from "@deepseek-ai/cordis";
import type { SystemEnvironment } from "./system-environment.cjs";
import { registerSetupRoutes, type SetupHost } from "./setup-routes.cjs";
import { registerEnvironmentRoutes, type EnvironmentRoutesHost } from "./environment-routes.cjs";
import type { AccountServices } from "./account-services.cjs";
import { registerAdministratorAccounts, type AdministratorAccountsHost } from "./admin-accounts-routes.cjs";
import type { FastifyInstance } from "fastify";
import { registerProfileRoutes, type ProfileHost } from "./profile-routes.cjs";
import { registerKeyRoutes, type KeyRoutesHost } from "./keys-routes.cjs";
import { registerAuthenticationRoutes, type AuthenticationHost } from "./auth-routes.cjs";
import { registerGroupRoutes, type GroupRoutesHost } from "./groups-routes.cjs";
import { AgentSettingsStore } from "./settings.cjs";
import { SecretBox } from "./secret-box.cjs";
import { registerBrowserSessions, type BrowserSessionHost } from "./browser-sessions.cjs";

export type {RuntimeIdentity,Runtime} from "@localapp/dsh-agent-runtime";
import AgentSettings from "@localapp/dsh-agent-settings";
import AgentRuntime, {type RuntimeIdentity,type Runtime} from "@localapp/dsh-agent-runtime";
export interface Config { capacity?: number; accountServices?: AccountServices; systemEnvironment?: SystemEnvironment }
declare module "@deepseek-ai/cordis" {
  interface Context { localappMultiuser: MultiuserRuntime }
}

/** Server-only service. Callers must provide an already authenticated identity. */
export default class MultiuserRuntime extends Service {
  private readonly runtimes: AgentRuntime;
  private stopped = false;
  private closing?: Promise<void>;
  readonly accountServices?: AccountServices;
  readonly systemEnvironment?: SystemEnvironment;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "localappMultiuser");
    this.accountServices = config.accountServices;
    this.systemEnvironment = config.systemEnvironment;
    if(!ctx.get("localappAgentSettings"))new AgentSettings(ctx);
    this.runtimes = ctx.get("localappAgentRuntime") ?? new AgentRuntime(ctx,{capacity:config.capacity});
    ctx.effect(() => () => this.close());
  }

  private readonly guardedApps = new WeakSet<FastifyInstance>();
  createStore(...options: ConstructorParameters<typeof AgentSettingsStore>) {return this.createSettings(...options);}
  createSettings(...options: ConstructorParameters<typeof AgentSettingsStore>) {
    if (this.stopped) throw new Error("Agent runtime service closed");
    return this.ctx.localappAgentSettings.createStore(...options);
  }
  createSecrets(keyFile: string) {
    if (this.stopped) throw new Error("Agent runtime service closed");
    return new SecretBox(keyFile);
  }
  async registerBrowserSessions(app: FastifyInstance, host: BrowserSessionHost): Promise<void> {
    this.guardRoutes(app);
    await registerBrowserSessions(app, host);
  }
  private guardRoutes(app: FastifyInstance): void {
    if (this.stopped) throw new Error("Agent runtime service closed");
    if (this.guardedApps.has(app)) return;
    this.guardedApps.add(app);
    app.addHook("onRequest", async (_request, reply) => {
      if (this.stopped) return reply.status(503).send({ success: false, error: "Agent runtime service closed" });
    });
  }

  registerHttp(app: FastifyInstance, host: { authentication: AuthenticationHost; groups: GroupRoutesHost; profile?: ProfileHost }): void {
    if (this.stopped) throw new Error("Agent runtime service closed");
    app.register(async scope => {
      this.guardRoutes(scope);
      await registerAuthenticationRoutes(scope, { ...host.authentication, logout: async (req, reply) => {
        const userId = host.authentication.visitorId(req);
        await host.authentication.logout(req, reply);
        if (userId && host.authentication.findUserById(userId)) await this.invalidate(userId);
      } });
      await registerGroupRoutes(scope, host.groups);
      if (host.profile) await registerProfileRoutes(scope, { ...host.profile, onCredentialsChanged: async userId => {
        await this.invalidate(userId);
        await host.profile!.onCredentialsChanged?.(userId);
      } });
    });
  }

  registerModelRoutes(app: FastifyInstance, host: {
    authenticate(scope: FastifyInstance): Promise<void>;
    llm: LlmRoutesHost;
    agent(): Promise<AgentRoutesHost>;
    nativeClientRoot?: string;
  }): void {
    if (this.stopped) throw new Error("Agent runtime service closed");
    app.register(async scope => {
      await host.authenticate(scope);
      await this.registerLlm(scope, host.llm);
      scope.register(async agentScope => {
        this.guardRoutes(agentScope);
        const routes = await host.agent();
        agentScope.addHook("preClose", () => this.close());
        await this.registerAgent(agentScope, routes, { nativeClientRoot: host.nativeClientRoot });
      });
    });
  }

  registerPersonalResources(app: FastifyInstance, host: { pages: PersonalPagesHost; dependenciesDirectory: string }): void {
    if (this.stopped) throw new Error("Agent runtime service closed");
    app.register(async scope => this.registerPersonalPages(scope, host.pages));
    app.register(async scope => this.registerDependencies(scope, host.dependenciesDirectory));
  }

  async registerWebAssets(app: FastifyInstance, webRoot: string): Promise<void> {
    if (this.stopped) throw new Error("Agent runtime service closed");
    await app.register(async scope => {
      this.guardRoutes(scope);
      await scope.register(fastifyStatic, { root: path.join(webRoot, "_next"), prefix: "/_next", decorateReply: false });
      await scope.register(fastifyStatic, { root: path.join(webRoot, "home"), prefix: "/home", decorateReply: false });
    });
  }

  async registerDependencies(app: FastifyInstance, directory: string): Promise<void> {
    this.guardRoutes(app);
    await registerDependencyRoutes(app, directory);
  }

  async registerPersonalPages(app: FastifyInstance, host: PersonalPagesHost): Promise<void> {
    this.guardRoutes(app);
    await registerPersonalPages(app, host);
  }

  async registerAgent(app: FastifyInstance, host: AgentRoutesHost, options: { nativeClientRoot?: string } = {}): Promise<void> {
    this.guardRoutes(app);
    await registerAgentRoutes(app, host, options);
  }

  async registerLlm(app: FastifyInstance, host: LlmRoutesHost): Promise<void> {
    this.guardRoutes(app);
    await registerLlmRoutes(app, host);
  }

  registerKeyRoutes(app: FastifyInstance, host: {
    authenticate(scope: FastifyInstance): Promise<void>;
    keys: KeyRoutesHost;
  }): void {
    if (this.stopped) throw new Error("Agent runtime service closed");
    app.register(async scope => {
      await host.authenticate(scope);
      await this.registerKeys(scope, host.keys);
    });
  }

  async registerKeys(app: FastifyInstance, host: KeyRoutesHost): Promise<void> {
    this.guardRoutes(app);
    await registerKeyRoutes(app, host);
  }

  async registerSetup(app: FastifyInstance, host: SetupHost): Promise<void> {
    this.guardRoutes(app);
    await registerSetupRoutes(app, host);
  }

  async registerEnvironment(app: FastifyInstance, host: EnvironmentRoutesHost): Promise<void> {
    this.guardRoutes(app);
    await registerEnvironmentRoutes(app, host);
  }

  async registerAdministratorAccounts(app: FastifyInstance, host: AdministratorAccountsHost): Promise<void> {
    this.guardRoutes(app);
    await registerAdministratorAccounts(app, { ...host, onCredentialsChanged: async userId => {
      await this.invalidate(userId);
      await host.onCredentialsChanged?.(userId);
    } });
  }

  registerAdministrationRoutes(app: FastifyInstance, host: {
    authenticate(scope: FastifyInstance): Promise<void>;
    accounts: AdministratorAccountsHost;
    environment?: EnvironmentRoutesHost;
    contributions?(scope: FastifyInstance): Promise<void>;
  }): void {
    if (this.stopped) throw new Error("Agent runtime service closed");
    app.register(async scope => {
      await host.authenticate(scope);
      await this.registerAdministratorAccounts(scope, host.accounts);
      if (host.environment) scope.register(async environmentScope => this.registerEnvironment(environmentScope, host.environment!));
      await host.contributions?.(scope);
    });
  }

  /** Legacy facade: all execution instances belong to the Agent plugin. */
  async acquire<T extends Runtime>(identity:RuntimeIdentity,fingerprint:string,create:()=>Promise<T>):Promise<T> {
    if(this.stopped) throw new Error("Agent runtime service closed");
    return this.runtimes.acquire(identity,fingerprint,create);
  }
  forUser<T extends Runtime>(userId:string):T[] {return this.runtimes.forUser<T>(userId);}
  invalidate(userId:string,applicationId?:string):Promise<void> {return this.runtimes.invalidate(userId,applicationId);}
  close():Promise<void> {
    this.stopped=true;
    return this.closing ??= (async()=>{
      const results=await Promise.allSettled([this.runtimes.close(),...(!this.ctx.get("localappExecutionEnvironment")&&this.systemEnvironment?[this.systemEnvironment.drain()]:[])]);
      const failures=results.filter((result):result is PromiseRejectedResult=>result.status==="rejected");
      if(failures.length)throw new AggregateError(failures.map(result=>result.reason),"Agent runtime cleanup failed");
    })();
  }
}
