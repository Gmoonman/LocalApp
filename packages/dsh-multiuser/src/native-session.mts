import { TYPERT as JOB_TYPERT } from "@deepseek-ai/dsh-api-job-controller/typert";
import FileReferences from "@deepseek-ai/dsh-file-reference-local";
import { TYPERT as GOAL_TYPERT } from "@deepseek-ai/dsh-goal/typert";
import { TYPERT as SCHEDULE_TYPERT } from "@deepseek-ai/dsh-schedule/typert";
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { NativePromptAdmissions } from "./native-prompt-admissions.mjs";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import TypertRegistry from "@deepseek-ai/dsh-typert-registry";
import Gateway from "@deepseek-ai/dsh-api-gateway";
import * as Remotes from "@deepseek-ai/dsh-api-remotes";
import SessionController, { type SessionCreateRequest, type SessionPromptRequest, type SessionForkRequest, type SessionListRequest, type SessionListValue } from "@deepseek-ai/dsh-api-session-controller";
import { TYPERT } from "@deepseek-ai/dsh-api-session-controller/typert";
import DefaultModel from "@deepseek-ai/dsh-agent-default-model";
import Attachments from "@deepseek-ai/dsh-attachment-local";
import FileUploads from "@deepseek-ai/dsh-client-file-upload";
import JobController from "@deepseek-ai/dsh-api-job-controller";
import SessionQuery from "@deepseek-ai/dsh-session-query-sqlite";
import WorkspaceRegistry from "@deepseek-ai/dsh-workspace";
import WorkspaceController, { type WorkspaceCreateRequest } from "@deepseek-ai/dsh-api-workspace-controller";
import { TYPERT as WORKSPACE_TYPERT } from "@deepseek-ai/dsh-api-workspace-controller/typert";
import SettingsController from "@deepseek-ai/dsh-api-settings-controller";
import { TYPERT as SETTINGS_TYPERT } from "@deepseek-ai/dsh-api-settings-controller/typert";
import type { SettingsDescribeValue } from "@deepseek-ai/dsh-settings/types";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import EmbeddedWebServer from "./native-server.mjs";
import { mountNativeConnection, type NativeConnectionConfig } from "./native-connection.mjs";

export interface NativeSessionConfig extends NativeConnectionConfig {
  workspaceRoot: string;
  fileReferences?: boolean;
  model: string;
  onPrompt?: (sessionId:string)=>()=>void;
}

