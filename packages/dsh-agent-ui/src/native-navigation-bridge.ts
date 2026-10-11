import type { ISessions, SessionTarget } from "@deepseek-ai/dsh-api-session-controller/client";
import type { UiWorkspace } from "@deepseek-ai/dsh-client-ui-workspace/client";
import type { IWorkspaces } from "@deepseek-ai/dsh-api-workspace-controller/client";

/** Synchronize the application shell with scoped native navigation services. */
export function installNativeNavigationBridge(
  sessions: Pick<ISessions, "list">,
  navigation: Pick<UiWorkspace, "openSession" | "startSession">,
  workspaces?:Pick<IWorkspaces,"list">,
): () => void {
  if (window.parent === window) return () => {};
  let disposed = false;
  let previous = "";
  let previousCatalog = "";
  let pendingSelection: string | undefined;
  const publish = () => {
    if (disposed) return;
    const snapshot = sessions.list.getSnapshot();
    if (pendingSelection && snapshot.byId[pendingSelection as keyof typeof snapshot.byId]) {
      const target = pendingSelection;
      pendingSelection = undefined;
      navigation.openSession(target as SessionTarget);
    }
    const rows = Object.values(snapshot.byId);
    const workspace=workspaces?.list.getSnapshot();
    const archived=new Set<string>(workspace?.archivedSessionIds??[]);
    const pinned=new Set<string>(workspace?.pinnedSessionIds??[]);
    const catalog = snapshot.ids.map(id=>snapshot.byId[id]).filter(row=>row && row.origin!=="subagent"&&!archived.has(row.id))
      .map(row=>({id:row.id,title:row.displayTitle,updatedAt:row.updatedAt,pinned:pinned.has(row.id)}));
    const catalogSerialized=JSON.stringify(catalog);
    if(catalogSerialized!==previousCatalog){
      previousCatalog=catalogSerialized;
      window.parent.postMessage({type:"localapp:native-catalog",sessions:catalog},window.location.origin);
    }
    const selected = rows.find(row => (row.retainedBy.mainView ?? 0) > 0);
    const state = selected ? { sessionId: selected.id, title: selected.displayTitle, running: selected.running } : null;
    const serialized = JSON.stringify(state);
    if (serialized === previous) return;
    previous = serialized;
    window.parent.postMessage({ type: "localapp:native-selection", state }, window.location.origin);
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.type === "localapp:native-select" && typeof data.sessionId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(data.sessionId)) {
      // Restore requests may arrive before the initial catalog. Open only after
      // the scoped native service has confirmed that the session exists.
      pendingSelection = data.sessionId;
      if (sessions.list.getSnapshot().byId[data.sessionId]) {
        pendingSelection = undefined;
        navigation.openSession(data.sessionId as SessionTarget);
      }
    } else if (data?.type === "localapp:native-new-session") {
      pendingSelection = undefined;
      navigation.startSession();
    } else if (data?.type === "localapp:native-selection-request") {
      previous = "";
      previousCatalog = "";
      publish();
    }
  };
  const unsubscribe = sessions.list.subscribe(publish);
  const unsubscribeWorkspace=workspaces?.list.subscribe(publish);
  window.addEventListener("message", receive);
  publish();
  return () => {
    disposed = true;
    pendingSelection = undefined;
    unsubscribe();
    unsubscribeWorkspace?.();
    window.removeEventListener("message", receive);
  };
}
