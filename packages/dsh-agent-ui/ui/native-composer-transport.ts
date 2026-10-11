export type NativeComposerAction = "draft" | "submit" | "cancel" | "attach" | "remove";
/** One iframe lifetime owns all outstanding native composer acknowledgements. */
export function createNativeComposerTransport(target: Window, origin: string, timeoutMs = 15000) {
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let disposed = false;
  const receive = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== origin || event.data?.type !== "localapp:native-composer-result") return;
    const data = event.data;
    if (typeof data.requestId !== "string" || (data.error !== undefined && typeof data.error !== "string")) return;
    const request = pending.get(data.requestId);
    if (!request) return;
    pending.delete(data.requestId); clearTimeout(request.timer);
    if (data.error) request.reject(new Error(data.error)); else request.resolve();
  };
  window.addEventListener("message", receive);
  return {
    request(sessionId: string, action: NativeComposerAction, prompt?: string, files?: readonly File[]): Promise<void> {
      if (disposed) return Promise.reject(new Error("原生对话已关闭"));
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return Promise.reject(new Error("会话标识无效"));
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("原生对话未响应")); }, timeoutMs);
        pending.set(requestId, {resolve, reject, timer});
        try { target.postMessage({type:"localapp:native-composer", requestId, sessionId, action, ...(prompt !== undefined ? (action === "remove" ? {attachmentId: prompt} : {prompt}) : {}), ...(files ? {files} : {})}, origin); }
        catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true; window.removeEventListener("message", receive);
      for (const request of pending.values()) {clearTimeout(request.timer); request.reject(new Error("原生对话已关闭"));}
      pending.clear();
    },
  };
}
export type NativeComposerTransport = ReturnType<typeof createNativeComposerTransport>;
