import type { HarnessAgent } from "./harness-client.js";
/** Bind native prompts to the hosting application's tools before dispatch. */
export function attachNativeFrame(frame: HTMLIFrameElement, agent: HarnessAgent) {
  const pending = new Map<string, Promise<void>>();
  const listener = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
    const value = event.data;
    if (!value || value.type !== "localapp:native-prepare" || typeof value.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(value.id) || typeof value.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.sessionId)) return;
    let operation = pending.get(value.sessionId);
    if (!operation) {
      operation = agent.connectNativeSession(value.sessionId).then(() => {});
      pending.set(value.sessionId, operation);
      void operation.finally(() => { if (pending.get(value.sessionId) === operation) pending.delete(value.sessionId); }).catch(() => {});
    }
    void operation.then(() => frame.contentWindow?.postMessage({type:"localapp:native-prepared",id:value.id,ok:true},event.origin), error => frame.contentWindow?.postMessage({type:"localapp:native-prepared",id:value.id,ok:false,error:error instanceof Error?error.message:String(error)},event.origin));
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
