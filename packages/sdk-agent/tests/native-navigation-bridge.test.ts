import { afterEach, expect, it, vi } from "vitest";
import { installNativeNavigationBridge } from "../../dsh-app-platform/src/native-navigation-bridge.js";

afterEach(() => vi.unstubAllGlobals());

it("uses public navigation and accepts only the enclosing same-origin page", () => {
  const parent = { postMessage: vi.fn() };
  let receive!: (event: any) => void;
  let update!: () => void;
  const unsubscribe = vi.fn();
  const removeEventListener = vi.fn();
  vi.stubGlobal("window", {
    parent, location: { origin: "http://localhost" },
    addEventListener: (_: string, handler: any) => { receive = handler; }, removeEventListener,
  });
  const row = { id: "one", displayTitle: "应用开发", updatedAt:123, running: true, retainedBy: { mainView: 1 } };
  const sessions = { list: { getSnapshot: () => ({ ids:["one","child"],byId: { one: row,child:{...row,id:"child",parentId:"one",origin:"subagent",retainedBy:{}} } }), subscribe: (callback: () => void) => { update = callback; return unsubscribe; } } };
  const navigation = { openSession: vi.fn(), startSession: vi.fn() };
  const dispose = installNativeNavigationBridge(sessions as any, navigation);
  expect(parent.postMessage).toHaveBeenCalledWith({ type: "localapp:native-selection", state: { sessionId: "one", title: "应用开发", running: true } }, "http://localhost");
  expect(parent.postMessage).toHaveBeenCalledWith({type:"localapp:native-catalog",sessions:[{id:"one",title:"应用开发",updatedAt:123,pinned:false}]},"http://localhost");
  receive({ source: parent, origin: "https://foreign.invalid", data: { type: "localapp:native-select", sessionId: "one" } });
  receive({ source: {}, origin: "http://localhost", data: { type: "localapp:native-new-session" } });
  receive({ source: parent, origin: "http://localhost", data: { type: "localapp:native-select", sessionId: "missing" } });
  expect(navigation.openSession).not.toHaveBeenCalled();
  expect(navigation.startSession).not.toHaveBeenCalled();
  receive({ source: parent, origin: "http://localhost", data: { type: "localapp:native-select", sessionId: "one" } });
  expect(navigation.openSession).toHaveBeenCalledWith("one");
  receive({ source: parent, origin: "http://localhost", data: { type: "localapp:native-new-session" } });
  expect(navigation.startSession).toHaveBeenCalledOnce();
  update(); expect(parent.postMessage).toHaveBeenCalledTimes(2);
  row.running = false; update(); expect(parent.postMessage).toHaveBeenCalledTimes(3);
  row.displayTitle="新的名称";update();expect(parent.postMessage).toHaveBeenCalledTimes(5);
  dispose(); update(); expect(parent.postMessage).toHaveBeenCalledTimes(5);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(removeEventListener).toHaveBeenCalledWith("message", receive);
});


it("synchronizes archive and pin changes without losing forked conversations", () => {
  const parent = { postMessage: vi.fn() };
  vi.stubGlobal("window", {
    parent, location: { origin: "http://localhost" },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  let workspaceChanged!: () => void;
  const unsubscribe = vi.fn();
  const snapshot = { archivedSessionIds: [] as string[], pinnedSessionIds: [] as string[] };
  const row = { id: "fork", parentId: "original", origin: "fork", displayTitle: "分叉会话", updatedAt: 456, running: false, retainedBy: {} };
  const sessions = { list: { getSnapshot: () => ({ ids: ["fork"], byId: { fork: row } }), subscribe: () => () => {} } };
  const workspaces = { list: { getSnapshot: () => snapshot, subscribe: (callback: () => void) => { workspaceChanged = callback; return unsubscribe; } } };
  const dispose = installNativeNavigationBridge(sessions as any, { openSession: vi.fn(), startSession: vi.fn() }, workspaces as any);
  snapshot.pinnedSessionIds = ["fork"];
  workspaceChanged();
  expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "localapp:native-catalog", sessions: [{ id: "fork", title: "分叉会话", updatedAt: 456, pinned: true }] }, "http://localhost");
  snapshot.archivedSessionIds = ["fork"];
  workspaceChanged();
  expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "localapp:native-catalog", sessions: [] }, "http://localhost");
  snapshot.archivedSessionIds = [];
  workspaceChanged();
  expect(parent.postMessage).toHaveBeenLastCalledWith({ type: "localapp:native-catalog", sessions: [{ id: "fork", title: "分叉会话", updatedAt: 456, pinned: true }] }, "http://localhost");
  dispose();
  const calls = parent.postMessage.mock.calls.length;
  workspaceChanged();
  expect(parent.postMessage).toHaveBeenCalledTimes(calls);
  expect(unsubscribe).toHaveBeenCalledOnce();
});


it("restores a session after its scoped catalog arrives and cancels stale restore requests", () => {
  const parent = { postMessage: vi.fn() };
  let receive!: (event: any) => void;
  let changed!: () => void;
  vi.stubGlobal("window", {
    parent, location: { origin: "http://localhost" },
    addEventListener: (_: string, callback: any) => { receive = callback; }, removeEventListener: vi.fn(),
  });
  const snapshot = { ids: [] as string[], byId: {} as Record<string, any> };
  const navigation = { openSession: vi.fn(), startSession: vi.fn() };
  const dispose = installNativeNavigationBridge({ list: {
    getSnapshot: () => snapshot, subscribe: (callback: () => void) => { changed = callback; return () => {}; },
  } } as any, navigation);
  const send = (data: unknown) => receive({ source: parent, origin: "http://localhost", data });
  send({ type: "localapp:native-select", sessionId: "restored" });
  expect(navigation.openSession).not.toHaveBeenCalled();
  const row = { id: "restored", displayTitle: "恢复的对话", updatedAt: 1, retainedBy: {}, running: false };
  snapshot.ids.push(row.id); snapshot.byId[row.id] = row; changed();
  expect(navigation.openSession).toHaveBeenCalledExactlyOnceWith("restored");
  changed(); expect(navigation.openSession).toHaveBeenCalledTimes(1);
  send({ type: "localapp:native-select", sessionId: "later" });
  send({ type: "localapp:native-new-session" });
  snapshot.ids.push("later"); snapshot.byId.later = { ...row, id: "later" }; changed();
  expect(navigation.openSession).toHaveBeenCalledTimes(1);
  dispose();
});
