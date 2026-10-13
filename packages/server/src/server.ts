import { systemEnvironment } from "./lib/system-agent-environment.js";
import { accountServices } from "./lib/meta-sqlite.js";
import { applicationStore } from "./lib/agent-app.js";
import { developmentClientResources } from "./lib/native-client-resources.js";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import * as path from "node:path";
import { storagePlugin } from "./plugins/storage.js";
import { verificationPlugin } from "./plugins/verification.js";
import { authPlugin, registerVersionCheck } from "./plugins/auth.js";
import { createBrowserSessionHost } from "./plugins/session.js";
import { createKeyRoutesHost } from "./routes/keys.js";
import { createApplicationUploadHost } from "./routes/upload.js";
import { createApplicationPagesHost } from "./routes/pages.js";
import { createApplicationEntryHost } from "./routes/serve.js";
import { createApplicationSchemaHost } from "./routes/schemas.js";
import { createAuthenticationHost } from "./routes/auth.js";
import { createOwnApplicationPagesHost, createProfileHost } from "./routes/profile.js";
import { createApplicationDataSettingsHost, createApplicationSettingsHost } from "./routes/app-settings.js";
import { createGroupRoutesHost } from "./routes/groups.js";
import { createAdministratorApplicationsHost, createAdministratorAccountsHost } from "./routes/admin.js";
import { adminAuth } from "./plugins/auth.js";
import { createPersonalPagesHost } from "./routes/my-serve.js";
import { createIssueRoutesHost } from "./routes/issues.js";
import { createApplicationFavoritesHost } from "./routes/favorites.js";
import { createSubscriptionRoutesHost } from "./routes/subscribe.js";
import { createApplicationInboxHost } from "./routes/inbox.js";
import { createWebSocketHost } from "./routes/ws.js";
import { createAgentRoutesHost } from "./routes/agent.js";
import { createLlmRoutesHost } from "./routes/llm.js";
import { createPlatformDataHost } from "./routes/platform-data.js";
import { createApplicationDatabaseHost } from "./routes/db.js";
import { desktopActionContribution } from "./routes/desktop-actions.js";
import { deviceActionContribution } from "./routes/device-actions.js";
import { createDeviceControlHost } from "./routes/device-control.js";
import { createVerificationHost } from "./routes/verification.js";
import { createSetupHost } from "./routes/setup.js";
import { listUsers, getDb, flushMetaDb, findUserById, validateApiKey } from "./lib/meta-sqlite.js";
import { SetupTokenStore } from "./lib/setup-token-store.js";
import { createServerConfigStore, type ServerConfigStore } from "./lib/server-config-store.js";
import { systemRoutes, type RestartController } from "./routes/system.js";
import { createBuildOperations } from "./lib/development/builds.js";
import { previewHost } from "./lib/development/previews.js";
import { createDevelopmentRoutesHost } from "./routes/development.js";
import { createApplicationInstallHost } from "./routes/apps.js";
import { MAX_APP_PACKAGE_BYTES } from "./lib/app-package.js";
import { createWorkspaceRoutesHost } from "./routes/workspaces.js";
import { createTaskRoutesHost } from "./routes/tasks.js";
import { createSyncTargetAuthentication } from "./routes/sync.js";
import { devToolkitContribution, installDevRequestContext } from "./routes/dev.js";
import { createDeviceNotificationPersistence } from "./lib/device-notification-source-store.js";
import { createDeviceNotificationRoutesHost } from "./routes/device-notifications.js";
import type { Context as DshContext } from "@deepseek-ai/cordis" with { "resolution-mode": "import" };

export interface BuildServerOptions {
  env?: NodeJS.ProcessEnv;
  webRoot?: string;
  nativeClientRoot?: string;
  setupTokens?: SetupTokenStore;
  restartController?: RestartController;
  configStore?: ServerConfigStore;
  enableDevTools?: boolean;
  pluginCombination?: "multiuser" | "platform" | "full";
  agentUI?: boolean;
  synchronization?:boolean;
  collaboration?:boolean;
  deviceServices?:boolean;
  documents?: false | { root?: string };
}

