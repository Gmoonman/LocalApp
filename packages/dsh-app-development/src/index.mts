import type {} from "@localapp/dsh-agent-runtime";
import type {} from "@localapp/dsh-agent-ui";
import { starterDocRoutes } from "./starter-doc-routes.cjs";
import { createCliRoutes, type CliRouteOptions } from "./cli-routes.cjs";
import { createDevToolkit } from "./dev-toolkit-routes.cjs";
import { AgentRunner, type AgentRunnerOptions } from "./agent-runner.cjs";
import { registerTasks } from "./tasks-routes.cjs";
import { TaskRunner, type TaskRunnerOptions } from "./task-runner.cjs";
import { TaskStore } from "./task-store.cjs";
import { WorkspaceStore, type WorkspaceStoreOptions } from "./workspace-store.cjs";
import { registerWorkspaces, type WorkspaceRoutesHost } from "./workspaces-routes.cjs";
import { registerDevelopmentRoutes } from "./routes.cjs";
import { DevelopmentAttachments } from "./attachments.cjs";
import { Service, type Context } from "@deepseek-ai/cordis";
import { ProjectStore, type DevelopmentPersistence } from "./projects.cjs";
import { DevelopmentBuilds, type BuildManifest, type BuildOperations, type BuildTask } from "./builds.cjs";
import { ApplicationCreations } from "./creation.cjs";
import { DevelopmentReleases, type ReleaseBuildStore } from "./releases.cjs";
import { DevelopmentPreviews, type PreviewHost } from "./previews.cjs";
import { registerDevelopmentSource, type DevelopmentSourceHost } from "./source-routes.cjs";
import type { FastifyInstance } from "fastify";
import * as environment from "./environment.cjs";
import * as template from "./template.cjs";
import { fileURLToPath } from "node:url";

export const taskSupervisorPath = fileURLToPath(new URL("../runner/task-supervisor.mjs", import.meta.url));
export { createBuildOperations } from "./builds.cjs";
export { checkProject } from "./project/check.cjs";
export { buildApplicationPackage } from "./project/package.cjs";

