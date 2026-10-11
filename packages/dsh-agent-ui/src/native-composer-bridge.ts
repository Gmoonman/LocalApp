import type { ISessions, SessionTarget } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionInput } from "@deepseek-ai/dsh-client-ui-conversation/client";

declare module "@deepseek-ai/dsh-api-session-controller/client" {
  interface SessionReferenceSourceMap { localappComposer: unknown }
}

/** Dispatch enclosing-page actions through the exact retained native conversation. */
export function installNativeComposerBridge(sessions: Pick<ISessions, "list" | "using">,
  resolve: (context: Parameters<ISessions["scopeOf"]>[0]) => { input: SessionInput; cancel: () => Promise<void>; addFiles?: (files: readonly File[]) => void; removeFile?: (id: string) => void },
): () => void {
  if (window.parent === window) return () => {};
  const controller = new AbortController();
  const pending = new Set<string>();
  const receive = (event: MessageEvent) => {
    if (controller.signal.aborted || event.source !== window.parent || event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.type !== "localapp:native-composer" || typeof data.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.requestId)
      || typeof data.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.sessionId)
      || !["draft", "submit", "cancel", "attach", "remove"].includes(data.action)
      || (["draft", "submit"].includes(data.action) && (typeof data.prompt !== "string" || data.prompt.length > 1000000))
      || (data.action === "remove" && (typeof data.attachmentId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.attachmentId)))
      || (data.action === "attach" && (!Array.isArray(data.files) || !data.files.every((file: unknown) => file instanceof File)))) return;
    if (pending.has(data.requestId) || pending.size >= 32) return;
    const selected = () => (sessions.list.getSnapshot().byId[data.sessionId]?.retainedBy.mainView ?? 0) > 0;
    pending.add(data.requestId);
    const execute = async () => {
      if (!selected()) throw new Error("会话未在原生界面中打开");
      await sessions.using(data.sessionId as SessionTarget, { source: "localappComposer", signal: controller.signal }, async reference => {
        const binding = await reference.ready;
        if (controller.signal.aborted || !selected()) throw new Error("会话已切换");
        const actions = resolve(binding.ctx);
        if (data.action === "cancel") await actions.cancel();
        else if (data.action === "attach") {
          if (!actions.addFiles) throw new Error("原生附件服务不可用");
          actions.addFiles(data.files);
        } else if (data.action === "remove") {
          if (!actions.removeFile) throw new Error("原生附件移除不可用");
          actions.removeFile(data.attachmentId);
        } else {
          if (actions.input.state.getSnapshot().phase !== "plain") throw new Error("输入框正在提交，请稍后重试");
          actions.input.setDraft(data.prompt);
          if (data.action === "submit") actions.input.submit("queue", "click");
        }
      });
    };
    void execute().then(() => reply(undefined), error => reply(error instanceof Error ? error.message : String(error)));
    function reply(error: string | undefined) {
      pending.delete(data.requestId);
      if (!controller.signal.aborted) window.parent.postMessage({type: "localapp:native-composer-result", requestId: data.requestId, ...(error ? {error} : {})}, window.location.origin);
    }
  };
  window.addEventListener("message", receive);
  return () => { controller.abort(); pending.clear(); window.removeEventListener("message", receive); };
}
