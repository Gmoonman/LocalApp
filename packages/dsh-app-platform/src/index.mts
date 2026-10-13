import { guardTimerCallback } from "./timer-guard.cjs";
import { initializePlatformSchema } from "./platform-schema.cjs";
import { createSavedRepliesStore } from "./saved-replies-store.cjs";
import { registerApplicationEntry } from "./application-entry-routes.cjs";
import { applyPlatformMigrationsToAllApps } from "./platform-migrations.cjs";
import { registerVerification } from "./verification-routes.cjs";
import { VerificationSessionStore } from "./verification-sessions.cjs";
import { registerDeviceNotifications, parseDeviceNotificationJson } from "./device-notifications-routes.cjs";
import { DeviceNotificationSourceStore } from "./device-notification-source-store.cjs";
import { registerWebSocket as registerWebSocketHandler, type WebSocketRoutesHost } from "./ws-routes.cjs";
import { createDesktopActionRoutes } from "./desktop-actions-routes.cjs";
import { createDeviceActionRoutes } from "./device-actions-routes.cjs";
import { registerDeviceControl } from "./device-control-routes.cjs";
import { createDeviceActionStore } from "./desktop-actions-db.cjs";
import { registerIssues } from "./issues-routes.cjs";
import { registerPlatformData } from "./platform-data-routes.cjs";
import { registerPeerProtocol } from "./peer-protocol-routes.cjs";
import { registerPeers } from "./peers-routes.cjs";
import { PeerStore, type PeerSecrets } from "./peer-store.cjs";
import type { PeerPersistence } from "./peer-records.cjs";
import { AppSyncSource, type SyncPeers } from "./app-sync-source.cjs";
import { registerSyncSource } from "./sync-source-routes.cjs";
import { registerSyncTarget } from "./sync-target-routes.cjs";
import { AppSyncTarget } from "./app-sync-target.cjs";
import { SyncJobStore, type SyncJobPersistence } from "./sync-job-store.cjs";
import { SyncSessionStore } from "./sync-session-store.cjs";
import { registerAdministratorApplications } from "./admin-applications-routes.cjs";
import { createUserApplicationManagement } from "./user-applications.cjs";
import type { AnalyticsStore } from "./analytics.cjs";
import type { RequestLogger } from "./request-logger.cjs";
import type { NotificationServices } from "./notification-services.cjs";
import { registerApplicationInbox } from "./inbox-routes.cjs";
import { registerApplicationSubscriptions } from "./subscription-routes.cjs";
import { registerApplicationFavorites } from "./favorites-routes.cjs";
import { registerApplicationDataSettings } from "./data-settings-routes.cjs";
import { registerApplicationSettings } from "./settings-routes.cjs";
import { registerApplicationSchemas, type ApplicationSchemaHost } from "./schemas-routes.cjs";
import { registerApplicationDatabase, type ApplicationDatabaseHost } from "./db-routes.cjs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {} from "@localapp/dsh-agent-ui";
import { Context, Service } from "@deepseek-ai/cordis";
import { registerOwnApplicationPages } from "./own-pages-routes.cjs";
import { AGENT_CAPABILITIES, type AgentCapability } from "@localapp/dsh-agent-settings/settings";
import * as database from "./app-db.cjs";
import * as backend from "./backend-contract.cjs";
import * as appRuntime from "./app-runtime.cjs";
import * as recordAccess from "./record-access.cjs";
import * as issueTemplates from "./issue-templates.cjs";
import * as issueSavedViews from "./issue-saved-views.cjs";
import * as issueSavedReplies from "./issue-saved-replies.cjs";
import { createApplicationCollaboration } from "./collaboration-handler.cjs";
import { createApplicationCrdt } from "./crdt-handler.cjs";
import * as crdt from "./crdt-store.cjs";
import * as contentStorage from "./content-storage.cjs";
import * as contentHandler from "./content-handler.cjs";
import * as notifications from "./notify-handler.cjs";
import * as dataHandler from "./data-handler.cjs";
import * as installer from "./app-installer.cjs";
import * as maintenance from "./app-data-maintenance.cjs";
import { registerApplicationResources } from "./resource-routes.cjs";
import { registerApplicationShell } from "./shell-routes.cjs";
import { registerApplicationInstall, type ApplicationInstallHost } from "./install-routes.cjs";
import { registerApplicationUpload, type ApplicationUploadHost } from "./upload-routes.cjs";
import { registerApplicationPages, type ApplicationPagesHost } from "./pages-routes.cjs";
import * as pages from "./page-storage.cjs";
import * as appPackages from "./app-package.cjs";
import * as versionMigrations from "./app-version-migrations.cjs";
import * as lifecycle from "./app-lifecycle.cjs";
import * as manifests from "./app-manifest.cjs";
import path from "node:path";

