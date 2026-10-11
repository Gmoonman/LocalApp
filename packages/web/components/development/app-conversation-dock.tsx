"use client";
import { Suspense, lazy, useEffect, useState } from "react";
import type { HarnessAgent } from "@localapp/sdk-agent/harness-client";
import { AgentInteractionCard } from "./agent-interaction-card";
const DevelopmentPage = lazy(() => import("./development-page").then(module => ({ default: module.DevelopmentPage })));
import { AppDevelopmentDock } from "./app-development-dock";
import type { DevelopmentShellProps } from "@localapp/dsh-agent-ui/ui/conversation-types";

/** Both identities retain their own transport, messages, draft and history. */
export function AppConversationDock({ application, isOwner, agent, onSend, reveal = 0, minimize = 0, onVisibilityChange, onPreview }: {
  onPreview?: (url: string | null) => void;
  application: { owner: string; name: string };
  isOwner: boolean;
  agent: HarnessAgent | null;
  onSend: (text: string) => Promise<void>;
  reveal?: number;
  minimize?: number;
  onVisibilityChange?: (visible: boolean) => void;
}) {
  const [ui, setUI] = useState<{enabled:boolean;developer:boolean} | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/agent/ui", {credentials:"include",signal:controller.signal})
      .then(response => response.ok ? response.json() : null)
      .then(result => {if(!controller.signal.aborted)setUI({enabled:result?.data?.enabled === true,developer:result?.data?.identities?.some((item:{id:string})=>item.id === "developer") === true});})
      .catch(() => {if(!controller.signal.aborted)setUI({enabled:false,developer:false});});
    return () => controller.abort();
  }, []);
  const canDevelop = isOwner && ui?.developer === true;
  const [identity, setIdentity] = useState<"developer" | "user">(isOwner ? "developer" : "user");
  const [prompt, setPrompt] = useState("");
  const [providers, setProviders] = useState<DevelopmentShellProps["providers"]>([]);
  const [sessions, setSessions] = useState<DevelopmentShellProps["sessions"]>([]);
  const [pending, setPending] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [, update] = useState(0);
  useEffect(() => {
    if (!agent) return;
    let active = true;
    const refresh = async () => {
      try {
        const rows = await agent.listSessions();
        if (active) setSessions(rows.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })));
      } catch (error) { if (active) setError((error as Error).message); }
    };
    void agent.settings().then(settings => {
      if (!active) return;
      setProviders(settings.providers);
      agent.providerId ??= settings.defaultProviderId;
      if (settings.providers.length) { agent.startBackgroundEvents(); void refresh(); }
      update(n => n + 1);
    }).catch(error => { if (active) setError(error.message); });
    const unsubscribe = agent.subscribe(event => {
      if (!active) return;
      update(n => n + 1);
      if (event.type === "agent_end" || event.type === "session_title") void refresh();
    });
    return () => { active = false; unsubscribe(); };
  }, [agent]);
  useEffect(() => {if (identity === "user") onPreview?.(null);}, [identity]);
  useEffect(() => { if (reveal) setIdentity("user"); }, [reveal]);
  const act = async (operation: () => Promise<void>) => {
    setPending(true); setError("");
    try { await operation(); } catch (error) { setError((error as Error).message); }
    finally { setPending(false); update(n => n + 1); }
  };
  const noop = () => {};
  const conversation: DevelopmentShellProps = {
    project: { id: agent?.appId ?? "application", name: application.name }, projects: [],
    files: [], file: null, text: "", prompt, sessions,
    selectedSession: agent && sessions.some(row => row.id === agent.sessionId) ? agent.sessionId : "",
    messages: agent?.state.messages ?? [], live: "", running: agent?.state.isStreaming ?? false,
    pending, error: error || agent?.state.errorMessage || "", versions: [], version: "", changes: [],
    providers, provider: agent?.providerId ?? "", build: null, log: "",
    interaction: null, answer: "",
    actions: {
      select: noop, create: noop, open: noop, setText: noop, save: noop,
      setPrompt, run: () => { const text = prompt.trim(); if (!text || !agent) return; setPrompt(""); void act(() => onSend(text)); },
      stop: () => agent?.abort(),
      setProvider: value => { if (!agent || agent.state.isStreaming) return; agent.providerId = value; agent.newSession(); setSessions([]); setError(""); void act(async () => { setSessions((await agent.listSessions()).map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }))); }); },
      newSession: () => { agent?.newSession(); setPrompt(""); setError(""); update(n => n + 1); },
      selectSession: id => { if (agent) void act(() => agent.selectSession(id)); },
      setVersion: noop, diff: noop, restore: noop, build: noop, preview: noop, publish: noop, cancelBuild: noop, newFile: noop,
      setAnswer: noop, respond: noop,
    },
  };
  const dock = { identity: canDevelop ? identity : "user" as const, userConversation: conversation, nativeUserAgent:agent??undefined,
    onIdentityChange: canDevelop ? setIdentity : undefined, reveal, minimize, onVisibilityChange, onPreview,
    userInteractions: agent?.state.interactions.map(interaction => <AgentInteractionCard key={interaction.token} interaction={interaction} pending={answering === interaction.token}
      answer={result => {
        setAnswering(interaction.token);
        void act(() => agent.answerInteraction(interaction.token, result)).finally(() => setAnswering(null));
      }} />) };
  if(!ui?.enabled) return null;
  return canDevelop
    ? <Suspense fallback={<p role="status">正在打开开发工作区…</p>}><DevelopmentPage application={application} dock={dock} /></Suspense>
    : <AppDevelopmentDock {...conversation} {...dock} application={application} />;
}