async function authenticateCliRequest(app: FastifyInstance): Promise<void> {
  await authPlugin(app);
  registerVersionCheck(app);
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? process.env;
  const configStore = options.configStore ?? createServerConfigStore({ env });
  const config = await configStore.read();
  const { Context } = await import("@deepseek-ai/cordis");
  const { default: EmbeddedWebServer } = await import("@localapp/dsh-agent-runtime/native-server");
  const context = new Context();
  await context.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
  const carrier = context.webServer as InstanceType<typeof EmbeddedWebServer>;
  const app = Fastify({ ignoreTrailingSlash: true, maxParamLength: 1024,
    serverFactory: handler => carrier.createListener(handler),
  });
  app.decorate("config", config);
  try {
  await registerServerPluginsAndRoutes(app, {
    context,
    pluginCombination: options.pluginCombination ?? config.pluginCombination ?? "full",
    pluginCombinationControlled: options.pluginCombination !== undefined || Boolean(env.LOCALAPP_PLUGIN_COMBINATION),
    documents: options.documents ?? (config.documentsEnabled === false ? false : undefined),
    documentsControlled: options.documents !== undefined,
    agentUI: options.agentUI ?? env.LOCALAPP_AGENT_UI !== "0",
    synchronization:options.synchronization??env.LOCALAPP_APP_SYNC!=="0",
    collaboration:options.collaboration??env.LOCALAPP_COLLABORATION!=="0",
    deviceServices:options.deviceServices??env.LOCALAPP_DEVICE_SERVICES!=="0",
    webRoot: options.webRoot,
    nativeClientRoot: options.nativeClientRoot ?? env.LOCALAPP_NATIVE_CLIENT_ROOT ?? path.resolve(__dirname, "../../../tmp/native-client-entry"),
    setupTokens: options.setupTokens ?? new SetupTokenStore(),
    configStore,
    restartController: options.restartController ?? { requestRestart: (exitCode) => process.exit(exitCode) },
    enableDevTools: options.enableDevTools ?? env.LOCALAPP_DEV_TOOLS === "1",
  });
  return app;
  } catch (error) {
    await app.close();
    await context.fiber.dispose();
    throw error;
  }
}

