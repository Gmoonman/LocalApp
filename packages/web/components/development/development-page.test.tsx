import React from "react";
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DevelopmentPage } from "./development-page";
vi.mock("./dsh-view", () => ({
  DshMessages: () => null,
  DshMarkdown: () => null,
  DshDiff: () => null,
  DshTerminal: () => null,
  DshRunningStatus: () => <div role="status">正在处理…</div>,
}));
it("connects app source without a configured model", async () => {
  const fetcher = vi.fn(async (url: string) => {
    const data =
      url === "/api/agent/settings"
        ? { providers: [], defaultProviderId: "" }
        : url.includes("/source")
          ? { id: "p", name: "existing" }
          : [];
    return new Response(JSON.stringify({ success: true, data }));
  });
  vi.stubGlobal("fetch", fetcher);
  render(
    <DevelopmentPage application={{ owner: "owner", name: "existing" }} />,
  );
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/development/apps/owner/existing/source",
      expect.anything(),
    ),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("应用修改需求")).not.toBeDisabled(),
  );
  expect(screen.getByRole("link", { name: "配置模型" })).toBeInTheDocument();
});
it("invalidates the old build after an agent turn and compares changes with its original source", async () => {
  HTMLElement.prototype.scrollTo = vi.fn();
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/agent/run"))
      return new Response('data: {"type":"session","sessionId":"session"}\n\n');
    const data =
      url === "/api/agent/settings"
        ? {
            providers: [{ id: "provider", name: "Provider", model: "model" }],
            defaultProviderId: "provider",
          }
        : url.includes("/source")
          ? { id: "p", name: "existing" }
          : url.endsWith("/builds")
            ? [
                {
                  id: "old",
                  status: "succeeded",
                  sourceVersion: "published-source",
                },
              ]
            : url.endsWith("/versions")
              ? [{ id: "current-source", message: "current" }]
              : [];
    return new Response(JSON.stringify({ success: true, data }));
  });
  vi.stubGlobal("fetch", fetcher);
  render(
    <DevelopmentPage application={{ owner: "owner", name: "existing" }} />,
  );
  fireEvent.click(screen.getByLabelText("展开开发对话"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^上线$/ })).not.toBeDisabled(),
  );
  fireEvent.change(screen.getByLabelText("应用修改需求"), {
    target: { value: "Change the page" },
  });
  const nativeFrame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
  const nativeState=(running:boolean)=>fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:nativeFrame.contentWindow,data:{type:"localapp:native-selection",state:{sessionId:"session",title:"修改页面",running}}}));
  nativeState(true);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^上线$/ })).toBeDisabled(),
  );
  nativeState(false);
  await waitFor(() =>
    expect(screen.getByLabelText("应用修改需求")).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: /^改动$/ }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/development/projects/p/diff?version=published-source",
      expect.anything(),
    ),
  );
});
it("continues the creation session and starts an inline preview build after the turn", async () => {
  window.history.replaceState({}, "", "/alice/new-app/?creation=new-project");
  HTMLElement.prototype.scrollTo = vi.fn();
  let continued=false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if(url.endsWith("/continue")){continued=true;return new Response(JSON.stringify({success:true,data:{accepted:true}}));}
    if (url.endsWith("/agent/run")) return new Response('data: {"type":"session","sessionId":"creation-session"}\n\n');
    const data = url === "/api/agent/settings" ? {providers: [{id: "provider", name: "Provider", model: "model"}], defaultProviderId: "provider"}
      : url.includes("/apps/") ? {id: "new-project", name: "new-app"}
      : url.includes("/creations/") ? {sessionId: "creation-session", providerId: "provider", state: "ready", continued: false}
      : url.endsWith("/agent/sessions") ? [{id: "creation-session", title: "新应用", createdAt: new Date().toISOString()}]
      : url.includes("/agent/history") ? [{role: "user", content: "最初的需求"}]
      : url.endsWith("/builds") && init?.method === "POST" ? {id: "preview-build", purpose: "preview", status: "succeeded"}
      : url.endsWith("/builds") ? (continued?[{id:"preview-build",purpose:"preview",status:"succeeded",createdAt:"2026-10-11"}]:[])
      : url.endsWith("/previews") ? {url: "http://preview.localhost/new-app/"}
      : [];
    return new Response(JSON.stringify({success: true, data}));
  });
  vi.stubGlobal("fetch", fetcher); const onPreview = vi.fn();
  const view = render(<DevelopmentPage application={{owner: "alice", name: "new-app"}} dock={{onPreview} as any}/>);
  await waitFor(() => expect(onPreview).toHaveBeenCalledWith("http://preview.localhost/new-app/"),{timeout:3000});
  expect(fetcher.mock.calls.filter(([url])=>url.endsWith("/continue"))).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/agent/run"))).toHaveLength(0);
  expect(fetcher.mock.calls.some(([url,init])=>url.endsWith("/builds")&&init?.method==="POST")).toBe(false);
  view.unmount(); window.history.replaceState({}, "", "/");
});
it("feeds preview compiler errors into the same session twice, then reports failure", async () => {
  HTMLElement.prototype.scrollTo = vi.fn();
  let builds = 0;
  let edited=0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/agent/run")) return new Response('data: {"type":"session","sessionId":"repair-session"}\n\n');
    const data = url === "/api/agent/settings" ? {providers: [{id: "provider", name: "Provider", model: "model"}], defaultProviderId: "provider"}
      : url.includes("/apps/") ? {id: "repair-project", name: "repair-app"}
      : url.endsWith("/versions") ? [{id:`source-${edited}`}]
      : url.endsWith("/builds") && init?.method === "POST" ? {id: `build-${++builds}`, purpose: "preview", status: "failed", log: "error TS2552: Cannot find name 'toNumber'"}
      : [];
    return new Response(JSON.stringify({success: true, data}));
  });
  vi.stubGlobal("fetch", fetcher);
  render(<DevelopmentPage application={{owner: "alice", name: "repair-app"}}/>);
  await waitFor(() => expect(screen.getByLabelText("应用修改需求")).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText("应用修改需求"), {target: {value: "实现应用"}});
  const nativeFrame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
  const nativeState=(running:boolean)=>fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:nativeFrame.contentWindow,data:{type:"localapp:native-selection",state:{sessionId:"repair-session",title:"实现应用",running}}}));
  const nativeRepairs:string[]=[];
  vi.spyOn(nativeFrame.contentWindow!,"postMessage").mockImplementation((message:any)=>{
    if(message.type!=="localapp:native-composer"||message.action!=="submit")return;
    nativeRepairs.push(message.prompt);
    queueMicrotask(()=>{
      fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:nativeFrame.contentWindow,data:{type:"localapp:native-composer-result",requestId:message.requestId}}));
      nativeState(true);
      setTimeout(()=>{edited++;nativeState(false);},0);
    });
  });
  nativeState(true);edited++;nativeState(false);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("预览编译失败，应用尚未更新"));
  const runs = fetcher.mock.calls.filter(([url]) => url.endsWith("/agent/run")).map(([, init]) => JSON.parse(init!.body as string));
  expect(runs).toHaveLength(0);
  expect(nativeRepairs).toHaveLength(2);
  expect(nativeRepairs[0]).toContain("error TS2552");
  expect(nativeRepairs[1]).toContain("自动修复 2/2");
  fireEvent.click(screen.getByRole("button", {name: "查看构建日志"}));
  expect(screen.getByText("构建失败，请查看日志")).toBeVisible();
});
it("observes a server-created preview without submitting a legacy agent turn", async () => {
  window.history.replaceState({}, "", "/alice/server-preview/");
  let completed = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const data = url === "/api/agent/settings" ? { providers: [], defaultProviderId: "" }
      : url.includes("/apps/") ? { id: "server-project", name: "server-preview" }
      : url.endsWith("/builds") ? (completed ? [{ id: "server-build", purpose: "preview", status: "succeeded", createdAt: "2026-10-10" }] : [])
      : url.endsWith("/previews") ? { url: "http://preview.localhost/server-preview/" } : [];
    return new Response(JSON.stringify({ success: true, data }));
  });
  vi.stubGlobal("fetch", fetcher);
  const onPreview = vi.fn();
  const view = render(<DevelopmentPage application={{ owner: "alice", name: "server-preview" }} dock={{ onPreview } as any} />);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/builds"))).toBe(true));
  completed = true;
  await waitFor(() => expect(onPreview).toHaveBeenCalledWith("http://preview.localhost/server-preview/"), { timeout: 3000 });
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/agent/run"))).toBe(false);
  expect(fetcher.mock.calls.some(([url, init]) => url.endsWith("/builds") && init?.method === "POST")).toBe(false);
  view.unmount();
});

