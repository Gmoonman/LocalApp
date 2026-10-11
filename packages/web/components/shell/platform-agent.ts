import { HarnessAgent, toChatMessages } from "@localapp/sdk-agent/harness-client";
import { useCallback, useEffect, useRef, useState } from "react";

// ---- System tools ----

const SYSTEM_TOOLS = [
  {
    name: "getCurrentUser",
    description: "Return the current signed-in user id and name, or null when unauthenticated.",
    parameters: { type: "object", properties: {} },
  },
];

const SYSTEM_TOOL_NAMES = new Set(SYSTEM_TOOLS.map((t) => t.name));

async function executeSystemTool(
  toolName: string,
  _args: Record<string, unknown>,
  _pagePath: string,
): Promise<{ result: unknown; isError?: boolean }> {
  try {
    if (toolName === "getCurrentUser") {
      const res = await fetch("/api/me", { credentials: "include" });
      const body = await res.json();
      if (!body.success || !body.data) return { result: null };
      return { result: { id: body.data.id, name: body.data.name } };
    }
    return { result: `Unknown system tool: ${toolName}`, isError: true };
  } catch (e: unknown) {
    return { result: e instanceof Error ? e.message : String(e), isError: true };
  }
}

// ---- Types ----

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
    status: "running" | "completed" | "timeout";
  }>;
}

interface ToolCallPending {
  resolve: (result: unknown, isError?: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface UsePlatformAgentOptions {
  appName: string;
  userName: string | undefined;
  pagePath: string;
  postToolCall: (message: { type: "localapp:tool_call"; callId: string; toolName: string; args: Record<string, unknown> }) => void;
  registeredToolsRef: React.RefObject<Array<{ name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] } }>>;
  systemHintRef: React.RefObject<string>;
}

export function usePlatformAgent({
  appName, userName, pagePath, postToolCall, registeredToolsRef, systemHintRef,
}: UsePlatformAgentOptions) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const pendingToolCalls = useRef(new Map<string, ToolCallPending>());

  // Send a tool_call to the app registry and wait for result
  const sendToolCallToApp = useCallback((callId: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ result: unknown; isError?: boolean }> => {
    return new Promise((resolve) => {
      const abort = () => {
        const pending = pendingToolCalls.current.get(callId);
        if (pending) { clearTimeout(pending.timeout); pendingToolCalls.current.delete(callId); }
        resolve({ result: "Agent cancelled", isError: true });
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      const finish = (result: unknown, isError?: boolean) => { signal?.removeEventListener("abort", abort); resolve({ result, isError }); };
      const timeout = setTimeout(() => {
        pendingToolCalls.current.delete(callId);
        finish("工具执行超时", true);
        setChatMessages((prev) =>
          prev.map((msg) => {
            if (msg.role !== "assistant" || !msg.toolCalls) return msg;
            return {
              ...msg,
              toolCalls: msg.toolCalls.map((tc) =>
                tc.id === callId
                  ? { ...tc, result: "工具执行超时", isError: true, status: "timeout" as const }
                  : tc
              ),
            };
          })
        );
      }, 30_000);

      pendingToolCalls.current.set(callId, { resolve: finish, timeout });
      postToolCall({ type: "localapp:tool_call", callId, toolName, args });
    });
  }, [postToolCall]);

  // Handle tool_result from the app runtime
  const handleToolResult = useCallback((callId: string, result: unknown, isError?: boolean) => {
    const pending = pendingToolCalls.current.get(callId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingToolCalls.current.delete(callId);
      pending.resolve(result, isError);
      setChatMessages((prev) =>
        prev.map((msg) => {
          if (msg.role !== "assistant" || !msg.toolCalls) return msg;
          return {
            ...msg,
            toolCalls: msg.toolCalls.map((tc) =>
              tc.id === callId
                ? { ...tc, result, isError, status: "completed" as const }
                : tc
            ),
          };
        })
      );
    }
  }, []);

  const agentRef = useRef<HarnessAgent | null>(null);
  const [harness, setHarness] = useState<HarnessAgent | null>(null);

  useEffect(() => () => {
    agentRef.current?.abort();
    agentRef.current = null;
    for (const pending of pendingToolCalls.current.values()) {
      clearTimeout(pending.timeout);
      pending.resolve("Agent cancelled", true);
    }
    pendingToolCalls.current.clear();
  }, [appName, pagePath]);

  useEffect(() => {
    const agent = new HarnessAgent({ initialState: { systemPrompt: "" }, appId: pagePath });
    agentRef.current = agent;
    setHarness(agent);
    setChatMessages([]);
    setAiError(null);
    const unsubscribe = agent.subscribe(() => {
      if (agentRef.current !== agent) return;
      setIsRunning(agent.state.isStreaming);
      setAiError(agent.state.errorMessage ?? null);
      setChatMessages(toChatMessages(agent.state.messages));
    });
    return () => { unsubscribe(); agent.dispose(); };
  }, [pagePath, userName]);

  const synchronizeContext = useCallback((agent: HarnessAgent | null = agentRef.current) => {
    if (!agent) return;
    agent.state.systemPrompt = [
      "你是一个运行在 LocalApp 应用中的 AI 助手。",
      `当前应用: ${appName}`,
      `当前用户: ${userName ?? "未登录"}`,
      systemHintRef.current,
      "当用户的需求可以映射到工具操作时，必须调用工具执行。",
      "请用中文回复用户。",
    ].filter(Boolean).join("\n");
    agent.state.tools = [...SYSTEM_TOOLS, ...(registeredToolsRef.current ?? []).filter((t) => !SYSTEM_TOOL_NAMES.has(t.name))].map((tool) => ({
      ...tool,
      execute: async (id, args, signal) => {
        const value = SYSTEM_TOOL_NAMES.has(tool.name)
          ? await executeSystemTool(tool.name, args, pagePath)
          : await sendToolCallToApp(id, tool.name, args, signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(value.result) ?? "null" }], details: value.result, isError: value.isError };
      },
    }));
  }, [appName, userName, pagePath, registeredToolsRef, systemHintRef, sendToolCallToApp]);
  useEffect(() => { synchronizeContext(); }, [harness, synchronizeContext]);

  const agentSend = useCallback(async (text: string) => {
    if (!text.trim() || agentRef.current?.state.isStreaming) return;
    let agent = agentRef.current;
    if (!agent) {
      agent = new HarnessAgent({ initialState: { systemPrompt: "" }, appId: pagePath });
      const current = agent;
      agent.subscribe(() => {
        if (agentRef.current !== current) return;
        setIsRunning(current.state.isStreaming);
        setAiError(current.state.errorMessage ?? null);
        setChatMessages(toChatMessages(current.state.messages));
      });
      agentRef.current = agent;
    }
    synchronizeContext(agent);
    await agent.prompt(text);
  }, [pagePath, synchronizeContext]);

  return { synchronizeContext, harness, chatMessages, setChatMessages, isRunning, aiError, agentSend, handleToolResult };
}

/** Keep the settings tool list available before a model request is sent. */
export function registerAgentToolCatalog(appId: string, tools: Array<{ name: string; description: string }>) {
  void fetch("/api/agent/app-tools", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appId, tools: [...SYSTEM_TOOLS, ...tools.filter((tool) => !SYSTEM_TOOL_NAMES.has(tool.name))].map(({ name, description }) => ({ name, description })) }) }).catch(() => {});
}
