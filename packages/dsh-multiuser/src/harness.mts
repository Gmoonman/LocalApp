import { resolveDeepSeekPlugin } from "./deepseek-plugin.mjs";
import path from "node:path";
import type { PythonEnvironment } from "./python-environment.cjs";
import { environmentProbe, summarizeEnvironment, type AgentEnvironment, type EnvironmentCheck } from "./agent-environment.cjs";
import fs from "node:fs";
import SessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { mountHarnessCapabilities, mountApplicationFileSystem } from "./harness-capabilities.mjs";
import type { AgentCapability, AgentSettings, AgentProvider } from "./settings.cjs";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { type AgentHandle } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, { createUserMessage, type Message } from "@deepseek-ai/dsh-llm";
import SessionTitle, { foldSessionTitle, fallbackSessionTitle } from "@deepseek-ai/dsh-session-title";
import * as FirstPromptTitle from "@deepseek-ai/dsh-session-title-first-prompt-llm";
import SessionRegistry, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { LocalAppLlmAdapter } from "./llm-adapter.mjs";


export interface HarnessInput {
  sessionId: string;
  appId?: string;
  providerId?: string;
  prompt: string;
  systemPrompt: string;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}
interface Conversation {
  userId: string;
  application?: HarnessInput;
  handle: AgentHandle;
  registrations: Array<() => void>;
  busy: boolean;
  touched: number;
  emit?: (event: unknown) => void;
}
interface PendingResult {
  userId: string;
  sessionId: string;
  resolve: (value: unknown) => void;
}

function parseArguments(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw); } catch { return {}; }
}

export function browserMessages(messages: Message[]) {
  return messages.filter((m) => m.role !== "system" && m.role !== "developer" && (m.role !== "user" || m.source.kind === "user")).map((m) => {
    if (m.role === "tool") return { role: "toolResult", toolCallId: m.toolCallId, content: m.content, isError: !!m.isError };
    return { role: m.role, content: m.content.map((b) => b.type === "tool-call"
      ? { type: "toolCall", id: b.id, name: b.name, arguments: parseArguments(b.arguments) }
      : b) };
  });
}

/** A plugin tree inside the unified Server, with no additional listener or CLI. */
export type ApplicationTool = HarnessInput["tools"][number] & { execute(args: unknown): unknown | Promise<unknown> };

