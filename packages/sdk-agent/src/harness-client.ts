/** Browser transport for the DeepSeek Harness hosted by the LocalApp Server. */
export type AgentBlock = { type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
export type AgentMessage =
  | { role: "user"; content: string | AgentBlock[]; timestamp?: number }
  | { role: "assistant"; content: AgentBlock[]; [key: string]: unknown }
  | { role: "toolResult"; toolCallId: string; content: Array<{ type: "text"; text: string }>; isError: boolean; [key: string]: unknown };
export interface AgentTool {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean }>;
}
export interface AgentInteraction {
  token: string;
  kind: "approval" | "questions";
  toolName?: string;
  reason?: string;
  questions?: Array<{ id: string; question: string; detail?: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }>;
}
export type AgentEvent = { type: "agent_start" | "agent_end" | "message_end" | "message_update" | "tool_execution_start" | "tool_execution_end" | "session_title" };

export class HarnessAgent {
  readonly state: { systemPrompt: string; tools: AgentTool[]; messages: AgentMessage[]; isStreaming: boolean; errorMessage?: string; interactions: AgentInteraction[] };
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  private controller?: AbortController;
  private backgroundController?: AbortController;
  private backgroundEnabled = false;
  private backgroundConnection?: Promise<boolean>;
  constructor(options: { initialState: { systemPrompt: string }; proxyUrl?: string; appId?: string }) {
    this.state = { ...options.initialState, tools: [], messages: [], isStreaming: false, interactions: [] };
    this.proxyUrl = options.proxyUrl ?? "";
    const match = typeof window === "undefined" ? null : window.location.pathname.match(/^\/(?:serve\/)?([^/]+)\/([^/]+)\//);
    this.appId = options.appId ?? (match && !["my", "api"].includes(match[1]) ? `${match[1]}/${match[2]}` : "platform");
  }
  private readonly proxyUrl: string;
  readonly appId: string;
  providerId?: string;
  private async api(url: string, init?: RequestInit) {
    const response = await fetch(`${this.proxyUrl}/api/agent/${url}`, { credentials: "include", ...init });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.error || "Agent 请求失败");
    return body.data;
  }
  async registerTools() {
    if (this.appId === "platform") return;
    await this.api("app-tools", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appId: this.appId, tools: this.state.tools.map(({ name, description }) => ({ name, description })) }) });
  }
  /** Adopt this application's session in dsh and attach its browser tools. */
  async connectNativeSession(sessionId = this.sessionId): Promise<{ sessionId: string; url: string }> {
    if (this.state.isStreaming) throw new Error("请先停止当前会话");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("会话 ID 无效");
    if (!this.providerId) this.providerId = (await this.settings()).defaultProviderId;
    if (!this.providerId) throw new Error("请先配置模型供应商");
    const scope = btoa(JSON.stringify({ appId: this.appId, providerId: this.providerId })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const url = `${this.proxyUrl}/api/agent/native/${scope}/`;
    const response = await fetch(url + "api/session/create", { credentials: "include", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method: "session/create", payload: { args: { request: { sessionId } } } }) });
    const created = await response.json();
    if (!response.ok || !created.result?.ok || created.result.value?.sessionId !== sessionId) throw new Error(created.result?.error?.message || "原生会话连接失败");
    await this.api("native-context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, appId: this.appId, providerId: this.providerId, systemPrompt: this.state.systemPrompt, tools: this.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }) });
    this.sessionId = sessionId;
    this.state.interactions = [];
    this.startBackgroundEvents();
    if (!await this.backgroundConnection) throw new Error(this.state.errorMessage || "应用工具连接失败");
    return { sessionId, url };
  }
  settings(): Promise<{ providers: Array<{ id: string; name: string; model: string }>; defaultProviderId: string; settingsUrl?: string }> { return this.api("settings"); }
  listSessions(): Promise<Array<{ id: string; createdAt: number; title?: string }>> { return this.api(`sessions?${new URLSearchParams({ appId: this.appId, ...(this.providerId ? { providerId: this.providerId } : {}) })}`); }
  async selectSession(id: string) {
    if (this.state.isStreaming) return;
    this.state.messages = await this.api(`sessions/${encodeURIComponent(id)}?${new URLSearchParams({ appId: this.appId, ...(this.providerId ? { providerId: this.providerId } : {}) })}`);
    this.state.interactions = [];
    this.sessionId = id;
    this.restartBackgroundEvents();
    this.emit("message_update");
  }
  newSession() {
    if (this.state.isStreaming) return;
    this.sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    this.restartBackgroundEvents();
    this.state.messages = [];
    this.state.interactions = [];
    this.state.errorMessage = undefined;
    this.emit("message_update");
  }
  async answerInteraction(token: string, result: unknown) {
    await this.api("tool-result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, result }) });
    this.state.interactions = this.state.interactions.filter((interaction) => interaction.token !== token);
    this.emit("message_update");
  }
  subscribe(listener: (event: AgentEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(type: AgentEvent["type"]) { for (const listener of this.listeners) listener({ type }); }
  abort() {
    this.controller?.abort();
    void this.api("cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: this.sessionId, appId: this.appId, providerId: this.providerId }) }).catch((error) => { this.state.errorMessage = error.message; this.emit("message_update"); });
  }
  dispose() { this.controller?.abort(); this.stopBackgroundEvents(); }
  startBackgroundEvents() { this.backgroundEnabled = true; this.restartBackgroundEvents(); }
  stopBackgroundEvents() { this.backgroundEnabled = false; this.backgroundController?.abort(); this.backgroundController = undefined; }
  private restartBackgroundEvents() {
    if (!this.backgroundEnabled) return;
    this.backgroundController?.abort();
    const controller = new AbortController();
    this.backgroundController = controller;
    let connected!: (ready: boolean) => void;
    this.backgroundConnection = new Promise<boolean>(resolve => { connected = resolve; });
    void this.readBackgroundEvents(controller, () => connected(true)).catch((error) => {
      if (!controller.signal.aborted) { this.state.errorMessage = error instanceof Error ? error.message : String(error); this.emit("message_update"); }
    }).finally(() => connected(false));
  }
  private async readBackgroundEvents(controller: AbortController, connected?: () => void) {
    const query = new URLSearchParams({ sessionId: this.sessionId, appId: this.appId, ...(this.providerId ? { providerId: this.providerId } : {}) });
    const response = await fetch(`${this.proxyUrl}/api/agent/events?${query}`, { credentials: "include", signal: controller.signal });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Agent 连接失败: ${response.status}`);
    if (!response.body) throw new Error("Agent response body is empty");
    connected?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const event = JSON.parse(line.slice(5));
          if (event.type === "connection_closed") {
            if (this.backgroundEnabled && !controller.signal.aborted) {
              const settings = await this.settings();
              if (!settings.providers.some((provider) => provider.id === this.providerId)) this.providerId = settings.defaultProviderId;
              if (settings.providers.length) this.restartBackgroundEvents();
            }
            return;
          }
          if (event.type === "status" && !this.controller) { this.state.isStreaming = event.running; this.emit(event.running ? "agent_start" : "agent_end"); }
          if (event.type === "error") { this.state.errorMessage = event.message; this.emit("message_update"); }
          this.handleEvent(event, controller.signal);
        }
        if (done) break;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  private handleEvent(event: any, signal: AbortSignal) {
    if (event.type === "session_title") this.emit("session_title");
    if (event.type === "command_result") {
      this.state.messages.push({ role: "assistant", content: [{ type: "text", text: event.result.text ?? "操作已完成" }] });
      this.emit("message_update");
    }
    if (event.type === "interaction") { this.state.interactions.push(event); this.emit("message_update"); }
    if (event.type === "messages") { this.state.messages = event.messages; this.emit("message_end"); }
    if (event.type === "assistant_start") { this.state.messages.push({ role: "assistant", content: [] }); this.emit("message_update"); }
    if (event.type === "text_delta") {
      const last = this.state.messages[this.state.messages.length - 1];
      if (last?.role === "assistant") {
        const block = last.content.find((b) => b.type === "text");
        if (block?.type === "text") block.text += event.text;
        else last.content.push({ type: "text", text: event.text });
        this.emit("message_update");
      }
    }
    if (event.type === "tool_call") {
      void this.executeTool(event, signal).catch((error) => {
        if (!signal.aborted) { this.state.errorMessage = error instanceof Error ? error.message : String(error); this.controller?.abort(); }
      });
    }
  }

  async prompt(text: string): Promise<void> {
    if (this.state.isStreaming || !text.trim()) return;
    const controller = new AbortController();
    this.controller = controller;
    this.state.isStreaming = true;
    this.state.errorMessage = undefined;
    this.state.messages.push({ role: "user", content: text });
    this.emit("agent_start");
    this.emit("message_update");
    try {
      const res = await fetch(`${this.proxyUrl}/api/agent/run`, {
        method: "POST", credentials: "include", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionId, appId: this.appId, providerId: this.providerId, prompt: text, systemPrompt: this.state.systemPrompt,
          tools: this.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(res.status === 401 ? "请先登录" : body.error || `Agent 请求失败: ${res.status}`);
      }
      if (!res.body) throw new Error("Agent response body is empty");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          if (done && buffer) { lines.push(buffer); buffer = ""; }
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const event = JSON.parse(line.slice(5));
            if (event.type === "error") throw new Error(event.message);
            if (event.type === "done") { completed = true; continue; }
            this.handleEvent(event, controller.signal);
          }
          if (done) break;
        }
        if (!completed) throw new Error("Agent stream ended before completion");
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) {
      if (!controller.signal.aborted) this.state.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      controller.abort();
      // Page tools may ignore cancellation; transport settles without waiting on them.
      this.state.isStreaming = false;
      this.state.interactions = [];
      this.controller = undefined;
      this.emit("agent_end");
    }
  }

  private async executeTool(event: { token: string; callId?: string; name: string; args: Record<string, unknown> }, signal: AbortSignal) {
    this.emit("tool_execution_start");
    const tool = this.state.tools.find((t) => t.name === event.name);
    let result: unknown;
    try {
      if (!tool) throw new Error(`Unknown tool: ${event.name}`);
      const value = await tool.execute(event.callId ?? event.token, event.args, signal);
      if (value.isError) result = { isError: true, error: value.content.map((b) => b.text).join("\n") };
      else if (value.details !== undefined) result = value.details;
      else result = value.content.map((b) => b.text).join("\n");
    } catch (error) { result = { isError: true, error: error instanceof Error ? error.message : String(error) }; }
    if (signal.aborted) return;
    const res = await fetch(`${this.proxyUrl}/api/agent/tool-result`, { method: "POST", credentials: "include", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: event.token, result: result ?? null }) });
    if (!res.ok) throw new Error(`Tool result rejected: ${res.status}`);
    this.emit("tool_execution_end");
  }
}

export interface BrowserChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown>; result?: unknown; isError?: boolean; status: "running" | "completed" | "timeout" }>;
}

export function toChatMessages(messages: AgentMessage[]): BrowserChatMessage[] {
  const results = new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
  return messages.filter((m) => m.role !== "toolResult").map((m) => ({
    role: m.role as "user" | "assistant",
    content: typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    ...(m.role === "assistant" ? { toolCalls: m.content.filter((b) => b.type === "toolCall").map((b) => {
      const result = results.get(b.id);
      const text = result?.content.map((v) => v.text).join("\n");
      let value: unknown = text;
      try { if (text) value = JSON.parse(text); } catch {}
      return { id: b.id, name: b.name, args: b.arguments, result: value, isError: result?.isError, status: result ? "completed" as const : "running" as const };
    }) } : {}),
  }));
}
