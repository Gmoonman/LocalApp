/** Application platform contribution: bind page tools before native prompts. */
export function installNativeApplicationBridge() {
  if (new URLSearchParams(window.location.search).get("localappCompact") === "1") return () => {};
  if (window.parent === window || new URLSearchParams(window.location.search).get("localappBridge") !== "1") return () => {};
  const original = window.fetch;
  const prepared = new Set<string>();
  const pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const listener = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== "localapp:native-prepared") return;
    const request = pending.get(event.data.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(event.data.id);
    if (event.data.ok === true) request.resolve(); else request.reject(new Error(event.data.error || "Application context binding failed"));
  };
  window.addEventListener("message", listener);
  const wrapped: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin === window.location.origin && url.pathname === new URL("api/session/prompt", document.baseURI).pathname) {
      const body = input instanceof Request && init?.body === undefined ? await input.clone().json() : JSON.parse(String(init?.body ?? "{}"));
      const sessionId = body?.payload?.args?.request?.sessionId;
      if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid application session");
      if (!prepared.has(sessionId)) {
        const id = crypto.randomUUID();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error("Application context binding timed out")); }, 15000);
          pending.set(id, {resolve,reject,timer});
          window.parent.postMessage({type:"localapp:native-prepare",id,sessionId},window.location.origin);
        });
        prepared.add(sessionId);
      }
    }
    return original.call(window,input,init);
  };
  window.fetch = wrapped;
  return () => {
    if(window.fetch === wrapped) window.fetch = original;
    window.removeEventListener("message",listener);
    for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error("Native application frame closed"));}
    pending.clear();
  };
}