export class DeepSeekHarness {
  private readonly ctx = new Context();
  private disposed = false;
  isRunning(): boolean { if (this.disposed) return false; return [...this.conversations.values()].some(value => value.busy) || this.ctx.agents.list().some(agent => agent.status === "running"); }
  private nativeReady?: Promise<Awaited<ReturnType<typeof import("./native-session.mjs").mountNativeSessions>>>;
  private readonly nativeSessions=new Set<string>();
  async nativeApi() {
    if (!this.config.root || !this.config.ownerId) throw new Error("Native API requires an authenticated application runtime");
    return this.nativeReady ??= (async () => {
      await this.ready;
      const workspaceRoot = this.config.workspaceRoot ?? path.join(this.config.root!, "workspace");
      if (!this.ctx.get("fs")) await mountApplicationFileSystem(this.ctx, workspaceRoot);
      const { mountNativeSessions } = await import("./native-session.mjs");
      return mountNativeSessions(this.ctx, { userId: this.config.ownerId!, root: this.config.root!, workspaceRoot, model: this.config.llmModel, fileReferences: this.config.capabilities?.includes("files") ?? false,
        onPrompt:sessionId=>{
          if(this.conversations.get(sessionId)?.busy)throw new Error("Agent session is already running through the application transport");
          const release = this.config.onNativePrompt?.(sessionId);
          const previous=this.nativeSessions.has(sessionId);this.nativeSessions.add(sessionId);
          return()=>{release?.();if(!previous)this.nativeSessions.delete(sessionId);};
        } });
    })();
  }
  private readonly conversations = new Map<string, Conversation>();
  private readonly nativeApplications = new Map<string, { userId: string; application: HarnessInput; agent: AgentHandle["agent"]; registrations: Array<() => void>; emit?: (event: unknown) => void }>();
  async bindNativeApplication(userId: string, input: HarnessInput) {
    await this.ready;
    if (userId !== this.config.ownerId) throw new Error("Application runtime belongs to another user");
    const agent = this.ctx.agents.get(SessionId(input.sessionId));
    if (!agent) throw new Error("Native application session is not open");
    if (agent.status === "running") throw new Error("Cannot change application tools while the session is running");
    const builtinNames = new Set(this.ctx.tools.schemas().map(tool => tool.name));
    if (input.tools.some(tool => builtinNames.has(tool.name))) throw new Error("Application tool conflicts with Harness tool");
    const old = this.nativeApplications.get(input.sessionId);
    for (const dispose of old?.registrations ?? []) dispose();
    const registrations: Array<() => void> = [];
    try {
      registrations.push(agent.ctx.systemPrompt.section({ name: "localapp-application", order: 0, text: () => input.systemPrompt, complete: true }));
      for (const tool of input.tools) registrations.push(agent.ctx.tools.register({ ...tool,
        output: { schema: {}, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
        execute: (args, exec) => this.requestTool(userId, input.sessionId, tool.name, args, exec.callId, exec.signal, event => this.publish(input.sessionId, event)),
      }));
      this.nativeApplications.set(input.sessionId, { userId, application: input, agent, registrations });
    } catch (error) { for (const dispose of registrations) dispose(); this.nativeApplications.delete(input.sessionId); throw error; }
  }
  private readonly pending = new Map<string, PendingResult>();
  private readonly watchers = new Map<string, Set<(event: unknown) => void>>();
  private readonly creating = new Set<string>();
  private readonly ready: Promise<void>;
  private readonly timer: ReturnType<typeof setInterval>;

  private environmentCheck?: { at: number; result: Promise<AgentEnvironment> };
  async checkEnvironment(): Promise<AgentEnvironment> {
    if (this.environmentCheck && Date.now() - this.environmentCheck.at < 15_000) return this.environmentCheck.result;
    const result = (async () => {
      const enabled = this.config.capabilities?.includes("terminal") && !this.config.disabledTools?.includes("bash");
      const selected = this.config.capabilities?.includes("skills") ? this.config.skills ?? [] : [];
      const checks: EnvironmentCheck[] = [{ id: "terminal", name: "终端执行", status: enabled ? "ready" : "blocked", detail: enabled ? "已在当前用户和应用中开启。" : "请先在 Agent 页签开启终端执行，并确保 bash 工具未关闭。", required: true }];
      if (!enabled || !this.config.root) return summarizeEnvironment("", selected, checks);
      try {
        const spec = this.ctx.shell.resolve({ command: environmentProbe(this.config.pythonEnvironment?.executable), workdir: this.config.workspaceRoot ?? path.join(this.config.root, "workspace"), timeoutMs: 60_000, stdoutMaxBytes: 32_768 });
        const execution = await this.ctx.shell.execute(spec);
        const output = await execution.result();
        const ok = output.exitCode === 0 && !output.timedOut && !output.sandbox?.denied;
        checks.push({ id: "runner", name: "工作区命令执行", status: ok ? "ready" : "blocked", detail: ok ? "已通过 Agent 的执行器运行检查。" : "执行检查失败或超时；请检查 Server 的工作区执行支持。", required: true });
        return summarizeEnvironment(ok ? output.stdout.text : "", selected, checks);
      } catch {
        checks.push({ id: "runner", name: "工作区命令执行", status: "blocked", detail: "Server 无法在应用工作区执行检查，请检查执行器支持。", required: true });
        return summarizeEnvironment("", selected, checks);
      }
    })();
    this.environmentCheck = { at: Date.now(), result };
    return result;
  }
  async executeDevelopmentCommand(command: string, args: string[], signal?: AbortSignal): Promise<{ exitCode: number | null; timedOut: boolean; stdout: { text: string }; stderr: { text: string } }> {
    if (!this.config.workspaceRoot || !this.config.networkBlocked) throw new Error("Development executor is not configured");
    await this.ready;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const spec = this.ctx.shell.resolve({ command: [command, ...args].map(quote).join(" "), workdir: this.config.workspaceRoot, env: this.config.localTestPorts?.length === 2 ? { LOCALAPP_TEST_BACKEND_PORT: String(this.config.localTestPorts[0]), LOCALAPP_TEST_APP_PORT: String(this.config.localTestPorts[1]) } : undefined, timeoutMs: 120_000, stdoutMaxBytes: 1024 * 1024, signal });
    const execution = await this.ctx.shell.execute(spec);
    return await execution.result();
  }
  toolCatalog() { return this.ctx.tools.schemas().map(({ name, description }) => ({ name, description })); }

  constructor(private readonly config: { llmApiKey: string; llmBaseUrl: string; llmModel: string } & { root?: string; capabilities?: AgentCapability[]; mcpServers?: AgentSettings["mcpServers"]; protocol?: AgentProvider["protocol"]; ownerId?: string; skills?: string[]; disabledTools?: string[]; pythonEnvironment?: PythonEnvironment; workspaceRoot?: string; autoSessionTitles?: boolean; dataRoot?: string; networkBlocked?: boolean; localTestPorts?: number[]; readDirectories?: string[]; publicSkillsRoot?: string; applicationPrompt?: string; applicationTools?: ApplicationTool[]; onNativeAgentDisposed?: (sessionId: string) => void; onNativePrompt?: (sessionId: string) => (() => void); onNativeAgentStatus?: (sessionId: string, status: "idle" | "running") => void }) {
    this.ready = (async () => {
      await this.ctx.plugin(resolveDeepSeekPlugin(LlmRuntime));
      await this.ctx.plugin(resolveDeepSeekPlugin(SessionRegistry));
      await this.ctx.plugin(resolveDeepSeekPlugin(SessionProjections));
      if (config.root) await this.ctx.plugin(resolveDeepSeekPlugin(SessionPersistence), { root: path.join(config.root, "sessions"), compression: "none" });
      await this.ctx.plugin(resolveDeepSeekPlugin(SystemPrompt), { includeHarnessIdentity: false, includeRuntimeContext: !!config.root });
      await this.ctx.plugin(resolveDeepSeekPlugin(ToolRuntime), { mode: "native" });
      await this.ctx.plugin(resolveDeepSeekPlugin(AgentRegistry));
      if (config.onNativeAgentStatus) this.ctx.on("agent/status", ({ agent, status }) => { if (this.nativeSessions.has(agent.session.id)) config.onNativeAgentStatus!(agent.session.id, status); });
      if (config.onNativeAgentDisposed) this.ctx.on("agent/disposed", ({ agent }) => config.onNativeAgentDisposed!(agent.session.id));
      await this.ctx.plugin(resolveDeepSeekPlugin(AgentLoop), { agents: [], maxParallelToolCalls: 1 });
      if (config.protocol && config.protocol !== "openai-completions") {
        this.ctx.provide("credentials", { resolve: async () => ({ value: config.llmApiKey }), listRecords: async () => [] });
        this.ctx.provide("launchEnvironment", { get: () => undefined });
        await this.ctx.plugin(resolveDeepSeekPlugin(PiAi), { providers: { localapp: { api: config.protocol, baseURL: config.llmBaseUrl, apiKeyEnv: "LOCALAPP_USER_MODEL_KEY", models: [{ id: config.llmModel }], retryPolicy: { mode: "normal", maxRetries: 0 } } } });
      } else {
        this.ctx.llm.registerAdapter(["localapp"], new LocalAppLlmAdapter(config, (id, event) => id && this.publish(id, event)));
      }
      await this.ctx.plugin(resolveDeepSeekPlugin(SessionTitle), { fallbackMaxWords: 8, fallbackMaxBytes: 120, maxTitleBytes: 160 });
      if (config.autoSessionTitles) {
        await this.ctx.plugin(resolveDeepSeekPlugin(FirstPromptTitle), { targetWords: 6, targetCjkCharacters: 16, maxInputBytes: 16384, maxOutputTokens: 128, timeoutMs: 20000, provider: "localapp", model: config.llmModel });
      }
      this.ctx.on("session/event", (session, event) => {
        if (event.type === "session/title") {
          this.publish(session.id, { type: "session_title", sessionId: session.id, title: this.ctx.sessionTitle.get(session)?.title });
          if (config.root) void (this.ctx.sessions as unknown as Pick<SessionRegistry, "flush">).flush(session).catch(() => {});
        }
      });
      if (config.root) {
        this.ctx.provide("sessionController", { resolveAgent: async (id: string) => {
          return { agent: await this.restoreScheduledSession(id) };
        } });
        await mountHarnessCapabilities(this.ctx, config.root, config.capabilities ?? [], config.mcpServers ?? [], config.skills ?? [], config.pythonEnvironment, config);
        for (const tool of config.applicationTools ?? []) {
          this.ctx.tools.register({ ...tool,
            output: { schema: {}, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
            execute: async args => tool.execute(args),
          });
        }
        this.ctx.tools.guard((execution) => config.disabledTools?.includes(execution.name) ? "此工具已在应用设置中关闭" : undefined);
        this.ctx.systemPrompt.section({ name: "localapp-application", order: 0, text: () => {
          if (config.applicationPrompt) return config.applicationPrompt;
          try { return JSON.parse(fs.readFileSync(path.join(config.root!, "application-prompt.json"), "utf8")).systemPrompt; }
          catch { return "你是 LocalApp 应用中的 Agent，按用户要求使用应用提供的工具。"; }
        } });
        this.ctx.on("approval/request", async (request, next) => {
          const connection = this.connectionFor(request.agent.id);
          const conversation = connection && (this.conversations.get(connection) ?? this.nativeApplications.get(connection));
          if (this.nativeReady && (!conversation || this.nativeSessions.has(connection || request.agent.id))) return next();
          if (!conversation || !conversation.emit && !this.watchers.get(connection!)?.size) return "unavailable";
          const answer = await this.requestInteraction(conversation.userId, connection!, { kind: "approval", toolName: request.toolName, reason: request.reason }, request.signal ?? new AbortController().signal, (event) => this.publish(connection!, event));
          return answer === "allowed-once" ? "allowed-once" : "rejected";
        });
        this.ctx.on("user-questions/request", async (request, next) => {
          const connection = request.agent && this.connectionFor(request.agent.id);
          const conversation = connection && (this.conversations.get(connection) ?? this.nativeApplications.get(connection));
          if (this.nativeReady && (!conversation || this.nativeSessions.has(connection || request.agent?.id || ""))) return next();
          if (!conversation || !conversation.emit && !this.watchers.get(connection!)?.size) throw new Error("No connected user for this question");
          return this.requestInteraction(conversation.userId, connection!, { kind: "questions", questions: request.questions }, request.signal ?? new AbortController().signal, (event) => this.publish(connection!, event));
        });
      }
      this.ctx.on("agent/created", ({ agent }): undefined => {
        const denied = this.ctx.tools.schemas().map((tool) => tool.name).filter((name) => config.disabledTools?.includes(name));
        if (denied.length) agent.ctx.tools.restrict({ deny: denied });
        const connection = this.connectionFor(agent.id);
        if (!connection || connection === agent.id) return;
        const conversation = (this.conversations.get(connection) ?? this.nativeApplications.get(connection))!;
        const input = conversation.application;
        if (!input) return;
        agent.ctx.systemPrompt.section({ name: "localapp-application", order: 0, text: () => input.systemPrompt, complete: true });
        for (const tool of input.tools) {
          if (agent.ctx.tools.schemas().some((schema) => schema.name === tool.name)) continue;
          agent.ctx.tools.register({ ...tool, output: { schema: {}, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
            execute: (args, exec) => this.requestTool(conversation.userId, connection, tool.name, args, exec.callId, exec.signal, (event) => this.publish(connection, event)),
          });
        }
      });
      this.ctx.on("agent/status", ({ agent, status }) => this.publish(agent.id, { type: "status", running: status === "running" }));
      this.ctx.on("session/event", (session, event) => {
        if (!["user/message", "assistant/message", "tool/result"].includes(event.type)) return;
        this.publish(session.id, { type: "messages", messages: browserMessages(session.deriveMessages()) });
      });
      this.ctx.on("agent/error", ({ agent, error }) => {
        this.publish(agent.id, { type: "error", message: error instanceof Error ? error.message : String(error) });
      });
    })();
    this.timer = setInterval(() => { void this.expire(); }, 60_000);
    this.timer.unref();
  }

  async initialize() { await this.ready; }

  private async expire() {
    for (const [id, conversation] of this.conversations) {
      if (!conversation.busy && !this.watchers.get(id)?.size && !this.ctx.agents.list().some((agent) => agent.status === "running" && this.connectionFor(agent.id) === id) && Date.now() - conversation.touched > 30 * 60_000) {
        this.conversations.delete(id);
        await conversation.handle.dispose();
      }
    }
  }

  async run(userId: string, input: HarnessInput, emit: (event: unknown) => void, signal: AbortSignal) {
    await this.ready;
    if (signal.aborted) return;
    let conversation = this.conversations.get(input.sessionId);
    if (conversation && conversation.userId !== userId) throw new Error("Agent session belongs to another user");
    if (conversation?.busy || this.creating.has(input.sessionId)) throw new Error("Agent session is already running");
    let liveAgent=this.ctx.agents.get(SessionId(input.sessionId));
    if(liveAgent?.status==="running")throw new Error("Agent session is already running");
    if (!conversation) {
      if (this.conversations.size + this.creating.size >= 100 || [...this.conversations.values()].filter((c) => c.userId === userId).length >= 10) throw new Error("Too many agent sessions");
      this.creating.add(input.sessionId);
      try {
        const options = { agentOptions: { provider: "localapp", model: this.config.llmModel }, signal };
        const stored = this.config.root && await this.ctx.sessionPersistence.stat(SessionId(input.sessionId));
        if (!liveAgent && stored && this.nativeReady) {
          // A native follower may already be promoting this cold session.
          // Reuse the controller's deduplicated resume rather than opening
          // another persistence writer through the compatibility transport.
          liveAgent = await (await this.nativeReady).resolveAgent(input.sessionId);
        }
        // Native SessionController owns an already-live Agent's lifetime.
        // Reusing it must not acquire a second session write handle or dispose
        // the controller's Agent when this compatibility record expires.
        const handle = liveAgent ? {agent:liveAgent,dispose:async()=>{}} : stored
          ? await this.ctx.agents.resume({ ...options, resumeSessionId: SessionId(input.sessionId) })
          : await this.ctx.agents.create({ ...options, sessionId: SessionId(input.sessionId), ...(this.config.root ? { meta: { cwd: this.config.workspaceRoot ?? path.join(this.config.root, "workspace") } } : {}) });
        conversation = { userId, handle, registrations: [], busy: false, touched: Date.now() };
        this.conversations.set(input.sessionId, conversation);
      } finally { this.creating.delete(input.sessionId); }
    }
    if (this.nativeReady) {
      const previous = conversation.handle.agent.session.requestHeader()?.config;
      if (previous && (previous.provider !== "localapp" || previous.model !== this.config.llmModel)) {
        await (await this.nativeReady).gateway.invoke({ namespace: "session", method: "selectModel", args: { request: { sessionId: input.sessionId, provider: "localapp", model: this.config.llmModel } } });
      }
    }
    if (this.config.root) {
      fs.mkdirSync(this.config.root, { recursive: true, mode: 0o700 });
      const filename = path.join(this.config.root, "application-prompt.json");
      const temporary = `${filename}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ systemPrompt: input.systemPrompt }), { mode: 0o600 });
      fs.renameSync(temporary, filename);
    }
    conversation.application = input;
    this.nativeSessions.delete(input.sessionId);
    conversation.busy = true;
    conversation.emit = emit;
    const agent = conversation.handle.agent;
    const cancel = () => agent.cancel({ kind: "user" });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (const dispose of conversation.registrations.splice(0)) dispose();
      conversation.registrations.push(agent.ctx.systemPrompt.section({ name: this.config.root ? "localapp-application" : "localapp", order: 0, text: () => input.systemPrompt, complete: true }));
      const builtinNames = new Set(this.ctx.tools.schemas().map((t) => t.name));
      for (const tool of input.tools) {
        if (builtinNames.has(tool.name)) throw new Error(`Application tool conflicts with Harness tool: ${tool.name}`);
        conversation.registrations.push(agent.ctx.tools.register({ ...tool,
          output: { schema: {}, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
          execute: (args, exec) => this.requestTool(userId, input.sessionId, tool.name, args, exec.callId, exec.signal, emit),
        }));
      }
      if (this.config.root && input.prompt.startsWith("/")) {
        const command = await this.ctx.commands.execute(agent, input.prompt, [], signal);
        if (command) {
          emit({ type: "messages", messages: browserMessages(agent.session.deriveMessages()) });
          emit({ type: "command_result", result: command.result });
          await (this.ctx.sessions as unknown as Pick<SessionRegistry, "flush">).flush(agent.session);
          emit({ type: "done" });
          return;
        }
      }
      const needsLegacyTitle = this.config.autoSessionTitles && !this.ctx.sessionTitle.get(agent.session) && agent.session.deriveMessages().some(message => message.role === "user");
      agent.followup(createUserMessage({ content: [{ type: "text", text: input.prompt }], source: { kind: "user" } }));
      if (signal.aborted) cancel();
      await agent.whenIdle();
      if (needsLegacyTitle && !signal.aborted) await this.ctx.sessionTitle.refresh(agent.session, signal).catch(() => {});
      emit({ type: "messages", messages: browserMessages(agent.session.deriveMessages()) });
      if (this.config.root) await (this.ctx.sessions as unknown as Pick<SessionRegistry, "flush">).flush(agent.session);
      emit({ type: "done" });
    } finally {
      signal.removeEventListener("abort", cancel);
      conversation.busy = false;
      conversation.emit = undefined;
      conversation.touched = Date.now();
    }
  }

  private connectionFor(sessionId: string): string | undefined {
    let id = SessionId(sessionId);
    const agents = this.ctx.agents.list();
    for (let depth = 0; depth <= agents.length; depth++) {
      if (this.conversations.has(id) || this.nativeApplications.has(id)) return id;
      const owner = agents.find((agent) => this.ctx.agents.isOwnedBy(id, agent));
      if (!owner) return undefined;
      id = owner.id;
    }
    return undefined;
  }

  private publish(sessionId: string, event: unknown) {
    const foreground = this.conversations.get(sessionId)?.emit;
    if (foreground) foreground(event);
    else {
      const listeners = this.watchers.get(sessionId);
      const type = (event as { type?: string }).type;
      if (type === "tool_call" || type === "interaction") listeners?.values().next().value?.(event);
      else for (const emit of listeners ?? []) emit(event);
    }
  }

  subscribe(sessionId: string, emit: (event: unknown) => void) {
    const listeners = this.watchers.get(sessionId) ?? new Set();
    if (listeners.size >= 5 || !this.watchers.has(sessionId) && this.watchers.size >= 20) throw new Error("Too many Agent event connections");
    listeners.add(emit); this.watchers.set(sessionId, listeners);
    return () => { listeners.delete(emit); if (!listeners.size) this.watchers.delete(sessionId); };
  }

  cancel(userId: string, sessionId: string) {
    const conversation = this.conversations.get(sessionId);
    if (!conversation || conversation.userId !== userId) return false;
    conversation.handle.agent.cancel({ kind: "user" });
    return true;
  }

  private async restoreScheduledSession(id: string) {
    const live = this.ctx.agents.get(SessionId(id));
    if (live) return live;
    if (this.creating.has(id)) throw new Error("Conversation is being opened");
    const stored = await this.ctx.sessionPersistence.stat(SessionId(id));
    if (!stored || stored.header.origin === "subagent") throw new Error("Scheduled conversation not found");
    this.creating.add(id);
    try {
      const handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions: { provider: "localapp", model: this.config.llmModel } });
      this.conversations.set(id, { userId: this.config.ownerId ?? "", handle, registrations: [], busy: false, touched: Date.now() });
      return handle.agent;
    } finally { this.creating.delete(id); }
  }

  async listSessions() {
    await this.ready;
    if (!this.config.root) return [];
    const stored = await this.ctx.sessionPersistence.list();
    return Promise.all(stored.map(async (snapshot) => {
      const handle = await this.ctx.sessionPersistence.open(snapshot.header.id, "read");
      try {
        const { events } = await handle.read();
        const snapshotTitle = foldSessionTitle(events);
        const first = events.find(event => event.type === "user/message" && event.data.source.kind === "user");
        const firstText = first?.type === "user/message" ? first.data.content.filter(block => block.type === "text").map(block => block.text).join(" ") : "";
        return { id: snapshot.header.id, createdAt: snapshot.header.createdAt, title: snapshotTitle?.title ?? (fallbackSessionTitle(firstText, 8, 120) || "未命名对话") };
      } finally { await handle.close(); }
    }));
  }

  async history(sessionId: string) {
    await this.ready;
    const live = this.ctx.agents.get(SessionId(sessionId));
    if (live) return browserMessages(live.session.deriveMessages());
    const handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), "read");
    try {
      const { events } = await handle.read();
      const session = (await import("@deepseek-ai/dsh-session")).Session.create(SessionId(sessionId), events, handle.header, handle.inheritedEventCount);
      return browserMessages(session.deriveMessages());
    } finally { await handle.close(); }
  }

  private requestInteraction(userId: string, sessionId: string, detail: Record<string, unknown>, signal: AbortSignal, emit: (event: unknown) => void): Promise<any> {
    return new Promise((resolve, reject) => {
      const token = randomUUID();
      const cleanup = () => { clearTimeout(timer); this.pending.delete(token); signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(new Error("User interaction cancelled")); };
      const timer = setTimeout(abort, 10 * 60_000);
      this.pending.set(token, { userId, sessionId, resolve: (answer) => { cleanup(); resolve(answer); } });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      emit({ type: "interaction", token, ...detail });
    });
  }

  private requestTool(userId: string, sessionId: string, name: string, args: unknown, callId: string, signal: AbortSignal, emit: (event: unknown) => void): Promise<unknown> {
    const conversation = this.conversations.get(sessionId);
    const agent = conversation?.handle.agent ?? this.nativeApplications.get(sessionId)?.agent;
    if (this.config.root && agent && this.ctx.planMode.get(agent).active) return Promise.reject(new Error("计划模式中不能执行应用工具；请先退出计划模式"));
    if (!conversation?.emit && !this.watchers.get(sessionId)?.size) return Promise.reject(new Error("Keep the application open to execute its tools"));
    return new Promise((resolve, reject) => {
      const token = randomUUID();
      const finish = (value: unknown, error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(token);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(null, new Error("Tool call cancelled"));
      const timer = setTimeout(() => finish(null, new Error("Tool execution timed out")), 30_000);
      this.pending.set(token, { userId, sessionId, resolve: (value) => {
        const failure = value as { isError?: boolean; error?: string } | null;
        if (failure?.isError) finish(null, new Error(failure.error || "Tool execution failed"));
        else finish(value);
      } });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      this.publish(sessionId, { type: "tool_call", token, callId, name, args });
    });
  }

  result(userId: string, token: string, result: unknown): boolean {
    const pending = this.pending.get(token);
    if (!pending || pending.userId !== userId) return false;
    pending.resolve(result);
    return true;
  }

  async close() {
    clearInterval(this.timer);
    await this.ready.catch(() => {});
    await this.nativeReady?.catch(() => {});
    await Promise.all([...this.conversations.values()].map((c) => c.handle.dispose()));
    const cache = this.ctx.get("sessionProjectionCache");
    if (cache) {
      // Native Agents are owned by the controller and outlive compatibility
      // records. Persist their final projection cut before plugin disposal
      // removes the cache's event listeners.
      await Promise.all(this.ctx.sessions.list().map(session => cache.write(session)));
    }
    this.conversations.clear();
    this.nativeApplications.clear();
    for (const listeners of this.watchers.values()) for (const emit of listeners) emit({ type: "connection_closed" });
    this.watchers.clear();
    await this.ctx.fiber.dispose();
    this.disposed = true;
  }
}