/** Add dsh's real SessionController and Gateway to an isolated user's Harness. */
export async function mountNativeSessions(ctx: Context, config: NativeSessionConfig) {
  const workspaceRoot = path.resolve(config.workspaceRoot);
  const nativeContext = ctx.isolate("sessionController");
  await nativeContext.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
  const transport = await mountNativeConnection(nativeContext, config);
  if (config.fileReferences) await nativeContext.plugin(FileReferences);
  await nativeContext.plugin(TypertRegistry);
  nativeContext.typert.register(TYPERT as Parameters<typeof nativeContext.typert.register>[0]);
  nativeContext.typert.register(WORKSPACE_TYPERT as Parameters<typeof nativeContext.typert.register>[0]);
  nativeContext.typert.register(SETTINGS_TYPERT as Parameters<typeof nativeContext.typert.register>[0]);
  if (nativeContext.get("jobs")) nativeContext.typert.register(JOB_TYPERT as Parameters<typeof nativeContext.typert.register>[0]);
  if (nativeContext.get("goals")) nativeContext.typert.register(GOAL_TYPERT as Parameters<typeof nativeContext.typert.register>[0]);
  if (nativeContext.get("schedule")) nativeContext.typert.register(SCHEDULE_TYPERT as Parameters<typeof nativeContext.typert.register>[0]);
  // Model changes remain owned by LocalApp's per-user settings API. The native
  // client reads the effective configuration without receiving credentials.
  class ApplicationSettingsController extends SettingsController {
    override describe(): SettingsDescribeValue {
      return { writable: false, hasDocument: false, namespaces: [{
        ns: "localapp-model", autoGenerate: false, schema: { type: "object", dict: {} },
        value: { provider: "localapp", model: config.model }, applies: "live", secrets: [], revision: 0,
      }, {
        ns: "ui-settings", autoGenerate: false, schema: { type: "object", dict: {} },
        value: { enabled: true }, applies: "live", secrets: [], revision: 0,
      }] };
    }
  }
  await nativeContext.plugin(ApplicationSettingsController);
  await nativeContext.plugin(DefaultModel, { provider: "localapp", model: config.model });
  await nativeContext.plugin(Attachments, { dshHome: config.root });
  await nativeContext.plugin(WorkspaceRegistry);
  class ApplicationWorkspaceController extends WorkspaceController {
    override create(request: WorkspaceCreateRequest) {
      if (path.resolve(request.path) !== workspaceRoot) throw new Error("Workspace is outside the application workspace");
      return super.create({ path: workspaceRoot });
    }
    override async initializeDefault(signal: AbortSignal) {
      signal.throwIfAborted();
      await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      const value = await this.create({ path: workspaceRoot });
      return { workspace: value.workspace };
    }
  }
  await nativeContext.plugin(ApplicationWorkspaceController);
  const defaultWorkspace = await nativeContext.workspaceController.initializeDefault(new AbortController().signal);
  if (!defaultWorkspace) throw new Error("Application workspace initialization failed");
  const defaultWorkspaceId = defaultWorkspace.workspace.workspaceId;
  await nativeContext.plugin(SessionQuery, { path: path.join(config.root, "session-search.sqlite") });
  await nativeContext.plugin(FileUploads);
  await nativeContext.plugin(JobController);

  // Upstream creation uses node:fs mkdir, so validate the workspace before it
  // reaches that operation. The application decides the directory, not a client.
  const admissions=new NativePromptAdmissions<Awaited<ReturnType<SessionController["prompt"]>>>();
  nativeContext.effect(()=>()=>admissions.dispose());
  class ApplicationSessionController extends SessionController {
    static override inject = [...SessionController.inject, "sessionPersistence"];
    private readonly creating = new Set<string>();
    override async list(request: SessionListRequest, signal: AbortSignal) {
      const result = await super.list(request, signal);
      const cache = this.ctx.get("sessionProjectionCache");
      if (!cache) return result;
      const items: SessionListValue["items"][number][] = [];
      for (const item of result.items) {
        signal.throwIfAborted();
        if (item.projections?.values.title !== undefined || this.ctx.sessions.get(item.sessionId)) {
          items.push(item);
          continue;
        }
        // Earlier LocalApp versions did not install dsh's projection cache.
        // Fold the existing log without activating an Agent or invoking a model.
        const handle = await this.ctx.sessionPersistence.open(item.sessionId, "read");
        try {
          const { events } = await handle.read();
          signal.throwIfAborted();
          const block = cache.coldSnapshot(handle.header, handle.inheritedEventCount, events);
          // The cache validates wire values as lossless JSON; dsh's projection
          // map types do not carry the list transport's JSON index signature.
          const values = block.values as unknown as NonNullable<SessionListValue["items"][number]["projections"]>["values"];
          items.push({ ...item, projections: { kind: "cached", asOfSeq: block.asOfSeq, values } });
        } finally { await handle.close(); }
      }
      return { ...result, items };
    }
    override async fork(request:SessionForkRequest){
      if(this.ctx.agents.list().length+this.creating.size>=10)throw new Error("Too many agent sessions");
      const reservation=`fork-${randomUUID()}`;
      this.creating.add(reservation);
      try{return await super.fork(request);}
      finally{this.creating.delete(reservation);}
    }
    override async prompt(request:SessionPromptRequest,signal:AbortSignal){
      const key=request.sessionId+"/"+request.requestId;
      return admissions.run(key,()=>this.admitPrompt(request,signal));
    }
    private async admitPrompt(request:SessionPromptRequest,signal:AbortSignal){
      const resolvedRequest=await this.resolveAgent(request.sessionId);
      if("agent" in resolvedRequest){
        const agent=resolvedRequest.agent;
        const matches=(message:{source:unknown})=>{const source=message.source as {kind?:string;rpcId?:string};return source.kind==="user"&&source.rpcId===request.requestId;};
        const repeated=agent.inbox.nextTurn.some(matches)||agent.inbox.nextStep.some(matches)||agent.session.snapshotEvents().some(event=>event.type==="user/message"&&matches(event.data));
        // Let dsh validate and acknowledge its existing receipt without opening
        // another application mutation lock or changing the selected model.
        if(repeated)return super.prompt(request,signal);
      }
      const restore=config.onPrompt?.(request.sessionId);
      try {
        // dsh restores the model from the last request header. LocalApp selects
        // the provider outside the session, so record that selection through
        // dsh before continuing a session opened with another model.
        const resolved = await this.resolveAgent(request.sessionId);
        if ("agent" in resolved) {
          const previous = resolved.agent.session.requestHeader()?.config;
          if (previous && (previous.provider !== "localapp" || previous.model !== config.model)) {
            await this.selectModel({ sessionId: request.sessionId, provider: "localapp", model: config.model });
          }
        }
        const result=await super.prompt(request,signal);
        if(!result.accepted)restore?.();
        return result;
      } catch(error){restore?.();throw error;}
    }
    override async create(request: SessionCreateRequest) {
      if (request.sessionId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(request.sessionId)) {
        throw new Error("Invalid session ID");
      }
      const selected = request.workspaceId === undefined ? undefined : this.ctx.workspaceRegistry.get(request.workspaceId);
      const cwd = selected?.path ?? request.cwd ?? workspaceRoot;
      if (path.resolve(cwd) !== workspaceRoot) throw new Error("Session workspace is outside the application workspace");
      const existing = request.sessionId !== undefined && this.ctx.agents.list().some(agent => agent.id === request.sessionId);
      if (!existing && this.ctx.agents.list().length + this.creating.size >= 10) throw new Error("Too many agent sessions");
      // Distinct reservations count concurrent requests with generated IDs too.
      const reservation = request.sessionId ?? `pending-${randomUUID()}`;
      if (this.creating.has(reservation)) throw new Error("Agent session is already being created");
      this.creating.add(reservation);
      try {
        if (request.sessionId !== undefined && request.cwd === undefined && request.workspaceId === undefined) {
          const stored = await this.ctx.sessionPersistence.stat(request.sessionId);
          if (stored?.header.cwd) {
            const relative = path.relative(workspaceRoot, path.resolve(stored.header.cwd));
            if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Session workspace is outside the application workspace");
            // Adopt the persisted session without changing its provider-local
            // directory or attaching it to the default workspace.
            return await super.create({ ...request, cwd: stored.header.cwd });
          }
        }
        const { cwd: _cwd, ...input } = request;
        return await super.create(request.workspaceId === undefined ? { ...input, workspaceId: defaultWorkspaceId } : request);
      }
      finally { this.creating.delete(reservation); }
    }
  }
  await nativeContext.plugin(ApplicationSessionController, { nativeOpen: false });
  if (!nativeContext.get("sessionController")) throw new Error("Native SessionController dependencies are not ready");
  await nativeContext.plugin(Gateway);
  await nativeContext.plugin(Remotes);
  return {
    transport, gateway: nativeContext.typertGateway, schedule: Boolean(nativeContext.get("schedule")),
    prompt: (request: Omit<SessionPromptRequest,"sessionId"|"requestId"> & {sessionId:string;requestId:string}, signal: AbortSignal) => {
      if(!/^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId))throw new Error("Invalid native request ID");
      return nativeContext.sessionController.prompt({...request,sessionId:SessionId(request.sessionId),requestId:request.requestId as SessionPromptRequest["requestId"]},signal);
    },
    resolveAgent: async (id: string): Promise<AgentHandle["agent"]> => {
      const resolved = await nativeContext.sessionController.resolveAgent(SessionId(id));
      if ("error" in resolved) throw resolved.error;
      return resolved.agent;
    },
  };
}