async function registerServerPluginsAndRoutes(
  app: FastifyInstance,
  options: {
    context: DshContext;
    webRoot?: string;
    nativeClientRoot?: string;
    setupTokens: SetupTokenStore;
    configStore: ServerConfigStore;
    restartController: RestartController;
    enableDevTools: boolean;
    pluginCombination: "multiuser" | "platform" | "full";
    pluginCombinationControlled: boolean;
    documents?: false | { root?: string };
    documentsControlled: boolean;
    agentUI?: boolean;
  synchronization?:boolean;
  collaboration?:boolean;
  deviceServices?:boolean;
  },
): Promise<void> {
  const { default: websocket } = await import("@fastify/websocket");
  // Close plugin streams and native connections before Fastify waits for sockets.
  app.addHook("preClose",()=>options.context.fiber.dispose());
  await app.register(websocket);
  const hasPlatform = options.pluginCombination !== "multiuser";
  await app.register(storagePlugin, { schema: hasPlatform ? "platform" : "accounts" });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_APP_PACKAGE_BYTES } });
  const { createPluginSuite } = await import("./lib/dsh-plugin-suite.mjs");
  const pluginContext = await createPluginSuite({
    context: options.context,
    combination: options.pluginCombination,
    agentUI: options.agentUI,
    synchronization:options.synchronization,collaboration:options.collaboration,deviceServices:options.deviceServices,
    documents: options.documents,
    multiuser: { capacity: 100, accountServices, systemEnvironment },
    platform: hasPlatform ? applicationStore(app.config.dataDir) : undefined,
    development: options.pluginCombination === "full"
      ? { dataDir: app.config.dataDir, persistence: { database: getDb, flush: flushMetaDb } }
      : undefined,
  });
  pluginContext.get("localappAgentUI")?.registerHttp(app);
  await pluginContext.localappMultiuser.registerBrowserSessions(app, createBrowserSessionHost());
  if (hasPlatform) await pluginContext.localappApps.initializeStorage({
    config: app.config, migrationsDir: path.resolve(__dirname, "../platform-migrations"),
    hasAccounts: () => listUsers(1, 1).total > 0, logger: console,
  });
  if (hasPlatform) await app.register(verificationPlugin, { createStore: directory => pluginContext.localappApps.verification(directory) });
  app.addHook("onClose", () => pluginContext.fiber.dispose());
  const development = options.pluginCombination === "full" ? await (async () => {
    if (options.enableDevTools) await devToolkitContribution(app, pluginContext.localappDevelopment.createDevToolkit.bind(pluginContext.localappDevelopment)).installRequestContext(app);
    return pluginContext.localappDevelopment.initializeRuntime(app, {
      builds: createBuildOperations(), preview: previewHost,
      workspaces: {
        authorizeExecution: user => accountServices.accounts.getUserRole(user) === "admin",
        workspaceDir: app.config.workspaceDir,
        archiveLimits: {
          maxCompressedBytes: app.config.appDataArchiveMaxBytes,
          maxExpandedBytes: app.config.appDataExpandedMaxBytes,
          maxFileEntries: app.config.appDataArchiveMaxFiles,
        },
      },
      tasks: {
        authorizeExecution: user => accountServices.accounts.getUserRole(user) === "admin",
        taskDir: path.join(app.config.dataDir, "tasks"),
      },
    });
  })() : undefined;
  const platform = hasPlatform ? await (async () => {
    const secretBox = pluginContext.localappMultiuser.createSecrets(app.config.masterKeyFile);
    const deviceNotificationSourceStore = pluginContext.get("localappDeviceServices")?.createDeviceNotificationSources(
      createDeviceNotificationPersistence(), secretBox);
    const synchronization = pluginContext.get("localappAppSync") ? await pluginContext.localappAppSync.initializeSynchronization({
      dataDir: app.config.dataDir, secrets: secretBox,
      persistence: { database: getDb, flush: flushMetaDb },
    }) : undefined;
    return { ...synchronization, deviceNotificationSourceStore };
  })() : undefined;
  await pluginContext.localappMultiuser.registerSetup(app, createSetupHost(app, options.setupTokens));
  await systemRoutes(app, { documentsEnabled: options.documents !== false, documentsControlled: options.documentsControlled, pluginCombination: options.pluginCombination, pluginCombinationControlled: options.pluginCombinationControlled, configStore: options.configStore, restartController: options.restartController });
  if (platform?.peerStore && platform.syncTarget && platform.syncSource) pluginContext.localappAppSync.registerSynchronizationRoutes(app, {
    protocol: { keyOwner: validateApiKey, user: findUserById },
    target: platform.syncTarget, authenticateTarget: createSyncTargetAuthentication,
    source: platform.syncSource, userId: request => request.userId,
    authenticateUser: authPlugin, peers: platform.peerStore, authenticateAdministrator: adminAuth,
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/system/plugins", async () => ({
    success: true,
    data: { combination: options.pluginCombination, multiuser: true, applications: Boolean(platform), development: Boolean(development), agentRuntime: Boolean(pluginContext.get("localappAgentRuntime")), agentSettings:Boolean(pluginContext.get("localappAgentSettings")), modelSettings:Boolean(pluginContext.get("localappModelSettings")), executionEnvironment:Boolean(pluginContext.get("localappExecutionEnvironment")), documents:Boolean(pluginContext.get("localappDocuments")), agentUI:Boolean(pluginContext.get("localappAgentUI")), synchronization:Boolean(pluginContext.get("localappAppSync")),collaboration:Boolean(pluginContext.get("localappCollaboration")),deviceServices:Boolean(pluginContext.get("localappDeviceServices")) },
  }));
  if (development) app.register(async scope => pluginContext.localappDevelopment.registerStarter(scope));

  const webRoot = options.webRoot ?? path.resolve(__dirname, "../../web/out");
  await pluginContext.localappMultiuser.registerWebAssets(app, webRoot);

  pluginContext.localappMultiuser.registerHttp(app, {
    authentication: createAuthenticationHost(app), groups: createGroupRoutesHost(), profile: createProfileHost(app),
  });
  if (platform) pluginContext.localappApps.registerApplicationDataRoutes(app,{
    ownPages:createOwnApplicationPagesHost(app),settings:createApplicationSettingsHost(app),
    dataSettings:createApplicationDataSettingsHost(app),data:createPlatformDataHost(),
  });
  const { registerModelSettings } = await import("./lib/model-settings.mjs");
  await registerModelSettings(app, pluginContext, authPlugin, options.nativeClientRoot);
  pluginContext.localappAgentRuntime.registerModelRoutes(app, {
    authenticate: authPlugin, llm: createLlmRoutesHost(app, pluginContext.localappAgentSettings),
    agent: () => createAgentRoutesHost(app, pluginContext), nativeClientRoot: options.nativeClientRoot,
  });
  if (platform) pluginContext.localappApps.registerApplicationInteractionRoutes(app, {
    issues: createIssueRoutesHost(app), favorites: createApplicationFavoritesHost(),

    websocket: createWebSocketHost(),
  });
  if(platform && pluginContext.get("localappDeviceServices")){
    app.register(async scope=>pluginContext.localappDeviceServices.registerSubscriptions(scope,createSubscriptionRoutesHost()));
    app.register(async scope=>pluginContext.localappDeviceServices.registerInbox(scope,createApplicationInboxHost()));
  }
  if (platform && pluginContext.get("localappDeviceServices")) pluginContext.localappDeviceServices.registerDeviceRoutes(app, {
    desktop: desktopActionContribution(app, pluginContext.localappDeviceServices.createDesktopActionRoutes.bind(pluginContext.localappDeviceServices)),
    device: deviceActionContribution(app, pluginContext.localappDeviceServices.createDeviceActionRoutes.bind(pluginContext.localappDeviceServices)),
    control: createDeviceControlHost(app),
  });
  if (platform?.deviceNotificationSourceStore) pluginContext.localappDeviceServices.registerNotificationRoutes(
    app, platform.deviceNotificationSourceStore, createDeviceNotificationRoutesHost(app));
  pluginContext.localappMultiuser.registerPersonalResources(app, {
    pages: createPersonalPagesHost({ webRoot }),
    dependenciesDirectory: path.resolve(process.cwd(), "static", "deps"),
  });
  pluginContext.localappMultiuser.registerKeyRoutes(app, {
    authenticate: authenticateCliRequest, keys: createKeyRoutesHost(),
  });
  if (platform) pluginContext.localappApps.registerApplicationServing(app, {
    entry: {...createApplicationEntryHost(app, { webRoot }),collaborationEnabled:!!pluginContext.get("localappCollaboration"),deviceServicesEnabled:!!pluginContext.get("localappDeviceServices"),createCrdt:pluginContext.get("localappCollaboration")?.createCrdt.bind(pluginContext.get("localappCollaboration")),createCollaboration:pluginContext.get("localappCollaboration")?.createCollaboration.bind(pluginContext.get("localappCollaboration"))}, verification: createVerificationHost(app),
  });
  if (development) pluginContext.localappDevelopment.registerDeveloperUtilities(app, {
    authenticate: authPlugin,
    cli: { manifestUrl: app.config.releaseManifestUrl }, configuration: app.config,
    checkConfigurationVersion: registerVersionCheck,
  });
  if (platform) pluginContext.localappApps.registerPackageManagement(app, {
    authenticate: authenticateCliRequest,
    routes: {
      pages: createApplicationPagesHost(app), upload: createApplicationUploadHost(app), install: createApplicationInstallHost(app),
      schemas: createApplicationSchemaHost(app), database: createApplicationDatabaseHost(app),
    },
  });
  if (development) pluginContext.localappDevelopment.registerWorkflowRoutes(app, {
      authenticate: authenticateCliRequest,
      development: () => createDevelopmentRoutesHost(app, {
        builds: development.builds,
        previews: development.previews,
        runtimeRegistry: pluginContext.localappAgentRuntime,
        documents: () => pluginContext.get("localappDocuments"),
        nativeClient: developmentClientResources(pluginContext, options.nativeClientRoot),
      }, pluginContext.localappAgentSettings),
      workspaces: createWorkspaceRoutesHost(development.workspaceStore),
      tasks: createTaskRoutesHost({ taskStore: development.taskStore, taskRunner: development.taskRunner, agentRunner: development.agentRunner }),
      tools: options.enableDevTools ? scope => devToolkitContribution(app).register(scope) : undefined,
  });
  pluginContext.localappMultiuser.registerAdministrationRoutes(app, {
    authenticate: adminAuth, accounts: createAdministratorAccountsHost(app.config.dataDir),
    contributions: async scope => {
      scope.register(async environmentScope => pluginContext.localappExecutionEnvironment.registerEnvironment(environmentScope,{dataDir:app.config.dataDir,checkEnvironment:()=>systemEnvironment.check(app.config.dataDir)}));
      if (platform) await pluginContext.localappApps.registerAdministratorApplications(scope, createAdministratorApplicationsHost(app.config.dataDir));
      if (development) scope.register(async environmentScope => pluginContext.localappDevelopment.registerEnvironment(environmentScope, createBuildOperations().createExecutor));
    },
  });

  if (platform) pluginContext.localappApps.registerRequestLogging(app, {
    scope: app.config.dataDir,
    identity: request => ({ userId: request.userId || null, visitorId: request.visitorId || null }),
  });

  if (platform) pluginContext.localappApps.registerDatabaseMaintenance(app, app.config.dataDir);
}
