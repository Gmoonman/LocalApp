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

export interface RuntimeIdentity {
  userId: string;
  applicationId: string;
  role: "user" | "developer";
  providerId: string;
}
export interface Runtime { close(): Promise<void> }
interface Entry {
  identity: RuntimeIdentity;
  fingerprint: string;
  ready: Promise<Runtime>;
  value?: Runtime;
  invalidated: boolean;
  disposal?: Promise<void>;
}
export interface Config { capacity?: number; accountServices?: AccountServices; systemEnvironment?: SystemEnvironment }
declare module "@deepseek-ai/cordis" {
  interface Context { localappMultiuser: MultiuserRuntime }
}

/** Server-only service. Callers must provide an already authenticated identity. */
export default class MultiuserRuntime extends Service {
  private readonly entries = new Map<string, Entry>();
  private readonly capacity: number;
  private stopped = false;
  private closing?: Promise<void>;
  readonly accountServices?: AccountServices;
  readonly systemEnvironment?: SystemEnvironment;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "localappMultiuser");
    this.accountServices = config.accountServices;
    this.systemEnvironment = config.systemEnvironment;
    this.capacity = config.capacity ?? 100;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) throw new Error("Invalid Agent capacity");
    ctx.effect(() => () => this.close());
  }

  private readonly guardedApps = new WeakSet<FastifyInstance>();
  createSettings(...options: ConstructorParameters<typeof AgentSettingsStore>) {
    if (this.stopped) throw new Error("Agent runtime service closed");
    return new AgentSettingsStore(...options);
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

  private key(identity: RuntimeIdentity) {
    return JSON.stringify([identity.userId, identity.applicationId, identity.role, identity.providerId]);
  }

  async acquire<T extends Runtime>(identity: RuntimeIdentity, fingerprint: string, create: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error("Agent runtime service closed");
    if (Object.values(identity).some(value => typeof value !== "string" || !value)) throw new Error("Invalid runtime identity");
    const key = this.key(identity);
    const current = this.entries.get(key);
    if (current) {
      if (current.invalidated || current.fingerprint !== fingerprint) {
        await this.release(key, current);
        return this.acquire(identity, fingerprint, create);
      }
      const value = await current.ready;
      if (current.invalidated) { await this.release(key, current); throw new Error("Agent runtime invalidated"); }
      return value as T;
    }
    if (this.entries.size >= this.capacity) throw new Error("Agent capacity reached");
    const entry: Entry = {
      identity: { ...identity }, fingerprint, invalidated: false,
      ready: Promise.resolve().then(create),
    };
    this.entries.set(key, entry);
    try {
      const value = await entry.ready;
      entry.value = value;
      if (entry.invalidated) { await this.release(key, entry); throw new Error("Agent runtime invalidated"); }
      return value as T;
    } catch (error) {
      if (!entry.invalidated && this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  forUser<T extends Runtime>(userId: string): T[] {
    return [...this.entries.values()].filter(entry => entry.identity.userId === userId && !entry.invalidated && entry.value)
      .map(entry => entry.value as T);
  }

  private release(key: string, entry: Entry): Promise<void> {
    entry.invalidated = true;
    return entry.disposal ??= (async () => {
      try {
        // Failed initialization has no usable runtime; its factory owns cleanup.
        const value = await entry.ready.catch(() => undefined);
        if (value) await value.close();
      } finally {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }
    })();
  }

  async invalidate(userId: string, applicationId?: string): Promise<void> {
    const results = await Promise.allSettled([...this.entries].filter(([, entry]) =>
      entry.identity.userId === userId && (applicationId === undefined || entry.identity.applicationId === applicationId))
      .map(([key, entry]) => this.release(key, entry)));
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "Agent runtime cleanup failed");
  }

  close(): Promise<void> {
    this.stopped = true;
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([
        ...[...this.entries].map(([key, entry]) => this.release(key, entry)),
        ...(this.systemEnvironment ? [this.systemEnvironment.drain()] : []),
      ]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Agent runtime cleanup failed");
    })();
  }
}
