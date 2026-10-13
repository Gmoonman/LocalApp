"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Sparkles, Check } from "lucide-react";
import { request, nativeRequest, type Creation } from "@localapp/dsh-app-development/creation-client";
export interface CreationDialogComponents {
  Dialog: React.JSXElementConstructor<{open: boolean; onOpenChange: (open: boolean) => void; children?: React.ReactNode}>;
  DialogContent: React.JSXElementConstructor<React.PropsWithChildren<{className?: string; closeLabel?: string; onOpenAutoFocus?: (event: Event) => void; onCloseAutoFocus?: (event: Event) => void; onEscapeKeyDown?: (event: KeyboardEvent) => void; onPointerDownOutside?: (event: Event) => void}>>;
  DialogTitle: React.JSXElementConstructor<React.PropsWithChildren<{className?: string}>>;
  DialogDescription: React.JSXElementConstructor<React.PropsWithChildren<{className?: string}>>;
  Button: React.JSXElementConstructor<React.ButtonHTMLAttributes<HTMLButtonElement> & {variant?: "outline" | "ghost"; size?: "icon"}>;
  Textarea: React.JSXElementConstructor<React.TextareaHTMLAttributes<HTMLTextAreaElement>>;
  ChoiceSelect: React.JSXElementConstructor<{label: string; value: string; disabled?: boolean; onValueChange: (value: string) => void; options: {value: string; label: string}[]; className?: string}>;
  NativeConversationFrame: React.JSXElementConstructor<{identity: "developer"; projectId: string; providerId: string; sessionId?: string; onSelection?: (selection: {running: boolean} | null) => void}>;
}
/** The host supplies its shared shadcn components and native conversation frame. */
export function createApplicationDialog(components: CreationDialogComponents) {
const {Dialog, DialogContent, DialogTitle, DialogDescription, Button, Textarea, ChoiceSelect, NativeConversationFrame} = components;
return function CreateApplicationDialog({ open, onOpenChange, onCreated = url => window.location.assign(url) }: {
  open: boolean; onOpenChange: (open: boolean) => void; onCreated?: (url: string) => void;
}) {
  const [providers, setProviders] = useState<{ id: string; name: string; model: string }[]>([]);
  const [provider, setProvider] = useState("");
  const [drafts, setDrafts] = useState<Creation[]>([]);
  const [creation, setCreation] = useState<Creation | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const pendingCreation = useRef<{ draft: Creation; sessionCreated: boolean; requestId: string } | null>(null);
  useEffect(() => {
    if (open) void request("/api/agent/settings").then(settings => {
      setProviders(settings.providers);
      setProvider(current => current || settings.defaultProviderId || settings.providers[0]?.id || "");
    }).catch(error => setError(error.message));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void request("/api/development/creations").then(rows => {
      if (!disposed) setDrafts(Array.isArray(rows) ? rows : []);
    }).catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; };
  }, [open]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!open || !creation) return;
    let disposed = false;
    let polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        const draft = await request(`/api/development/creations/${creation.projectId}`);
        if (!disposed) setCreation(draft);
      } catch (error) {
        if (!disposed) setError((error as Error).message);
      } finally { polling = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [open, creation?.projectId]);
  async function send() {
    if (busy || confirming || creation || !prompt.trim() || !provider) return;
    setBusy(true); setError("");
    const abort = new AbortController(); controller.current = abort;
    try {
      if (!pendingCreation.current) {
        const draft: Creation = await request("/api/development/creations", { providerId: provider });
        pendingCreation.current = { draft, sessionCreated: false, requestId: crypto.randomUUID() };
      }
      const pending = pendingCreation.current;
      const draft = pending.draft;
      if (!pending.sessionCreated) {
        try {
          await nativeRequest(draft, "create", { request: { sessionId: draft.sessionId } }, abort.signal);
        } catch (error) {
          if (abort.signal.aborted) throw error;
          // A lost response may leave the session already created on Server.
          const catalog = await nativeRequest(draft, "list", { _request: {} }, abort.signal);
          if (!catalog.items?.some((item: { sessionId: string }) => item.sessionId === draft.sessionId)) throw error;
        }
        pending.sessionCreated = true;
      }
      const result = await nativeRequest(draft, "prompt", { request: {
        sessionId: draft.sessionId, requestId: pending.requestId, mode: "queue",
        content: [{ type: "text", text: prompt.trim() }],
      } }, abort.signal);
      if (!result.accepted) throw new Error("需求未发送，请重试");
      setCreation(draft); setPrompt("");
    } catch (error) { if (!abort.signal.aborted) setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function resume(draft: Creation) {
    if (busy || confirming) return;
    setBusy(true); setError("");
    const abort = new AbortController(); controller.current = abort;
    try {
      const catalog = await nativeRequest(draft, "list", { _request: {} }, abort.signal);
      if (!catalog.items?.some((item: { sessionId: string }) => item.sessionId === draft.sessionId)) {
        await nativeRequest(draft, "create", { request: { sessionId: draft.sessionId } }, abort.signal);
      }
      setCreation(draft); setProvider(draft.providerId);
    } catch (error) { if (!abort.signal.aborted) setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!creation?.proposal || busy || confirming) return;
    setConfirming(true); setError("");
    try {
      const result = await request(`/api/development/creations/${creation.projectId}/confirm`, { name: creation.proposal.name });
      onCreated(result.url);
    } catch (error) { setError((error as Error).message); setConfirming(false); }
  }
  return <Dialog open={open} onOpenChange={value => {
    if (!confirming) { if (!value) controller.current?.abort(); onOpenChange(value); }
  }}>
    <DialogContent
      onOpenAutoFocus={() => { returnFocus.current = document.activeElement as HTMLElement; }}
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus(); }}
      className="dsh-development flex h-[min(720px,85dvh)] flex-col p-0"
      onEscapeKeyDown={event => { if (confirming) event.preventDefault(); }}
      onPointerDownOutside={event => { if (confirming) event.preventDefault(); }}>
      <div className="px-7 pt-6">
        <DialogTitle className="text-sm font-medium text-muted-foreground">创建应用</DialogTitle>
        <DialogDescription className="sr-only">先与 Agent 讨论需求，确认名称后进入应用继续开发。</DialogDescription>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-4 py-3">
        {creation ? <NativeConversationFrame identity="developer" projectId={creation.projectId} providerId={creation.providerId}
          sessionId={creation.sessionId} onSelection={selection => setBusy(selection?.running ?? false)} /> :
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-5">
            <Sparkles className="size-10 text-muted-foreground/40" />
            <h2 className="text-3xl font-medium tracking-tight">我们要构建什么？</h2>
            <p className="max-w-sm text-center text-sm text-muted-foreground">说说你的想法，先聊清需求，再一起确定应用名称。</p>
            {drafts.length > 0 && <div className="max-h-40 w-full max-w-md space-y-2 overflow-y-auto">
              <p className="text-sm text-muted-foreground">继续未完成的创建</p>
              {drafts.map(draft => <Button key={draft.projectId} variant="outline" className="w-full justify-start" disabled={busy || !providers.some(item => item.id === draft.providerId)} onClick={() => void resume(draft)}>{draft.proposal?.name || "未命名应用"}{draft.createdAt && <span className="ml-auto text-xs text-muted-foreground">{new Date(draft.createdAt).toLocaleString()}</span>}</Button>)}
            </div>}
          </div>}
      </div>
      {creation?.proposal && !busy && <div className="mx-7 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/40 p-4">
        <div className="min-w-0"><p className="font-medium">{creation.proposal.name}</p><p className="mt-1 max-w-lg text-sm text-muted-foreground">{creation.proposal.description}</p></div>
        <Button disabled={confirming || busy} onClick={confirm}>{confirming ? <LoaderCircle className="animate-spin" /> : <Check />}{confirming ? "正在创建…" : "确认名称并创建"}</Button>
      </div>}
      {error && <p role="alert" className="px-7 pb-2 text-sm text-destructive">{error}</p>}
      {!providers.length && <a className="px-7 pb-3 text-sm underline" href="/my/models">先配置模型供应商</a>}
      {!creation && <form className="m-5 mt-0 flex shrink-0 flex-col gap-2 rounded-2xl border bg-background p-3 shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/30" onSubmit={event => { event.preventDefault(); void send(); }}>
        <Textarea aria-label="创建应用需求" placeholder="描述你想创建的应用…" className="max-h-48 min-h-20 resize-none rounded-none border-0 bg-transparent px-2 py-1 shadow-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          value={prompt} disabled={busy || confirming} onChange={event => setPrompt(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
          }} />
        <div className="flex min-w-0 items-center justify-end gap-2">
          <ChoiceSelect label="创建应用模型" value={provider} disabled={busy || confirming || pendingCreation.current !== null} onValueChange={setProvider}
            options={providers.map(p => ({ value: p.id, label: `${p.name} · ${p.model}` }))} className="w-auto min-w-0 max-w-[calc(100%-3rem)] border-0 bg-transparent shadow-none sm:max-w-80" />
          <Button type="submit" size="icon" className="shrink-0 rounded-full" aria-label="发送创建需求" disabled={!prompt.trim() || !provider || busy || confirming}>
            {busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
      </form>}
    </DialogContent>
  </Dialog>;
}

}
