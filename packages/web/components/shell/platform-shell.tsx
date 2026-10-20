"use client";

import {installPreviewPageContext} from "../development/page-context";
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {DevelopmentPreviewBar} from "./development-preview-bar";
import { Navbar, type PlatformEditSession, type PresenceSnapshot } from "./navbar";
import { IssuesModal } from "./issues-modal";
import { AppConversationDock } from "../development/app-conversation-dock";
import { NotificationBell } from "./notification-bell";
import { usePlatformAgent, registerAgentToolCatalog } from "./platform-agent";
import { useAuthModals } from "@/components/auth-modals/auth-provider";
import { Button } from "@/components/ui/button";
import { CircleAlert, CircleOff, RefreshCw, Settings } from "lucide-react";
import { rewriteNativeAppCssUrls, scopeNativeAppCss } from "./app-css-scope";
import { resolveNativeAppResourceBase, resolveNativeAppUrl } from "./app-resource-base";
import { readIssueDeepLinkId, readIssueDeepLinkNumber, readIssuesWorkspaceOpen, updateIssueDeepLinkUrl, updateIssueNumberDeepLinkUrl, updateIssuesWorkspaceUrl } from "./issue-deep-link";
import { listIssues } from "./issue-api";
import { DEFAULT_ISSUE_LIST_QUERY } from "./issue-list-query";
import { EditingAwarenessOverlay, type EditingOverlayPeer } from "./editing-awareness-overlay";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEditingOverlayPeer(value: unknown): value is EditingOverlayPeer {
  if (!isObject(value) || typeof value.clientId !== "string" || !isObject(value.user) || !isObject(value.editing)) return false;
  return typeof value.user.id === "string"
    && typeof value.user.name === "string"
    && (value.user.displayName === null || typeof value.user.displayName === "string")
    && typeof value.user.color === "string"
    && typeof value.editing.surfaceId === "string"
    && (value.editing.fieldId === undefined || typeof value.editing.fieldId === "string");
}

function focusBusyPlatformIssueAttachmentQueue(): boolean {
  const queue = document.querySelector<HTMLElement>('[data-localapp-issues-workspace] [data-localapp-issue-attachment-queue][aria-busy="true"]');
  if (!queue) return false;
  queue.focus();
  queue.scrollIntoView?.({ block: "nearest" });
  return true;
}

function restorePlatformIssueWorkspaceHistoryUrl(source: URL, issueId: number | null, issueNumber: number | null): URL {
  const workspaceUrl = updateIssuesWorkspaceUrl(source, true);
  if (issueId !== null) return updateIssueDeepLinkUrl(workspaceUrl, issueId);
  if (issueNumber !== null) return updateIssueNumberDeepLinkUrl(workspaceUrl, issueNumber);
  return workspaceUrl;
}
function isRegisterToolsMessage(v: unknown) { return isObject(v) && v.type === "localapp:register_tools"; }
function isAiCustomModeMessage(v: unknown) { return isObject(v) && v.type === "localapp:ai_custom_mode"; }
function isToolResultMessage(v: unknown) { return isObject(v) && v.type === "localapp:tool_result"; }
function isPlatformRequestMessage(v: unknown) {
  return isObject(v) && v.type === "localapp:platform_request" && typeof v.id === "string" && typeof v.capability === "string";
}

interface UserData { id: string; name: string; displayName?: string | null; avatarUrl?: string | null; }
interface PageMeta { developmentVerification?:boolean; developmentPreview?: boolean; developmentParentOrigin?:string; name: string; userId: string; description?: string; shell?: { navbar?: boolean; agentConversation?: boolean }; notify?: { enabled?: boolean }; lifecycleStatus?: "online" | "offline"; }
type PresenceSnapshotEvent = {
  type?: "presence:snapshot";
  data?: Partial<PresenceSnapshot> & {
    appOwner?: string;
    appName?: string;
    count?: number;
  };
};

type AiMode = "system" | "custom" | null;
type PlatformRequestMessage = {
  type: "localapp:platform_request";
  id: string;
  capability: string;
  payload?: unknown;
};
type ConfirmDialogState = {
  id: string;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  tone: "default" | "danger";
};
type ToolCallMessage = {
  type: "localapp:tool_call";
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
};
type NativeToolExecute = (args: Record<string, unknown>) => Promise<unknown>;
type NativeToolRegistry = {
  registerTools(
    tools: Array<{ name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] } }>,
    executeFns: Record<string, NativeToolExecute>,
    systemHint?: string,
  ): void | (() => void);
};

