import Fastify, { type FastifyInstance } from "fastify";
import { guardTimerCallback } from "./lib/timer-guard.js";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import * as path from "node:path";
import { storagePlugin } from "./plugins/storage.js";
import { verificationPlugin } from "./plugins/verification.js";
import { closeAllConnections, closeIdleConnections, isCurrentDbQueueOwner, setDatabaseWriteGuard } from "./lib/app-db.js";
import { authPlugin, registerVersionCheck } from "./plugins/auth.js";
import { sessionPlugin } from "./plugins/session.js";
import { keysRoutes } from "./routes/keys.js";
import { uploadRoutes } from "./routes/upload.js";
import { pagesRoutes } from "./routes/pages.js";
import { serveRoutes } from "./routes/serve.js";
import { starterDocRoutes } from "./routes/starter-doc.js";
import { schemasRoutes } from "./routes/schemas.js";
import { authenticatedCliRoutes } from "./routes/cli.js";
import { depsRoutes } from "./routes/deps.js";
import { authRoutes } from "./routes/auth.js";
import { profileRoutes } from "./routes/profile.js";
import { appSettingsRoutes } from "./routes/app-settings.js";
import { groupsRoutes } from "./routes/groups.js";
import { configRoutes } from "./routes/config.js";
import { adminRoutes } from "./routes/admin.js";
import { myServeRoutes } from "./routes/my-serve.js";
import { issuesRoutes } from "./routes/issues.js";
import { favoritesRoutes } from "./routes/favorites.js";
import { subscribeRoutes } from "./routes/subscribe.js";
import { inboxRoutes } from "./routes/inbox.js";
import { wsRoutes } from "./routes/ws.js";
import { agentRoutes } from "./routes/agent.js";
import { llmRoutes } from "./routes/llm.js";
import { platformDataRoutes } from "./routes/platform-data.js";
import { dbRoutes } from "./routes/db.js";
import { desktopActionsRoutes } from "./routes/desktop-actions.js";
import { deviceActionsRoutes } from "./routes/device-actions.js";
import { deviceControlRoutes } from "./routes/device-control.js";
import { verificationRoutes } from "./routes/verification.js";
import { setupRoutes } from "./routes/setup.js";
import { cleanOldLogs, listUsers } from "./lib/meta-sqlite.js";
import { startRequestLogger, stopRequestLogger, pushRequestLog } from "./lib/request-logger.js";
import { initContentStorage } from "./lib/s3-client.js";
import { applyPlatformMigrationsToAllApps } from "./lib/platform-migrations.js";
import { assertAppDataWritable } from "./lib/app-data-maintenance.js";
import { SetupTokenStore } from "./lib/setup-token-store.js";
import { createServerConfigStore, type ServerConfigStore } from "./lib/server-config-store.js";
import { systemRoutes, type RestartController } from "./routes/system.js";
import { ProjectStore } from "./lib/development/projects.js";
import { DevelopmentBuilds } from "./lib/development/builds.js";
import { DevelopmentPreviews } from "./lib/development/previews.js";
import { developmentRoutes } from "./routes/development.js";
import { appsRoutes } from "./routes/apps.js";
import { MAX_APP_PACKAGE_BYTES } from "./lib/app-package.js";
import { WorkspaceStore } from "./lib/workspace-store.js";
import { TaskStore } from "./lib/task-store.js";
import { TaskRunner } from "./lib/task-runner.js";
import { AgentRunner } from "./lib/agent-runner.js";
import { workspacesRoutes } from "./routes/workspaces.js";
import { tasksRoutes } from "./routes/tasks.js";
import { SecretBox } from "./lib/secret-box.js";
import { PeerStore } from "./lib/peer-store.js";
import { peersRoutes } from "./routes/peers.js";
import { peerProtocolRoutes } from "./routes/peer-protocol.js";
import { SyncSessionStore } from "./lib/sync-session-store.js";
import { SyncJobStore } from "./lib/sync-job-store.js";
import { AppSyncTarget } from "./lib/app-sync-target.js";
import { AppSyncSource } from "./lib/app-sync-source.js";
import { reconcileAppInstallTransactions } from "./lib/app-installer.js";
import { syncSourceRoutes, syncTargetRoutes } from "./routes/sync.js";
import { devRoutes, installDevRequestContext } from "./routes/dev.js";
import { DeviceNotificationSourceStore } from "./lib/device-notification-source-store.js";
import { deviceNotificationsRoutes, parseDeviceNotificationJson } from "./routes/device-notifications.js";