it("opens a successful release build on developer entry and reopens after returning from user mode", async () => {
  const onPreview = vi.fn();
  const fetcher = vi.fn(async (url: string) => {
    const data = url === "/api/agent/settings" ? {providers: []}
      : url.includes("/source") ? {id: "entry-project", name: "existing"}
      : url.endsWith("/builds") ? [{id: "release-build", purpose: "release", status: "succeeded"}]
      : url.endsWith("/previews") ? {url: "http://preview.localhost/entry/"} : [];
    return new Response(JSON.stringify({success: true, data}));
  });
  vi.stubGlobal("fetch", fetcher);
  const application = {owner: "owner", name: "existing"};
  const view = render(<DevelopmentPage application={application} dock={{identity: "user", onPreview} as any} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/development/projects/entry-project/builds", expect.anything()));
  expect(onPreview).not.toHaveBeenCalled();
  view.rerender(<DevelopmentPage application={application} dock={{identity: "developer", onPreview} as any} />);
  await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(1));
  view.rerender(<DevelopmentPage application={application} dock={{identity: "user", onPreview} as any} />);
  view.rerender(<DevelopmentPage application={application} dock={{identity: "developer", onPreview} as any} />);
  await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2));
});

it("does not auto-open the development preview for a build that is already live", async () => {
  const onPreview = vi.fn();
  const fetcher = vi.fn(async (url: string) => {
    const data = url === "/api/agent/settings" ? {providers: []}
      : url.includes("/source") ? {id: "live-project", name: "live"}
      : url.endsWith("/builds") ? [{id: "live-build", purpose: "release", status: "succeeded"}]
      : url.endsWith("/delivery") ? {releases: [{buildId: "live-build", version: 3, sourceVersion: "s3"}], liveVersion: 3}
      : url.endsWith("/previews") ? {url: "http://preview.localhost/live/"} : [];
    return new Response(JSON.stringify({success: true, data}));
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(<DevelopmentPage application={{owner: "owner", name: "live"}} dock={{identity: "developer", onPreview} as any} />);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/delivery"))).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(onPreview).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.some(([url, init]) => url.endsWith("/previews") && init?.method === "POST")).toBe(false);
  view.unmount();
});