const NATIVE_TOOL_REGISTRY_KEY = "__localapp_platform_tool_registry__";
const PLATFORM_EDIT_SESSION_REGISTRY_KEY = "__localapp_platform_edit_session_registry__";
const CRDT_EDITING_AWARENESS_EVENT = "localapp:crdt-editing-awareness";

type NativeRegistryGlobal = typeof globalThis & {
  __localapp_platform_tool_registry__?: NativeToolRegistry | null;
  __localapp_platform_edit_session_registry__?: PlatformEditSessionRegistry | null;
};

type PlatformEditSessionRegistry = {
  registerEditSession(session: PlatformEditSession): () => void;
};

function payloadObject(payload: unknown): Record<string, unknown> {
  return isObject(payload) ? payload : {};
}

function downloadFromShell(payload: unknown) {
  const body = payloadObject(payload);
  const filename = typeof body.filename === "string" && body.filename.trim() ? body.filename : "download";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream";
  const data = body.data;
  const blob = data instanceof Blob
    ? data
    : data instanceof ArrayBuffer
      ? new Blob([data], { type: mimeType })
      : new Blob([typeof data === "string" ? data : JSON.stringify(data ?? "")], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

export function PlatformShell({ userId, name }: { userId: string; name: string }) {
  const router = useRouter();
  const { openLogin } = useAuthModals();
  const [user, setUser] = useState<UserData | null>(null);
  const [ready, setReady] = useState(false);
  const [developmentEnabled, setDevelopmentEnabled] = useState<boolean | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  useEffect(() => installPreviewPageContext(meta?.developmentParentOrigin,meta?.developmentVerification===true), [meta?.developmentParentOrigin,meta?.developmentVerification]);
  const [favCount, setFavCount] = useState(0);
  const [isFavorited, setIsFavorited] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(() => typeof window === "undefined" ? null : readIssueDeepLinkId(new URL(window.location.href)));
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | null>(() => typeof window === "undefined" ? null : readIssueDeepLinkNumber(new URL(window.location.href)));
  const [showIssues, setShowIssues] = useState(() => typeof window !== "undefined" && readIssuesWorkspaceOpen(new URL(window.location.href)));
  const selectedIssueIdRef = useRef(selectedIssueId);
  const selectedIssueNumberRef = useRef(selectedIssueNumber);
  selectedIssueIdRef.current = selectedIssueId;
  selectedIssueNumberRef.current = selectedIssueNumber;
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [developmentPreviewUrl, setDevelopmentPreviewUrl] = useState<string | null>(null);
  const [appLoadError, setAppLoadError] = useState<string | null>(null);
  const [editSession, setEditSession] = useState<PlatformEditSession | null>(null);
  const [presenceSnapshot, setPresenceSnapshot] = useState<PresenceSnapshot | null>(null);
  const [editingSources, setEditingSources] = useState<Record<string, EditingOverlayPeer[]>>({});
  const [openIssueCount, setOpenIssueCount] = useState<number | null>(null);
  const openIssueCountRequestRef = useRef(0);
  const pagePath = `${userId}/${name}`;
  const nativeAppResourceBase = resolveNativeAppResourceBase(pagePath);
  const nativeAppLoadKey = `${nativeAppResourceBase}|${pagePath}`;
  const metaMatchesCurrentApp = meta?.name === name && meta?.userId === userId;
  const agentConversationEnabled = metaMatchesCurrentApp && meta.shell?.agentConversation === true;
  const appOnline = metaMatchesCurrentApp && meta.lifecycleStatus === "online";
  const appOffline = metaMatchesCurrentApp && meta.lifecycleStatus === "offline";
  const isOwner = user?.id === userId;
  const developerConversationEnabled = metaMatchesCurrentApp && isOwner && developmentEnabled === true;
  const conversationDockEnabled = agentConversationEnabled || developerConversationEnabled;
  useEffect(() => {
    let active = true;
    fetch("/api/system/plugins").then(response => {
      if (!response.ok) throw new Error("Plugin status unavailable");
      return response.json();
    }).then(result => {
      if (active) setDevelopmentEnabled(result.success === true && result.data?.development === true);
    }).catch(() => { if (active) setDevelopmentEnabled(false); });
    return () => { active = false; };
  }, []);
  const editingPeers = Object.values(editingSources).flat();

  const [aiMode, setAiMode] = useState<AiMode>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [agentReveal, setAgentReveal] = useState(0);
  const [agentMinimize, setAgentMinimize] = useState(0);
  const [developerReveal, setDeveloperReveal] = useState(0);
  const aiVisible = useRef(false);
  const showAgent = () => { if (!agentConversationEnabled) return; aiVisible.current = true; setAiOpen(true); setAgentReveal(value => value + 1); };
  const hideAgent = () => { aiVisible.current = false; setAiOpen(false); setAgentMinimize(value => value + 1); };
  useEffect(() => {
    if (!conversationDockEnabled) {
      aiVisible.current = false;
      setAiOpen(false);
      setDevelopmentPreviewUrl(null);
    }
  }, [conversationDockEnabled]);

  const nativeAppLoadedRef = useRef<string | null>(null);
  const registeredToolsRef = useRef<Array<{ name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] } }>>([]);
  const executeToolsRef = useRef<Map<string, NativeToolExecute>>(new Map());
  const systemHintRef = useRef<string>("");
  const editSessionRef = useRef<PlatformEditSession | null>(null);

  const navigateToIssue = useCallback((issueId: number | null, mode: "push" | "replace" = "push") => {
    const url = updateIssueDeepLinkUrl(new URL(window.location.href), issueId);
    window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state, "", url);
    setSelectedIssueId(issueId);
    setSelectedIssueNumber(null);
    setShowIssues(issueId !== null || showIssues);
  }, [showIssues]);

  const closeIssues = useCallback(() => {
    const url = updateIssuesWorkspaceUrl(new URL(window.location.href), false);
    window.history.replaceState(window.history.state, "", url);
    setSelectedIssueId(null);
    setSelectedIssueNumber(null);
    setShowIssues(false);
  }, []);

  const openIssues = useCallback(() => {
    const url = updateIssuesWorkspaceUrl(new URL(window.location.href), true);
    window.history.pushState(window.history.state, "", url);
    setShowIssues(true);
  }, []);

  useEffect(() => {
    const syncIssueNavigation = () => {
      const targetUrl = new URL(window.location.href);
      const nextOpen = readIssuesWorkspaceOpen(targetUrl);
      if (!nextOpen && focusBusyPlatformIssueAttachmentQueue()) {
        const restoredUrl = restorePlatformIssueWorkspaceHistoryUrl(targetUrl, selectedIssueIdRef.current, selectedIssueNumberRef.current);
        window.history.pushState(window.history.state, "", restoredUrl);
        return;
      }
      const issueId = readIssueDeepLinkId(targetUrl);
      const issueNumber = readIssueDeepLinkNumber(targetUrl);
      setSelectedIssueId(issueId);
      setSelectedIssueNumber(issueNumber);
      setShowIssues(nextOpen);
    };
    window.addEventListener("popstate", syncIssueNavigation);
    return () => window.removeEventListener("popstate", syncIssueNavigation);
  }, []);

  const postToolCall = useCallback((message: ToolCallMessage) => {
    const execute = executeToolsRef.current.get(message.toolName);
    if (!execute) {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: "localapp:tool_result",
          callId: message.callId,
          result: `Unknown tool: ${message.toolName}`,
          isError: true,
        },
        origin: window.location.origin,
      }));
      return;
    }

    void Promise.resolve(execute(message.args))
      .then((result) => {
        window.dispatchEvent(new MessageEvent("message", {
          data: { type: "localapp:tool_result", callId: message.callId, result, isError: false },
          origin: window.location.origin,
        }));
      })
      .catch((error) => {
        window.dispatchEvent(new MessageEvent("message", {
          data: {
            type: "localapp:tool_result",
            callId: message.callId,
            result: error instanceof Error ? error.message : String(error),
            isError: true,
          },
          origin: window.location.origin,
        }));
      });
  }, []);

  const { harness, agentSend, handleToolResult, synchronizeContext } = usePlatformAgent({
    enabled: agentConversationEnabled,
    appName: name,
    userName: user?.name,
    pagePath,
    postToolCall,
    registeredToolsRef,
    systemHintRef,
  });

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setMeta(null);
    Promise.all([
      fetch("/api/me", { credentials: "include" }).then((r) => r.json()).catch(() => null),
      fetch(`/api/pages/${userId}/${name}/meta`, { credentials: "include" }).then((r) => r.json()).catch(() => null),
    ]).then(([meBody, metaBody]) => {
      if (cancelled) return;
      if (meBody?.success && meBody.data) setUser(meBody.data);
      if (metaBody?.success && metaBody.data) setMeta(metaBody.data);
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [userId, name]);

  useEffect(() => {
    const global = globalThis as NativeRegistryGlobal;
    const previousRegistry = global[NATIVE_TOOL_REGISTRY_KEY];
    global[NATIVE_TOOL_REGISTRY_KEY] = {
      registerTools: (tools, executeFns, systemHint) => {
        registeredToolsRef.current = tools;
        registerAgentToolCatalog(pagePath, tools);
        executeToolsRef.current = new Map(Object.entries(executeFns));
        systemHintRef.current = systemHint || "";
        synchronizeContext();
        setAiMode("system");

        return () => {
          registeredToolsRef.current = [];
          executeToolsRef.current = new Map();
          systemHintRef.current = "";
          synchronizeContext();
        };
      },
    };

    return () => {
      global[NATIVE_TOOL_REGISTRY_KEY] = previousRegistry ?? null;
    };
  }, [synchronizeContext]);

  useEffect(() => {
    const global = globalThis as NativeRegistryGlobal;
    const previousRegistry = global[PLATFORM_EDIT_SESSION_REGISTRY_KEY];
    global[PLATFORM_EDIT_SESSION_REGISTRY_KEY] = {
      registerEditSession: (session) => {
        editSessionRef.current = session;
        setEditSession(session);

        return () => {
          if (editSessionRef.current !== session) return;
          editSessionRef.current = null;
          setEditSession(null);
        };
      },
    };

    return () => {
      global[PLATFORM_EDIT_SESSION_REGISTRY_KEY] = previousRegistry ?? null;
      editSessionRef.current = null;
      setEditSession(null);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const session = editSessionRef.current;
      if (!session || session.busy) return;
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;

      if (key === "s" && session.canSave) {
        event.preventDefault();
        void session.onSave();
        return;
      }

      if (isEditableShortcutTarget(event.target)) return;

      if (key === "z" && event.shiftKey && session.canRedo) {
        event.preventDefault();
        void session.onRedo();
        return;
      }
      if (key === "z" && !event.shiftKey && session.canUndo) {
        event.preventDefault();
        void session.onUndo();
        return;
      }
      if (key === "y" && session.canRedo) {
        event.preventDefault();
        void session.onRedo();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    fetch(`/api/favorites/count?pagePath=${encodeURIComponent(pagePath)}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { if (d.success) setFavCount(d.data?.count ?? 0); })
      .catch(() => {});
  }, [pagePath]);

  const refreshOpenIssueCount = useCallback(async () => {
    const requestId = ++openIssueCountRequestRef.current;
    try {
      const response = await listIssues(pagePath, { ...DEFAULT_ISSUE_LIST_QUERY, status: "open", limit: 1 });
      if (requestId !== openIssueCountRequestRef.current) return;
      const open = response.meta.open;
      setOpenIssueCount(typeof open === "number" && Number.isFinite(open) && open >= 0 ? open : response.data.length);
    } catch {
      // Keep the last trusted count until a later refresh succeeds.
    }
  }, [pagePath]);

  useEffect(() => {
    void refreshOpenIssueCount();
  }, [refreshOpenIssueCount]);

  useEffect(() => {
    if (!user) return;
    fetch(`/api/favorites/check?pagePath=${encodeURIComponent(pagePath)}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { if (d.success) setIsFavorited(d.data?.favorited ?? false); })
      .catch(() => {});
  }, [pagePath, user]);

  useEffect(() => {
    if (!ready || !appOnline || meta?.developmentPreview) return;
    if (typeof EventSource === "undefined") return;
    const clientId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const presenceBody = JSON.stringify({ clientId });
    const heartbeatUrl = `/serve/${pagePath}/api/presence/heartbeat`;
    const leaveUrl = `/serve/${pagePath}/api/presence/leave`;
    let events: EventSource | null = null;
    let windowActive = true;
    function handlePresenceSnapshot(event: MessageEvent) {
      try {
        const parsed = JSON.parse(event.data) as PresenceSnapshotEvent;
        const count = parsed.data?.count;
        const anonymousCount = parsed.data?.anonymousCount;
        const authenticatedUsers = parsed.data?.authenticatedUsers;
        if (Number.isFinite(count) && Number.isFinite(anonymousCount) && Array.isArray(authenticatedUsers)) {
          setPresenceSnapshot({
            count: Math.max(0, Number(count)),
            anonymousCount: Math.max(0, Number(anonymousCount)),
            authenticatedUsers,
          });
        }
      } catch {
        // Ignore malformed presence events; the next valid event will refresh the count.
      }
    }
    const disconnect = () => {
      events?.close();
      events = null;
    };
    const heartbeat = () => {
      void fetch(heartbeatUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: presenceBody,
        keepalive: true,
      }).catch(() => {});
    };
    const leave = () => {
      const payload = new Blob([presenceBody], { type: "application/json" });
      if (navigator.sendBeacon?.(leaveUrl, payload)) return;
      void fetch(leaveUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: presenceBody,
        keepalive: true,
      }).catch(() => {});
    };
    const connect = () => {
      if (document.visibilityState === "hidden" || !windowActive || events) return;
      events = new EventSource(`/serve/${pagePath}/api/presence/events?clientId=${encodeURIComponent(clientId)}`);
      events.addEventListener("presence:snapshot", handlePresenceSnapshot);
    };
    const handleVisibilityChange = () => {
      heartbeat();
      if (document.visibilityState === "hidden") disconnect();
      else connect();
    };
    const handleWindowBlur = () => { windowActive = false; heartbeat(); disconnect(); };
    const handleWindowFocus = () => { windowActive = true; heartbeat(); connect(); };
    const handlePageHide = () => { windowActive = false; disconnect(); leave(); };
    const handlePageShow = () => { windowActive = true; heartbeat(); connect(); };
    heartbeat();
    connect();
    const heartbeatTimer = window.setInterval(heartbeat, 30_000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.clearInterval(heartbeatTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      disconnect();
      leave();
    };
  }, [appOnline, pagePath, ready, meta?.developmentPreview]);

  useEffect(() => {
    setEditingSources({});
    if (!ready || !appOnline || meta?.developmentPreview) return;
    const onAwareness = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!isObject(detail) || typeof detail.sourceId !== "string" || detail.sourceId.length > 400 || !Array.isArray(detail.peers)) return;
      const sourceId = detail.sourceId;
      const peers = detail.peers.filter(isEditingOverlayPeer).slice(0, 128);
      setEditingSources((current) => {
        if (peers.length === 0) {
          if (!(sourceId in current)) return current;
          const next = { ...current };
          delete next[sourceId];
          return next;
        }
        if (!(sourceId in current) && Object.keys(current).length >= 128) return current;
        return { ...current, [sourceId]: peers };
      });
    };
    window.addEventListener(CRDT_EDITING_AWARENESS_EVENT, onAwareness);
    return () => window.removeEventListener(CRDT_EDITING_AWARENESS_EVENT, onAwareness);
  }, [appOnline, pagePath, ready, meta?.developmentPreview]);

  useEffect(() => {
    if (!ready || !appOnline || nativeAppLoadedRef.current === nativeAppLoadKey) return;
    nativeAppLoadedRef.current = nativeAppLoadKey;
    setAppLoadError(null);

    let cancelled = false;
    const loadedNodes: HTMLElement[] = [];

    async function loadNativeApp() {
      try {
        const res = await fetch(nativeAppResourceBase, { credentials: "include" });
        if (!res.ok) throw new Error(`App index request failed: ${res.status}`);
        const html = await res.text();
        if (cancelled) return;

        const documentHtml = new DOMParser().parseFromString(html, "text/html");
        const stylesheets = Array.from(documentHtml.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'));
        const moduleScripts = Array.from(documentHtml.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'));

        for (const link of stylesheets) {
          const href = resolveNativeAppUrl(nativeAppResourceBase, link.getAttribute("href") ?? "");
          if (!href || document.querySelector(`[data-localapp-app-asset="${href}"]`)) continue;
          const cssRes = await fetch(href, { credentials: "include" });
          if (!cssRes.ok) throw new Error(`App stylesheet request failed: ${cssRes.status}`);
          const rawCss = await cssRes.text();
          const node = document.createElement("style");
          node.textContent = scopeNativeAppCss(rewriteNativeAppCssUrls(rawCss, href));
          node.setAttribute("data-localapp-app-asset", href);
          node.setAttribute("data-localapp-app-stylesheet", "true");
          document.head.appendChild(node);
          loadedNodes.push(node);
        }

        for (const script of moduleScripts) {
          const src = resolveNativeAppUrl(nativeAppResourceBase, script.getAttribute("src") ?? "");
          if (!src) continue;
          const node = document.createElement("script");
          node.type = "module";
          node.src = src;
          node.setAttribute("data-localapp-app-asset", src);
          document.body.appendChild(node);
          loadedNodes.push(node);
        }

        if (moduleScripts.length === 0) {
          setAppLoadError("App entry module not found in uploaded index.html");
        }
      } catch (e) {
        if (!cancelled) setAppLoadError(e instanceof Error ? e.message : String(e));
      }
    }

    void loadNativeApp();
    return () => {
      cancelled = true;
      for (const node of loadedNodes) node.remove();
    };
  }, [appOnline, nativeAppLoadKey, nativeAppResourceBase, ready]);

  const respondToPlatformRequest = useCallback((id: string, ok: boolean, result?: unknown, error?: string) => {
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "localapp:platform_response", id, ok, ...(ok ? { result } : { error }) },
      origin: window.location.origin,
    }));
  }, []);

  const handlePlatformRequest = useCallback(async (message: PlatformRequestMessage) => {
    try {
      switch (message.capability) {
        case "getCurrentUser":
          respondToPlatformRequest(message.id, true, user);
          break;
        case "getServerTime": {
          const res = await fetch(`/serve/${pagePath}/api/time`, { credentials: "include" });
          const body = await res.json();
          if (!res.ok || !body.success) throw new Error(body.error || `Server time request failed: ${res.status}`);
          respondToPlatformRequest(message.id, true, body.data);
          break;
        }
        case "copyText": {
          const payload = payloadObject(message.payload);
          const text = typeof payload.text === "string" ? payload.text : "";
          await navigator.clipboard.writeText(text);
          respondToPlatformRequest(message.id, true, { success: true });
          break;
        }
        case "downloadFile":
          downloadFromShell(message.payload);
          respondToPlatformRequest(message.id, true, { success: true });
          break;
        case "confirm": {
          const payload = payloadObject(message.payload);
          setConfirmDialog({
            id: message.id,
            title: typeof payload.title === "string" && payload.title.trim() ? payload.title : "确认操作",
            message: typeof payload.message === "string" ? payload.message : "",
            confirmText: typeof payload.confirmText === "string" && payload.confirmText.trim() ? payload.confirmText : "确认",
            cancelText: typeof payload.cancelText === "string" && payload.cancelText.trim() ? payload.cancelText : "取消",
            tone: payload.tone === "danger" ? "danger" : "default",
          });
          break;
        }
        case "openRoute": {
          const payload = payloadObject(message.payload);
          const href = typeof payload.href === "string" ? payload.href : "";
          if (!href) throw new Error("openRoute requires href");
          if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
          else router.push(href);
          respondToPlatformRequest(message.id, true, { success: true });
          break;
        }
        case "auth.login":
          openLogin({
            returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}`,
          });
          respondToPlatformRequest(message.id, true, { success: true });
          break;
        case "ai.open":
          if (!agentConversationEnabled) throw new Error("此应用已关闭 Agent 对话框");
          setAiMode((prev) => prev ?? "system");
          showAgent();
          respondToPlatformRequest(message.id, true, { success: true });
          break;
        case "ai.close":
          hideAgent();
          respondToPlatformRequest(message.id, true, { success: true });
          break;
        case "ai.toggle":
          if (!agentConversationEnabled) throw new Error("此应用已关闭 Agent 对话框");
          setAiMode((prev) => prev ?? "system");
          if (aiVisible.current) hideAgent(); else showAgent();
          respondToPlatformRequest(message.id, true, { success: true });
          break;
        default:
          throw new Error(`Unknown platform capability: ${message.capability}`);
      }
    } catch (e) {
      respondToPlatformRequest(message.id, false, undefined, e instanceof Error ? e.message : String(e));
    }
  }, [agentConversationEnabled, openLogin, pagePath, respondToPlatformRequest, router, user]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!event.data?.type) return;
      if (event.origin && event.origin !== window.location.origin) return;

      if (isRegisterToolsMessage(event.data)) {
        setAiMode("system");
        registeredToolsRef.current = event.data.tools;
        registerAgentToolCatalog(pagePath, event.data.tools);
        systemHintRef.current = event.data.systemHint || "";
        synchronizeContext();
      } else if (isAiCustomModeMessage(event.data)) {
        setAiMode("custom");
      } else if (isToolResultMessage(event.data)) {
        handleToolResult(event.data.callId, event.data.result, event.data.isError);
      } else if (isPlatformRequestMessage(event.data)) {
        void handlePlatformRequest(event.data as PlatformRequestMessage);
      }
    }
    function onPlatformRequest(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (!isPlatformRequestMessage(detail)) return;
      event.preventDefault();
      void handlePlatformRequest(detail as PlatformRequestMessage);
    }

    window.addEventListener("message", onMessage);
    window.addEventListener("localapp:platform_request", onPlatformRequest);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("localapp:platform_request", onPlatformRequest);
    };
  }, [handlePlatformRequest, handleToolResult, synchronizeContext]);

  const toggleFavorite = useCallback(async () => {
    if (!user) { openLogin(); return; }
    try {
      if (isFavorited) {
        const r = await fetch(`/api/favorites/${encodeURIComponent(pagePath)}`, { method: "DELETE", credentials: "include" });
        const d = await r.json();
        if (d.success) { setIsFavorited(false); setFavCount((c) => Math.max(0, c - 1)); }
      } else {
        const r = await fetch("/api/favorites", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pagePath, pageName: name, ownerName: userId }),
        });
        const d = await r.json();
        if (d.success) { setIsFavorited(true); setFavCount((c) => c + 1); }
      }
    } catch {}
  }, [isFavorited, pagePath, name, userId, user, openLogin]);

  const resolveConfirmDialog = useCallback((confirmed: boolean) => {
    if (!confirmDialog) return;
    respondToPlatformRequest(confirmDialog.id, true, confirmed);
    setConfirmDialog(null);
  }, [confirmDialog, respondToPlatformRequest]);

  if (!ready) return null;

  return (
    <div
      className="flex h-screen flex-col bg-background"
      data-localapp-native-shell
      data-localapp-app-resource-base={nativeAppResourceBase}
    >
      <div hidden={!!meta?.developmentPreview && window.self !== window.top} data-localapp-shell-nav-background data-testid="shell-nav-background" inert={showIssues ? ("true" as unknown as boolean) : undefined} aria-hidden={showIssues ? true : undefined} className="shrink-0">
        <Navbar
          previewControls={developmentPreviewUrl && isOwner ? <DevelopmentPreviewBar key={new URL(developmentPreviewUrl,window.location.origin).searchParams.get("previewId") ?? developmentPreviewUrl} url={developmentPreviewUrl} onPreview={setDevelopmentPreviewUrl} onClose={()=>setDevelopmentPreviewUrl(null)}/> : undefined}
          pageName={name}
          onOpenDevelopment={developerConversationEnabled && !meta?.developmentPreview ? () => { aiVisible.current = true; setAiOpen(true); setDeveloperReveal(value => value + 1); } : undefined}
          user={user}
          favCount={favCount}
          isFavorited={isFavorited}
          onToggleFavorite={toggleFavorite}
          onOpenIssues={openIssues}
          openIssueCount={openIssueCount}
          aiMode={agentConversationEnabled ? (meta?.developmentPreview ? aiMode : "system") : null}
          aiOpen={aiOpen}
          onToggleAI={() => { if (!user) { openLogin({ returnTo: window.location.pathname }); return; } if (aiVisible.current) hideAgent(); else showAgent(); }}
          editSession={editSession}
          presenceSnapshot={presenceSnapshot}
          bell={
            <NotificationBell
              pagePath={pagePath}
              pageName={name}
              ownerName={userId}
              user={user}
              meta={meta}
            />
          }
        />
      </div>
      <div className="relative flex-1 overflow-hidden" data-localapp-app-area>
        <div data-localapp-app-background data-testid="app-background" inert={showIssues ? ("true" as unknown as boolean) : undefined} aria-hidden={showIssues ? true : undefined} className="absolute inset-0">
          <div className="h-full overflow-auto" data-localapp-app-container>
            {appOffline ? (
              <main className="flex min-h-full items-center justify-center px-6 py-12" data-localapp-offline-state>
                <section className="w-full max-w-lg text-center">
                  <CircleOff className="mx-auto size-10 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-5 text-sm font-medium text-muted-foreground">{name}</p>
                  <h1 className="mt-2 text-xl font-semibold text-foreground">应用暂时下线</h1>
                  <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                    应用当前不可访问，数据和设置均已保留。重新上线后即可继续使用。
                  </p>
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                      <RefreshCw />刷新状态
                    </Button>
                    {isOwner && (
                      <Button size="sm" onClick={() => router.push(`/my/apps/${encodeURIComponent(name)}/settings?tab=manage`)}>
                        <Settings />应用设置
                      </Button>
                    )}
                  </div>
                </section>
              </main>
            ) : appOnline ? (
              <>
                <div id="root" data-localapp-app-root className="min-h-full" hidden={!!developmentPreviewUrl} />
                {developmentPreviewUrl && isOwner && <div className="flex h-full flex-col"><iframe title="应用开发预览" src={developmentPreviewUrl} className="min-h-0 flex-1 border-0" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"/></div>}
                {appLoadError && <div className="p-4 text-sm text-destructive">{appLoadError}</div>}
              </>
            ) : (
              <main className="flex min-h-full items-center justify-center px-6 py-12" data-localapp-load-unavailable>
                <section className="w-full max-w-lg text-center">
                  <CircleAlert className="mx-auto size-10 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-5 text-sm font-medium text-muted-foreground">{name}</p>
                  <h1 className="mt-2 text-xl font-semibold text-foreground">暂时无法加载应用</h1>
                  <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                    平台暂时无法确认应用状态。为保护应用数据，内容加载已暂停。
                  </p>
                  <div className="mt-6 flex justify-center">
                    <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                      <RefreshCw />重新加载
                    </Button>
                  </div>
                </section>
              </main>
            )}
          </div>
        </div>
        {conversationDockEnabled && !meta?.developmentPreview && !showIssues && !!user && developmentEnabled !== null && (
          <AppConversationDock key={`${pagePath}:${user?.id}:${developmentEnabled}`} application={{ owner: userId, name }} isOwner={isOwner && developmentEnabled}
            userConversationEnabled={agentConversationEnabled} developerReveal={developerReveal}
            onPreview={setDevelopmentPreviewUrl} agent={harness} onSend={agentSend} reveal={agentReveal} minimize={agentMinimize}
            onVisibilityChange={visible => { aiVisible.current = visible; setAiOpen(visible); }} />
        )}
        {appOnline && <EditingAwarenessOverlay peers={editingPeers} />}
        {showIssues && (
          <IssuesModal
            pagePath={pagePath}
          pageName={name}
            user={user}
            onIssuesChanged={refreshOpenIssueCount}
            selectedIssueId={selectedIssueId}
            selectedIssueNumber={selectedIssueNumber}
            onIssueNavigate={navigateToIssue}
            onClose={closeIssues}
          />
        )}
      </div>
      {confirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-lg">
            <h2 className="text-base font-semibold text-foreground">{confirmDialog.title}</h2>
            {confirmDialog.message && (
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{confirmDialog.message}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => resolveConfirmDialog(false)}>
                {confirmDialog.cancelText}
              </Button>
              <Button
                variant={confirmDialog.tone === "danger" ? "destructive" : "default"}
                size="sm"
                onClick={() => resolveConfirmDialog(true)}
              >
                {confirmDialog.confirmText}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