export interface BuildServerOptions {
  env?: NodeJS.ProcessEnv;
  webRoot?: string;
  nativeClientRoot?: string;
  setupTokens?: SetupTokenStore;
  restartController?: RestartController;
  configStore?: ServerConfigStore;
  enableDevTools?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? process.env;
  const configStore = options.configStore ?? createServerConfigStore({ env });
  const config = await configStore.read();
  const app = Fastify({ ignoreTrailingSlash: true });
  app.decorate("config", config);
  await registerServerPluginsAndRoutes(app, {
    webRoot: options.webRoot,
    nativeClientRoot: options.nativeClientRoot ?? env.LOCALAPP_NATIVE_CLIENT_ROOT ?? path.resolve(__dirname, "../../../tmp/native-client-entry"),
    setupTokens: options.setupTokens ?? new SetupTokenStore(),
    configStore,
    restartController: options.restartController ?? { requestRestart: (exitCode) => process.exit(exitCode) },
    enableDevTools: options.enableDevTools ?? env.LOCALAPP_DEV_TOOLS === "1",
  });
  return app;
}

async function registerServerPluginsAndRoutes(
  app: FastifyInstance,
  options: {
    webRoot?: string;
    nativeClientRoot?: string;
    setupTokens: SetupTokenStore;
    configStore: ServerConfigStore;
    restartController: RestartController;
    enableDevTools: boolean;
  },
): Promise<void> {
  const { default: websocket } = await import("@fastify/websocket");
  await app.register(websocket);
  await app.register(storagePlugin);
  await reconcileAppInstallTransactions(app.config.dataDir);
  setDatabaseWriteGuard((dbPath) => assertAppDataWritable(path.dirname(dbPath), isCurrentDbQueueOwner(dbPath)));
  await initContentStorage(app.config);
  await app.register(verificationPlugin);
  if (listUsers(1, 1).total > 0) {
    await applyPlatformMigrationsToAllApps({ dataDir: app.config.dataDir, logger: console });
  }

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_APP_PACKAGE_BYTES } });
  await app.register(sessionPlugin);
  if (options.enableDevTools) await installDevRequestContext(app);
  const developmentProjects = new ProjectStore(app.config.dataDir);
  const developmentBuilds = new DevelopmentBuilds(app.config.dataDir, developmentProjects);
  const developmentPreviews = new DevelopmentPreviews(app.config.dataDir, developmentProjects, developmentBuilds);
  developmentPreviews.attach(app);
  app.addHook("onClose", async () => developmentBuilds.close());
  const workspaceStore = new WorkspaceStore({
    workspaceDir: app.config.workspaceDir,
    archiveLimits: {
      maxCompressedBytes: app.config.appDataArchiveMaxBytes,
      maxExpandedBytes: app.config.appDataExpandedMaxBytes,
      maxFileEntries: app.config.appDataArchiveMaxFiles,
    },
  });
  const taskStore = new TaskStore();
  const taskRunner = new TaskRunner({
    workspaceStore,
    taskStore,
    taskDir: path.join(app.config.dataDir, "tasks"),
  });
  const agentRunner = new AgentRunner({ taskRunner });
  const secretBox = new SecretBox(app.config.masterKeyFile);
  const peerStore = new PeerStore(secretBox);
  const deviceNotificationSourceStore = new DeviceNotificationSourceStore(secretBox);
  const syncSessions = new SyncSessionStore({ dataDir: app.config.dataDir });
  syncSessions.prune();
  const syncJobs = new SyncJobStore();
  syncJobs.reconcileInterrupted();
  const syncTarget = new AppSyncTarget(app.config.dataDir, syncSessions);
  await syncTarget.reconcileInterrupted();
  const syncSource = new AppSyncSource(app.config.dataDir, syncJobs, peerStore);
  await taskRunner.reconcileRunning();
  workspaceStore.setTaskRunner(taskRunner);
  app.addHook("onClose", async () => {
    await syncSource.shutdown();
    await Promise.all([taskRunner.shutdown(), workspaceStore.shutdown()]);
  });
  app.register(verificationRoutes);
  await setupRoutes(app, options.setupTokens);
  await systemRoutes(app, { configStore: options.configStore, restartController: options.restartController });
  await peerProtocolRoutes(app);
  await syncTargetRoutes(app, syncTarget);
  app.get("/health", async () => ({ status: "ok" }));
  starterDocRoutes(app);

  const webRoot = options.webRoot ?? path.resolve(__dirname, "../../web/out");
  await app.register(fastifyStatic, { root: path.join(webRoot, "_next"), prefix: "/_next", decorateReply: false });
  await app.register(fastifyStatic, { root: path.join(webRoot, "home"), prefix: "/home", decorateReply: false });

  app.register(authRoutes);
  app.register(profileRoutes);
  app.register(appSettingsRoutes);
  app.register(groupsRoutes);
  app.register(platformDataRoutes);
  app.register(async (llmScope) => {
    await authPlugin(llmScope);
    llmScope.register(llmRoutes);
    llmScope.register(agentRoutes, { nativeClientRoot: options.nativeClientRoot });
  });
  app.register(issuesRoutes);
  app.register(favoritesRoutes);
  app.register(subscribeRoutes);
  app.register(inboxRoutes);
  app.register(wsRoutes);
  app.register(desktopActionsRoutes);
  app.register(deviceActionsRoutes);
  app.register(deviceControlRoutes);
  app.register(async (notificationScope) => {
    notificationScope.removeContentTypeParser("application/json");
    notificationScope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
      try {
        done(null, parseDeviceNotificationJson(String(body)));
      } catch {
        done(null, { __invalidJson: true });
      }
    });
    await deviceNotificationsRoutes(notificationScope, deviceNotificationSourceStore);
  });
  app.register(myServeRoutes, { webRoot });
  app.register(async (peerScope) => peersRoutes(peerScope, peerStore));
  app.register(serveRoutes, { webRoot });
  app.register(authenticatedCliRoutes);
  app.register(depsRoutes);
  app.register(async (authScope) => {
    await authPlugin(authScope);
    registerVersionCheck(authScope);
    authScope.register(keysRoutes);
    authScope.register(configRoutes);
    authScope.register(uploadRoutes);
    authScope.register(appsRoutes);
    authScope.register(developmentRoutes, { projects: developmentProjects, builds: developmentBuilds, previews: developmentPreviews });
    authScope.register(dbRoutes);
    authScope.register(pagesRoutes);
    authScope.register(schemasRoutes);
    authScope.register(async (workspaceScope) => workspacesRoutes(workspaceScope, workspaceStore));
    authScope.register(async (taskScope) => tasksRoutes(taskScope, { taskStore, taskRunner, agentRunner }));
    authScope.register(async (syncScope) => syncSourceRoutes(syncScope, syncSource));
    if (options.enableDevTools) authScope.register(devRoutes);
  });
  app.register(adminRoutes);

  app.addHook("onResponse", async (req, reply) => {
    const url = req.routeOptions?.url ?? req.url;
    if (url.startsWith("/api/") || url.includes("/api/")) {
      pushRequestLog({
        path: req.url.split("?")[0],
        method: req.method,
        status: reply.statusCode,
        durationMs: reply.elapsedTime ? Math.round(reply.elapsedTime) : 0,
        userId: req.userId || null,
        visitorId: req.visitorId || null,
      }, app.config.dataDir);
    }
  });

  const idleConnectionTimer = setInterval(guardTimerCallback("idle database close", closeIdleConnections), 60_000);
  idleConnectionTimer.unref();
  app.addHook("onListen", async () => {
    startRequestLogger();
    cleanOldLogs();
  });
  app.addHook("onClose", async () => {
    clearInterval(idleConnectionTimer);
    stopRequestLogger();
    closeAllConnections();
  });
}