export interface DevelopmentHost { dataDir: string; persistence: DevelopmentPersistence; }
export class ApplicationDevelopment extends Service {
  async initializeRuntime<Manifest extends BuildManifest>(app: FastifyInstance, host: {
    builds: BuildOperations<Manifest>;
    preview: PreviewHost;
    workspaces: WorkspaceStoreOptions;
    tasks: Omit<TaskRunnerOptions, "taskStore" | "workspaceStore" | "supervisorPath"> & { supervisorPath?: string };
  }) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    const builds = this.builds(host.builds);
    const previews = this.previews(builds, host.preview);
    previews.attach(app);
    const workspaceStore = this.workspaces(host.workspaces);
    const taskRunner = this.taskRunner({ ...host.tasks, workspaceStore });
    const agentRunner = this.agentRunner({ taskRunner });
    await taskRunner.reconcileRunning();
    if (!this.active) throw new Error("Application development plugin is stopped");
    workspaceStore.setTaskRunner(taskRunner);
    return { builds, previews, workspaceStore, taskStore: this.tasks, taskRunner, agentRunner };
  }
  registerWorkflowRoutes(app: FastifyInstance, host: {
    authenticate(scope: FastifyInstance): Promise<void>;
    development: () => Promise<Parameters<ApplicationDevelopment["registerRoutes"]>[1]>;
    workspaces: WorkspaceRoutesHost;
    tasks: Parameters<ApplicationDevelopment["registerTasks"]>[1];
    tools?(scope: FastifyInstance): Promise<void>;
  }) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    app.register(async scope => {
      await host.authenticate(scope);
      this.guardRoutes(scope);
      scope.register(async developmentScope => {
        const routes = await host.development();
        await this.registerRoutes(developmentScope, routes);
      });
      scope.register(async workspaceScope => this.registerWorkspaces(workspaceScope, host.workspaces));
      scope.register(async taskScope => this.registerTasks(taskScope, host.tasks));
      if (host.tools) scope.register(async toolScope => {
        this.guardRoutes(toolScope);
        await host.tools!(toolScope);
      });
    });
  }
  registerDeveloperUtilities(app: FastifyInstance, host: {
    authenticate(scope: FastifyInstance): Promise<void>;
    cli: CliRouteOptions;
    configuration: { templateRepoUrl: string; gitDownloadUrl?: string };
    checkConfigurationVersion?(scope: FastifyInstance): void;
  }): void {
    if (!this.active) throw new Error("Application development plugin is stopped");
    app.register(async scope => {
      await host.authenticate(scope);
      this.guardRoutes(scope);
      scope.register(async cliScope => this.registerCli(cliScope, host.cli));
      scope.register(async configScope => {
        host.checkConfigurationVersion?.(configScope);
        this.registerConfiguration(configScope, host.configuration);
      });
    });
  }
  registerConfiguration(app: FastifyInstance, config: {templateRepoUrl: string; gitDownloadUrl?: string}) {
    this.guardRoutes(app);
    app.get("/api/config", async () => ({
      templateRepoUrl: config.templateRepoUrl,
      gitDownloadUrl: config.gitDownloadUrl || null,
    }));
  }
  registerEnvironment(app: FastifyInstance, createExecutor: BuildOperations<BuildManifest>["createExecutor"]) {
    this.guardRoutes(app);
    app.get("/api/system/development-environment", async () => ({ success: true, data: await environment.developmentEnvironment(this.host.dataDir, createExecutor) }));
    app.put<{ Body: environment.DevelopmentSettings }>("/api/system/development-environment", async (request, reply) => {
      try { return { success: true, data: environment.saveDevelopmentSettings(this.host.dataDir, request.body ?? {}) }; }
      catch (error) { return reply.code(400).send({ success: false, error: (error as Error).message }); }
    });
  }
  registerStarter(app: FastifyInstance) {
    this.guardRoutes(app);
    starterDocRoutes(app);
  }
  registerCli(app: FastifyInstance, options: CliRouteOptions) {
    this.guardRoutes(app);
    return createCliRoutes(options)(app);
  }
  private guardRoutes(app: FastifyInstance): void {
    if (!this.active) throw new Error("Application development plugin is stopped");
    app.addHook("onRequest", async (_request, reply) => {
      if (!this.active) return reply.code(503).send({ success: false, error: "Application development plugin is stopped" });
    });
  }
  createDevToolkit(host: Parameters<typeof createDevToolkit>[0]) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    return createDevToolkit({ ...host, isActive: () => this.active });
  }
  private active = true;
  readonly projects: ProjectStore;
  readonly tasks: TaskStore;
  readonly attachments: DevelopmentAttachments;
  readonly creations: ApplicationCreations;
  readonly template = template;
  readonly environment = environment;
  constructor(private readonly context: Context, private readonly host: DevelopmentHost) {
    super(context, "localappDevelopment");
    const agentUI=context.get("localappAgentUI");
    if(agentUI) context.effect(()=>agentUI.registerIdentity({id:"developer",label:"开发者"}));
    context.effect(() => () => { this.active = false; });
    this.tasks = new TaskStore(host.persistence);
    this.projects = new ProjectStore(host.dataDir, host.persistence);
    this.attachments = new DevelopmentAttachments(this.projects);
    this.creations = new ApplicationCreations(host.dataDir, this.projects);
  }
  builds<Manifest extends BuildManifest>(operations: BuildOperations<Manifest>, task?: BuildTask) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    const builds = new DevelopmentBuilds(this.host.dataDir, this.projects, task, operations);
    this.context.effect(() => () => builds.close());
    return builds;
  }
  previews(builds: ReleaseBuildStore, host: PreviewHost) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    const previews = new DevelopmentPreviews(this.host.dataDir, this.projects, builds, host);
    this.context.effect(() => () => previews.close());
    return previews;
  }
  registerRoutes(app: FastifyInstance, host: Omit<Parameters<typeof registerDevelopmentRoutes>[1], "dataDir" | "projects" | "attachments" | "creations" | "releases" | "registerSource" | "runtimeRegistry"> & { runtimeRegistry?: Parameters<typeof registerDevelopmentRoutes>[1]["runtimeRegistry"] }) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    const runtimeRegistry = host.runtimeRegistry ?? this.context.get("localappAgentRuntime");
    if (!runtimeRegistry) throw new Error("Multiuser runtime service is required");
    app.addHook("onRequest", async (_request, reply) => {
      if (!this.active) return reply.code(503).send({ success: false, error: "Application development plugin is stopped" });
    });
    return registerDevelopmentRoutes(app, {
      ...host,
      runtimeRegistry,
      dataDir: this.host.dataDir,
      projects: this.projects,
      attachments: this.attachments,
      creations: this.creations,
      releases: this.releases(host.builds),
    });
  }
  agentRunner(options: AgentRunnerOptions) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    return new AgentRunner(options);
  }
  registerTasks(app: FastifyInstance, host: Omit<Parameters<typeof registerTasks>[1], "taskStore">) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    app.addHook("onRequest", async (_request, reply) => {
      if (!this.active) return reply.code(503).send({ success: false, error: "Application development plugin is stopped" });
    });
    return registerTasks(app, { ...host, taskStore: this.tasks });
  }
  taskRunner(options: Omit<TaskRunnerOptions, "taskStore" | "supervisorPath"> & { supervisorPath?: string }) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    const runner = new TaskRunner({ ...options, supervisorPath: options.supervisorPath ?? taskSupervisorPath, taskStore: this.tasks });
    this.context.effect(() => () => runner.shutdown());
    return runner;
  }
  workspaces(options: WorkspaceStoreOptions) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    const store = new WorkspaceStore(options, this.host.persistence);
    this.context.effect(() => () => store.shutdown());
    return store;
  }
  registerWorkspaces(app: FastifyInstance, host: WorkspaceRoutesHost) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    app.addHook("onRequest", async (_request, reply) => {
      if (!this.active) return reply.code(503).send({ success: false, error: "Application development plugin is stopped" });
    });
    return registerWorkspaces(app, host);
  }
  registerSource(app: FastifyInstance, host: Omit<DevelopmentSourceHost, "projects" | "dataDir">) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    app.addHook("onRequest", async (_request, reply) => {
      if (!this.active) return reply.code(503).send({ success: false, error: "Application development plugin is stopped" });
    });
    return registerDevelopmentSource(app, { ...host, projects: this.projects, dataDir: this.host.dataDir });
  }
  releases(builds: ReleaseBuildStore) {
    if (!this.active) throw new Error("Application development plugin is stopped");
    return new DevelopmentReleases(this.host.dataDir, this.projects, builds);
  }
}
declare module "@deepseek-ai/cordis" { interface Context { localappDevelopment: ApplicationDevelopment; } }
export default ApplicationDevelopment;