export interface ApplicationRecord {
  ownerId: string;
  offline: boolean;
  access: unknown;
  capabilities: unknown;
}

/** Persistence and group membership are supplied by the unified Server. */
export interface ApplicationStore {
  requestLogger?: RequestLogger;
  analytics?: AnalyticsStore;
  notificationServices?: NotificationServices;
  owner(nameOrId: string): { id: string; name: string } | undefined;
  application(ownerId: string, name: string): ApplicationRecord | undefined;
  canAccess(access: unknown, userId: string, ownerId: string): boolean;
}

export class ApplicationPlatform extends Service {
  registerDatabaseMaintenance(app: FastifyInstance, dataDirectory?: string) {
    this.assertActive();
    const timer = setInterval(guardTimerCallback("idle database close", database.closeIdleConnections), 60_000);
    timer.unref();
    this.ctx.effect(() => async () => {
      clearInterval(timer);
      if (dataDirectory) await database.closeConnectionsUnderDirectory(dataDirectory);
    });
    app.addHook("onClose", async () => {
      clearInterval(timer);
      if (dataDirectory) await database.closeConnectionsUnderDirectory(dataDirectory);
      else database.closeAllConnections();
    });
  }
  async initializeStorage(host: {
    config: contentStorage.ContentStorageConfig;
    migrationsDir: string;
    hasAccounts(): boolean;
    logger?: Pick<Console, "warn">;
  }) {
    this.assertActive();
    await installer.reconcileAppInstallTransactions(host.config.dataDir);
    this.assertActive();
    database.setDatabaseWriteGuard(dbPath => maintenance.assertAppDataWritable(
      path.dirname(dbPath), database.isCurrentDbQueueOwner(dbPath)));
    await contentStorage.initContentStorage(host.config);
    this.assertActive();
    if (host.hasAccounts()) await applyPlatformMigrationsToAllApps({
      dataDir: host.config.dataDir, migrationsDir: host.migrationsDir, logger: host.logger,
    });
    this.assertActive();
  }
  registerRequestLogging(app: FastifyInstance, host: {
    scope: string;
    identity(request: FastifyRequest): { userId: string | null; visitorId: string | null };
  }) {
    this.assertActive();
    app.addHook("onResponse", async (request, reply) => {
      if (!this.active) return;
      const url = request.routeOptions?.url ?? request.url;
      if (!url.startsWith("/api/") && !url.includes("/api/")) return;
      this.store.requestLogger?.pushRequestLog({
        path: request.url.split("?")[0], method: request.method,
        status: reply.statusCode,
        durationMs: reply.elapsedTime ? Math.round(reply.elapsedTime) : 0,
        ...host.identity(request),
      }, host.scope);
    });
    app.addHook("onListen", async () => {
      if (!this.active) return;
      this.store.requestLogger?.startRequestLogger();
      this.store.analytics?.cleanOldLogs();
    });
  }
  registerSynchronizationRoutes(app: FastifyInstance, host: {
    protocol: Parameters<typeof registerPeerProtocol>[1];
    target: AppSyncTarget;
    authenticateTarget: Parameters<typeof registerSyncTarget>[2];
    source: AppSyncSource;
    userId: Parameters<typeof registerSyncSource>[2];
    authenticateUser: (scope: FastifyInstance) => Promise<void>;
    peers: PeerStore;
    authenticateAdministrator: Parameters<typeof registerPeers>[2];
  }) {
    this.assertActive();
    app.register(async scope => this.registerPeerProtocol(scope, host.protocol));
    app.register(async scope => this.registerSyncTarget(scope, host.target, host.authenticateTarget));
    app.register(async scope => this.registerPeers(scope, host.peers, host.authenticateAdministrator));
    app.register(async scope => {
      await host.authenticateUser(scope);
      await this.registerSyncSource(scope, host.source, host.userId);
    });
  }
  async initializeSynchronization(host: {
    dataDir: string; secrets: PeerSecrets; persistence: PeerPersistence;
  }) {
    this.assertActive();
    const peerStore = this.peers(host.secrets, host.persistence);
    const sessions = this.syncSessions({ dataDir: host.dataDir });
    sessions.prune();
    const jobs = this.syncJobs(host.persistence);
    jobs.reconcileInterrupted();
    const syncTarget = this.syncTarget(host.dataDir, sessions);
    await syncTarget.reconcileInterrupted();
    this.assertActive();
    const syncSource = this.syncSource(host.dataDir, jobs, peerStore);
    return { peerStore, syncTarget, syncSource };
  }
  registerDeviceRoutes(app: FastifyInstance, host: {
    desktop: ReturnType<typeof createDesktopActionRoutes>;
    device: ReturnType<typeof createDeviceActionRoutes>;
    control: Parameters<typeof registerDeviceControl>[1];
  }) {
    this.assertActive();
    app.register(async scope => host.desktop.register(scope));
    app.register(async scope => host.device.register(scope));
    app.register(async scope => this.registerDeviceControl(scope, host.control));
  }
  registerNotificationRoutes(app: FastifyInstance, store: DeviceNotificationSourceStore,
    host: Parameters<typeof registerDeviceNotifications>[2]) {
    this.assertActive();
    app.register(async scope => {
      scope.removeContentTypeParser("application/json");
      scope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
        try { done(null, parseDeviceNotificationJson(String(body))); }
        catch { done(null, { __invalidJson: true }); }
      });
      await this.registerDeviceNotifications(scope, store, host);
    });
  }
  registerApplicationInteractionRoutes(app: FastifyInstance, host: {
    issues: Parameters<typeof registerIssues>[1];
    favorites: Parameters<typeof registerApplicationFavorites>[1];
    subscriptions?: Parameters<typeof registerApplicationSubscriptions>[1];
    inbox?: Parameters<typeof registerApplicationInbox>[1];
    websocket: WebSocketRoutesHost;
  }) {
    this.assertActive();
    app.register(async scope => this.registerIssues(scope, host.issues));
    app.register(async scope => this.registerFavorites(scope, host.favorites));
    if(host.subscriptions) app.register(async scope => this.registerSubscriptions(scope, host.subscriptions!));
    if(host.inbox) app.register(async scope => this.registerInbox(scope, host.inbox!));
    app.register(async scope => this.registerWebSocket(scope, host.websocket));
  }
  registerApplicationDataRoutes(app:FastifyInstance,host:{
    ownPages:Parameters<typeof registerOwnApplicationPages>[1];
    settings:Parameters<typeof registerApplicationSettings>[1];
    dataSettings:Parameters<typeof registerApplicationDataSettings>[1];
    data:Parameters<typeof registerPlatformData>[1];
  }){
    this.assertActive();
    app.register(async scope=>this.registerOwnPages(scope,host.ownPages));
    app.register(async scope=>this.registerSettings(scope,host.settings));
    app.register(async scope=>this.registerDataSettings(scope,host.dataSettings));
    app.register(async scope=>this.registerPlatformData(scope,host.data));
  }
  readonly initializeSchema = initializePlatformSchema;
  readonly savedReplies = createSavedRepliesStore;
  registerApplicationServing(app: FastifyInstance, host: {
    entry: Parameters<typeof registerApplicationEntry>[1];
    verification: Parameters<typeof registerVerification>[1];
  }): void {
    this.assertActive();
    app.register(async scope => this.registerVerification(scope, host.verification));
    app.register(async scope => this.registerApplicationEntry(scope, host.entry));
  }
  registerApplicationEntry(app: FastifyInstance, host: Parameters<typeof registerApplicationEntry>[1]) {
    return this.route(registerApplicationEntry)(app, { ...host, onStop: cleanup => { this.ctx.effect(() => cleanup); } });
  }
  readonly applyPlatformMigrationsToAllApps = applyPlatformMigrationsToAllApps;
  readonly registerVerification = this.route(registerVerification);
  readonly VerificationSessionStore = VerificationSessionStore;
  readonly registerDeviceNotifications = this.route(registerDeviceNotifications);
  readonly DeviceNotificationSourceStore = DeviceNotificationSourceStore;
  createDeviceNotificationSources(...options: ConstructorParameters<typeof DeviceNotificationSourceStore>) {
    this.assertActive();
    return new DeviceNotificationSourceStore(...options);
  }
  private active = true;
  private assertActive(): void {
    if (!this.active) throw new Error("Application platform plugin is stopped");
  }
  private route<Args extends unknown[], Result>(register: (app: FastifyInstance, ...args: Args) => Result) {
    return (app: FastifyInstance, ...args: Args): Result => {
      this.assertActive();
      app.addHook("onRequest", async (_request, reply) => {
        if (!this.active) return reply.status(503).send({ success: false, error: "Application platform plugin is stopped" });
      });
      return register(app, ...args);
    };
  }
  async registerWebSocket(app: FastifyInstance, host: WebSocketRoutesHost): Promise<void> {
    this.assertActive();
    app.addHook("onRequest", async (_request, reply) => {
      if (!this.active) return reply.status(503).send({ success: false, error: "Application platform plugin is stopped" });
    });
    this.ctx.effect(() => () => host.connections.closeAll());
    await registerWebSocketHandler(app, host);
  }
  verification(dataDir: string): VerificationSessionStore {
    this.assertActive();
    const store = new VerificationSessionStore(dataDir);
    store.initialize();
    const timer = setInterval(guardTimerCallback("verification session cleanup", () => store.cleanupExpired()), 30_000);
    timer.unref();
    this.ctx.effect(() => () => clearInterval(timer));
    return store;
  }
  createDesktopActionRoutes(host: Parameters<typeof createDesktopActionRoutes>[0]) {
    this.assertActive();
    return createDesktopActionRoutes({ ...host, isActive: () => this.active, onStop: cleanup => { this.ctx.effect(() => cleanup); } });
  }
  createDeviceActionRoutes(host: Parameters<typeof createDeviceActionRoutes>[0]) {
    this.assertActive();
    return createDeviceActionRoutes({ ...host, isActive: () => this.active, onStop: cleanup => { this.ctx.effect(() => cleanup); } });
  }
  readonly deviceActions = createDeviceActionStore;
  readonly registerDeviceControl = this.route(registerDeviceControl);
  readonly registerIssues = this.route(registerIssues);
  readonly registerPlatformData = this.route(registerPlatformData);
  readonly registerPeerProtocol = this.route(registerPeerProtocol);
  readonly registerPeers = this.route(registerPeers);
  peers(secrets: PeerSecrets, persistence: PeerPersistence) {
    this.assertActive();
    return new PeerStore(secrets, persistence);
  }
  readonly registerSyncSource = this.route(registerSyncSource);
  syncSource(dataDir: string, jobs: SyncJobStore, peers: SyncPeers) {
    this.assertActive();
    const source = new AppSyncSource(dataDir, jobs, peers);
    this.ctx.effect(() => () => source.shutdown());
    return source;
  }
  readonly registerSyncTarget = this.route(registerSyncTarget);
  syncTarget(dataDir: string, sessions: SyncSessionStore) {
    this.assertActive();
    const target = new AppSyncTarget(dataDir, sessions);
    this.ctx.effect(() => () => target.shutdown());
    return target;
  }
  syncJobs(persistence: SyncJobPersistence) {
    this.assertActive();
    return new SyncJobStore(persistence);
  }
  syncSessions(options: ConstructorParameters<typeof SyncSessionStore>[0]) {
    this.assertActive();
    return new SyncSessionStore(options);
  }
  readonly createUserApplicationManagement = createUserApplicationManagement;
  get requestLogger(): RequestLogger | undefined { return this.store.requestLogger; }
  get analytics(): AnalyticsStore | undefined { return this.store.analytics; }
  get notificationServices(): NotificationServices | undefined { return this.store.notificationServices; }
  readonly database = database;
  readonly backend = backend;
  readonly appRuntime = appRuntime;
  readonly recordAccess = recordAccess;
  readonly issues = { templates: issueTemplates, savedViews: issueSavedViews, savedReplies: issueSavedReplies };
  readonly dataHandler = dataHandler;
  readonly notifications = notifications;
  readonly content = { storage: contentStorage, handler: contentHandler };
  readonly crdt = crdt;
  createCrdt(host: Parameters<typeof createApplicationCrdt>[0]) {
    this.assertActive();
    const handlers = createApplicationCrdt(host);
    this.ctx.effect(() => () => handlers.dispose());
    return handlers;
  }
  createCollaboration(host: Parameters<typeof createApplicationCollaboration>[0]) {
    this.assertActive();
    const handlers = createApplicationCollaboration(host);
    this.ctx.effect(() => () => handlers.dispose());
    return handlers;
  }
  readonly installer = installer;
  readonly maintenance = maintenance;
  readonly registerPages = this.route(registerApplicationPages);
  readonly registerOwnPages = this.route(registerOwnApplicationPages);
  readonly registerSettings = this.route(registerApplicationSettings);
  readonly registerDataSettings = this.route(registerApplicationDataSettings);
  readonly registerFavorites = this.route(registerApplicationFavorites);
  readonly registerSubscriptions = this.route(registerApplicationSubscriptions);
  readonly registerAdministratorApplications = this.route(registerAdministratorApplications);
  readonly registerInbox = this.route(registerApplicationInbox);
  readonly registerUpload = this.route(registerApplicationUpload);
  readonly registerInstall = this.route(registerApplicationInstall);
  readonly registerShell = this.route(registerApplicationShell);
  readonly registerResources = this.route(registerApplicationResources);
  readonly pages = pages;
  readonly manifests = manifests;
  readonly packages = appPackages;
  readonly versionMigrations = versionMigrations;
  readonly lifecycle = lifecycle;
  constructor(ctx: Context, private readonly store: ApplicationStore) {
    super(ctx, "localappApps");
    const agentUI=ctx.get("localappAgentUI");
    if(agentUI) ctx.effect(()=>agentUI.registerIdentity({id:"user",label:"用户"}));
    ctx.effect(() => () => { this.active = false; });
    ctx.effect(() => () => this.store.requestLogger?.stopRequestLogger());
  }

  registerPackageManagement(app: FastifyInstance, host: {
    authenticate(scope: FastifyInstance): Promise<void>;
    routes: Parameters<ApplicationPlatform["registerPackageRoutes"]>[1];
  }): void {
    this.assertActive();
    app.register(async scope => {
      await host.authenticate(scope);
      await this.registerPackageRoutes(scope, host.routes);
    });
  }

  async registerPackageRoutes(app: FastifyInstance, host: {
    pages: ApplicationPagesHost; upload: ApplicationUploadHost; install: ApplicationInstallHost;
    schemas?: ApplicationSchemaHost; database?: ApplicationDatabaseHost;
  }): Promise<void> {
    this.assertActive();
    await this.registerPages(app, host.pages);
    await this.registerUpload(app, host.upload);
    await this.registerInstall(app, host.install);
    if (host.schemas) await registerApplicationSchemas(app, host.schemas);
    if (host.database) await registerApplicationDatabase(app, host.database);
  }

  resolveAgentApp(userId: string, appId?: string): { id: string; capabilities: AgentCapability[] } {
    this.assertActive();
    if (!appId || appId === "platform") return { id: "platform", capabilities: [] };
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(appId)) throw new Error("Invalid application identity");
    const [ownerName, name] = appId.split("/");
    const owner = this.store.owner(ownerName);
    const record = owner && this.store.application(owner.id, name);
    if (!owner || !record || record.offline || !this.store.canAccess(record.access, userId, record.ownerId)) throw new Error("Application is unavailable");
    const capabilities = record.capabilities;
    if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.some(value => !AGENT_CAPABILITIES.includes(value)))) throw new Error("Invalid application Agent capabilities");
    return { id: `${owner.name}/${name}`, capabilities: [...(capabilities ?? [])] as AgentCapability[] };
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context { localappApps: ApplicationPlatform; }
}

export default ApplicationPlatform;
