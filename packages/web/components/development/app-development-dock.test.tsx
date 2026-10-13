import React from "react";
import { expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppDevelopmentDock } from "./app-development-dock";
import type { DevelopmentShellProps } from "./dsh-development-shell";
vi.mock("./dsh-view", () => ({
  DshMessages: () => null,
  DshMarkdown: ({ text }: { text: string }) => <span>{text}</span>,
  DshDiff: () => null,
  DshTerminal: () => null,
  DshRunningStatus: () => <div role="status">正在处理…</div>,
}));
vi.mock("./page-context",async importOriginal=>({...await importOriginal<typeof import("./page-context")>(),activatePageContext:vi.fn(async()=>{})}));
beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
});
function props(): DevelopmentShellProps {
  const noop = vi.fn();
  return {
    sessions: [],
    selectedSession: "",
    projects: [{ id: "project", name: "my-app" }],
    project: { id: "project", name: "my-app" },
    files: ["src/App.tsx"],
    file: null,
    text: "",
    prompt: "Make a todo app",
    messages: [],
    live: "",
    running: false,
    pending: false,
    error: "",
    versions: [],
    version: "",
    changes: [],
    providers: [{ id: "model", name: "My provider", model: "my-model" }],
    provider: "model",
    build: null,
    log: "",
    interaction: null,
    answer: "",
    actions: {
      select: noop,
      selectSession: noop,
      create: vi.fn(),
      open: vi.fn(),
      setText: noop,
      save: noop,
      setPrompt: noop,
      run: vi.fn(),
      stop: vi.fn(),
      setProvider: noop,
      newSession: noop,
      setVersion: noop,
      diff: noop,
      restore: noop,
      build: vi.fn(),
      preview: vi.fn(),
      publish: vi.fn(),
      cancelBuild: noop,
      newFile: noop,
      respond: vi.fn(),
      setAnswer: noop,
    },
  };
}

it("only expands from the top-left control, including while sending or running", () => {
  const p = props();
  const view = render(<AppDevelopmentDock {...p} />);
  expect(screen.queryByRole("log")).toBeNull();
  fireEvent.click(screen.getByLabelText("发送修改需求"));
  expect(p.actions.run).toHaveBeenCalledOnce();
  expect(screen.queryByRole("log")).toBeNull();
  fireEvent.click(screen.getByLabelText("展开开发对话"));
  expect(screen.getByRole("log")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^上线$/ })).toBeDisabled();
  fireEvent.click(screen.getByLabelText("收起开发对话"));
  view.rerender(<AppDevelopmentDock {...p} running />);
  expect(screen.queryByRole("log")).toBeNull();
  expect(screen.getByLabelText("应用修改需求")).toBeDisabled();
  fireEvent.click(screen.getByLabelText("停止开发"));
  expect(p.actions.stop).toHaveBeenCalledOnce();
});
it("keeps IME and Shift Enter safe and connects build, preview and release controls", () => {
  const p = props();
  p.build = { id: "build", status: "succeeded" };
  const view = render(<AppDevelopmentDock {...p} />);
  const input = screen.getByLabelText("应用修改需求");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(p.actions.run).not.toHaveBeenCalled();
  fireEvent.focus(input);
  expect(screen.queryByRole("log")).toBeNull();
  fireEvent.click(screen.getByLabelText("展开开发对话"));
  fireEvent.click(screen.getByRole("button", { name: /^预览$/ }));
  fireEvent.click(screen.getByRole("button", { name: /^上线$/ }));
  expect(p.actions.preview).toHaveBeenCalledOnce();
  expect(p.actions.publish).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: /检查与构建/ }));
  expect(p.actions.build).toHaveBeenCalledOnce();
  view.rerender(
    <AppDevelopmentDock
      {...p}
      interaction={{
        kind: "approval",
        reason: "Run command",
        toolName: "terminal",
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "允许本次" }));
  expect(p.actions.respond).toHaveBeenCalledWith("allowed-once");
});
it("requires the original source instead of generating a replacement template", () => {
  render(<AppDevelopmentDock {...props()} project={null} />);
  fireEvent.click(screen.getByLabelText("展开开发对话"));
  expect(screen.getByText("接入这个应用的源码")).toBeInTheDocument();
  expect(screen.getByLabelText("应用修改需求")).toBeDisabled();
  expect(screen.queryByRole("button", { name: /^上线$/ })).toBeNull();
});

it("imports source while excluding generated packages, dependencies and credentials", async () => {
  const importSource = vi.fn().mockResolvedValue(undefined);
  render(
    <AppDevelopmentDock
      {...props()}
      project={null}
      importSource={importSource}
    />,
  );
  const file = (path: string, text: string) => ({
    webkitRelativePath: `my-app/${path}`,
    size: text.length,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  });
  fireEvent.change(screen.getByLabelText("导入应用源码目录"), {
    target: {
      files: [
        file("manifest.json", '{"name":"my-app"}'),
        file("package.json", "{}"),
        file("src/App.tsx", "export default App"),
        file("app.localapp", "\0binary"),
        file(".env", "secret"),
        file("node_modules/pkg/index.js", "dependency"),
      ],
    },
  });
  await waitFor(() => expect(importSource).toHaveBeenCalledOnce());
  expect(importSource.mock.calls[0][0]).toEqual({
    "manifest.json": '{"name":"my-app"}',
    "package.json": "{}",
    "src/App.tsx": "export default App",
  });
});
it("uses the title to switch history without changing the expanded state", () => {
  const p = props();
  p.sessions = [
    { id: "old-session", title: "旧会话", createdAt: "2026-10-09T01:00:00Z" },
    { id: "current-session", title: "当前会话", createdAt: "2026-10-09T02:00:00Z" },
  ];
  p.selectedSession = "current-session";
  p.actions.selectSession = vi.fn();
  render(<AppDevelopmentDock {...p} />);
  fireEvent.keyDown(screen.getByLabelText("切换历史对话"), {key: "Enter"});
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.queryByRole("log")).toBeNull();
  expect(
    screen.getByRole("menuitemradio", { name: /当前会话/ }),
  ).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("menuitemradio", { name: /旧会话/ }));
  expect(p.actions.selectSession).toHaveBeenCalledWith("old-session");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.queryByRole("log")).toBeNull();
  fireEvent.click(screen.getByLabelText("展开开发对话"));
  fireEvent.keyDown(screen.getByLabelText("切换历史对话"), {key: "Enter"});
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("log")).toBeInTheDocument();
});

it("uses the composer plus for attachments without creating a conversation or expanding", () => {
  const p = props();
  p.actions.upload = vi.fn();
  p.actions.newSession = vi.fn();
  render(
    <AppDevelopmentDock
      {...p}
      attachments={[{ id: "file", name: "brief.pdf", size: 20 }]}
    />,
  );
  fireEvent.click(screen.getByLabelText("上传文件"));
  const files = [new File(["PDF"], "brief.pdf", { type: "application/pdf" })];
  fireEvent.change(screen.getByLabelText("选择对话附件"), {
    target: { files },
  });
  expect(p.actions.upload).toHaveBeenCalledWith(files);
  expect(p.actions.newSession).not.toHaveBeenCalled();
  expect(screen.queryByRole("log")).toBeNull();
  expect(screen.getByLabelText("待发送附件")).toHaveTextContent("brief.pdf");
});

it("reports default visibility and synchronizes minimize and reveal with the platform", () => {
  const p = props();
  const onVisibilityChange = vi.fn();
  const view = render(<AppDevelopmentDock {...p} onVisibilityChange={onVisibilityChange} />);
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  view.rerender(<AppDevelopmentDock {...p} onVisibilityChange={onVisibilityChange} minimize={1} />);
  expect(screen.getByLabelText("已最小化的开发对话")).toBeInTheDocument();
  expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  view.rerender(<AppDevelopmentDock {...p} onVisibilityChange={onVisibilityChange} minimize={1} reveal={1} />);
  expect(screen.getByLabelText("最小化开发对话")).toBeInTheDocument();
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByLabelText("最小化开发对话"));
  expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByLabelText("恢复开发对话"));
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
});

it("minimizes without stopping work, shows a spinner, then previews only the final reply", () => {
  const p = props();
  p.messages = [
    { role: "user", content: "request" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Intermediate" },
        { type: "toolCall", id: "tool", name: "read" },
      ],
    },
  ];
  const view = render(<AppDevelopmentDock {...p} running />);
  fireEvent.click(screen.getByLabelText("最小化开发对话"));
  expect(screen.getByLabelText("应用修改需求")).not.toBeVisible();
  expect(
    screen
      .getByLabelText("任务进行中，恢复对话")
      .querySelector(".dock-spinner"),
  ).not.toBeNull();
  expect(p.actions.stop).not.toHaveBeenCalled();
  fireEvent.mouseEnter(screen.getByLabelText("已最小化的开发对话"));
  expect(screen.queryByRole("tooltip")).toBeNull();
  view.rerender(
    <AppDevelopmentDock
      {...p}
      messages={[
        ...p.messages,
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Private reasoning" },
            { type: "text", text: "Final answer" },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByRole("tooltip")).toHaveTextContent("Final answer");
  expect(screen.getByRole("tooltip")).not.toHaveTextContent("Intermediate");
  expect(screen.getByRole("tooltip")).not.toHaveTextContent(
    "Private reasoning",
  );
  fireEvent.click(screen.getByLabelText("关闭消息预览"));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(screen.getByLabelText("恢复开发对话"));
  expect(screen.getByLabelText("应用修改需求")).toBeInTheDocument();
});
it("does not preview a previous turn after the latest user request has no final reply", () => {
  const p = props();
  p.messages = [
    { role: "assistant", content: "Previous reply" },
    { role: "user", content: "Latest request" },
  ];
  render(<AppDevelopmentDock {...p} />);
  fireEvent.click(screen.getByLabelText("最小化开发对话"));
  fireEvent.mouseEnter(screen.getByLabelText("已最小化的开发对话"));
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("shows the selected conversation title in the header, history and minimized preview", () => {
  const p = props();
  p.sessions = [{ id: "session", createdAt: "2026-10-09T12:00:00Z", title: "添加工作项筛选" }];
  p.selectedSession = "session";
  p.messages = [{ role: "assistant", content: "完成" }];
  render(<AppDevelopmentDock {...p} />);
  expect(screen.getByLabelText("切换历史对话").textContent).toContain("添加工作项筛选");
  fireEvent.keyDown(screen.getByLabelText("切换历史对话"), {key: "Enter"});
  expect(screen.getByRole("menuitemradio", { name: /添加工作项筛选/ })).toBeTruthy();
  fireEvent.click(screen.getByLabelText("最小化开发对话"));
  fireEvent.mouseEnter(screen.getByLabelText("已最小化的开发对话"));
  expect(screen.getByRole("tooltip").textContent).toContain("添加工作项筛选");
});

it("switches identity above history and hides developer actions in user mode", () => {
  const developer = props(), user = props();
  developer.sessions = [{ id: "developer-session", createdAt: "2026-10-09", title: "修改应用样式" }];
  developer.selectedSession = "developer-session";
  user.sessions = [{ id: "user-session", createdAt: "2026-10-09", title: "创建工作项" }];
  user.selectedSession = "user-session";
  user.prompt = "帮我创建工作项";
  const switchIdentity = vi.fn();
  const view = render(<AppDevelopmentDock {...developer} identity="developer" userConversation={user} onIdentityChange={switchIdentity} />);
  fireEvent.keyDown(screen.getByLabelText("切换历史对话"), {key: "Enter"});
  fireEvent.click(screen.getByLabelText("切换对话身份"));
  expect(switchIdentity).toHaveBeenCalledWith("user");
  expect(screen.getByRole("menuitemradio", { name: /修改应用样式/ })).toBeInTheDocument();
  expect(screen.queryByRole("menuitemradio", { name: /创建工作项/ })).toBeNull();
  view.rerender(<AppDevelopmentDock {...developer} identity="user" userConversation={user} onIdentityChange={switchIdentity} />);
  expect(screen.getByLabelText("应用对话消息")).toHaveValue("帮我创建工作项");
  expect(screen.getByRole("menu", { name: "应用历史对话" })).toBeInTheDocument();
  expect(screen.getByRole("menuitemradio", { name: /创建工作项/ })).toBeInTheDocument();
  expect(screen.queryByRole("menuitemradio", { name: /修改应用样式/ })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByLabelText("切换对话身份")).toBeNull();
  fireEvent.click(screen.getByLabelText("展开应用对话"));
  expect(screen.queryByLabelText("开发操作")).toBeNull();
  expect(screen.queryByLabelText("打开完整开发页")).toBeNull();
  fireEvent.click(screen.getByLabelText("发送对话消息"));
  expect(user.actions.run).toHaveBeenCalledOnce();
  expect(developer.actions.run).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByLabelText("切换历史对话"), {key: "Enter"});
  fireEvent.click(screen.getByLabelText("切换对话身份"));
  expect(switchIdentity).toHaveBeenLastCalledWith("developer");
  view.rerender(<AppDevelopmentDock {...developer} identity="user" userConversation={{ ...user, running: true }} onIdentityChange={switchIdentity} />);
  expect(screen.getByLabelText("切换对话身份")).toBeDisabled();
});

it("allows an owner without imported source to switch to user conversations", () => {
  render(<AppDevelopmentDock {...props()} project={null} identity="developer" onIdentityChange={vi.fn()} />);
  expect(screen.getByLabelText("切换历史对话")).toBeEnabled();
  fireEvent.keyDown(screen.getByLabelText("切换历史对话"), {key: "Enter"});
  expect(screen.getByLabelText("切换对话身份")).toBeEnabled();
});

it("mounts the native developer client and retains it while collapsed or minimized",()=>{
  const p=props();
  render(<AppDevelopmentDock {...p} identity="developer" application={{owner:"owner",name:"my-app"}}/>);
  const frame=screen.getByTitle("原生应用开发对话");
  expect(frame).toHaveAttribute("src","/api/development/projects/project/native/model/?localappCompact=1");
  fireEvent.click(screen.getByRole("button",{name:"展开开发对话"}));
  expect(screen.getByLabelText("应用修改需求")).toBeVisible();
  fireEvent.click(screen.getByRole("button",{name:"收起开发对话"}));
  expect(screen.getByTitle("原生应用开发对话")).toBe(frame);
  fireEvent.click(screen.getByRole("button",{name:"最小化开发对话"}));
  expect(screen.getByTitle("原生应用开发对话")).toBe(frame);
  fireEvent.click(screen.getByRole("button",{name:"恢复开发对话"}));
  expect(screen.getByTitle("原生应用开发对话")).toBe(frame);
});

it("updates the outer history menu from the current native client's catalog",async()=>{
  const p=props();
  render(<AppDevelopmentDock {...p} identity="developer" application={{owner:"owner",name:"my-app"}}/>);
  const frame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
  fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data:{type:"localapp:native-catalog",sessions:[{id:"new-native",title:"构建日历应用",updatedAt:1000}]}}));
  fireEvent.keyDown(screen.getByRole("button",{name:"切换历史对话"}),{key:"Enter"});
  expect(await screen.findByText("构建日历应用")).toBeVisible();
  fireEvent.click(screen.getByText("构建日历应用"));
  expect(p.actions.selectSession).toHaveBeenCalledWith("new-native");
});

it("cancels the selected native session and surfaces native refusal without using legacy stop",async()=>{
 const p=props();p.prompt="";render(<AppDevelopmentDock {...p} application={{owner:"owner",name:"my-app"}} />);
 const frame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
 fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data:{type:"localapp:native-selection",state:{sessionId:"native-one",title:"当前开发",running:true}}}));
 const post=vi.spyOn(frame.contentWindow!,"postMessage");
 fireEvent.click(screen.getByLabelText("停止开发"));
 expect(p.actions.stop).not.toHaveBeenCalled();
 await waitFor(()=>expect(post).toHaveBeenCalled());
 const request=post.mock.calls.at(-1)![0];expect(request).toMatchObject({type:"localapp:native-composer",sessionId:"native-one",action:"cancel"});
 fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data:{type:"localapp:native-composer-result",requestId:request.requestId,error:"取消失败，请重试"}}));
 await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent("取消失败，请重试"));
});

it("submits a collapsed draft to the selected native conversation and keeps it on refusal",async()=>{
 const p=props();render(<AppDevelopmentDock {...p} application={{owner:"owner",name:"my-app"}} />);
 const frame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
 fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data:{type:"localapp:native-selection",state:{sessionId:"native-one",title:"当前开发",running:false}}}));
 const post=vi.spyOn(frame.contentWindow!,"postMessage");
 fireEvent.click(screen.getByLabelText("发送修改需求"));
 expect(p.actions.run).not.toHaveBeenCalled();
 await waitFor(()=>expect(post).toHaveBeenCalled());
 const request=post.mock.calls.at(-1)![0];expect(request).toMatchObject({type:"localapp:native-composer",sessionId:"native-one",action:"submit",prompt:p.prompt});
 fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data:{type:"localapp:native-composer-result",requestId:request.requestId,error:"会话已切换"}}));
 await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent("会话已切换"));
 expect(p.actions.setPrompt).not.toHaveBeenCalledWith("");
});

it("continues workspace attachment receipts through the native composer",async()=>{
 const p=props();const remove=vi.fn();const attachment={id:"receipt",name:"brief.pdf",size:10,path:".localapp-attachments/receipt/brief.pdf"};
 render(<AppDevelopmentDock {...p} attachments={[attachment]} actions={{...p.actions,removeAttachment:remove}} application={{owner:"owner",name:"my-app"}}/>);
 const frame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
 fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data:{type:"localapp:native-selection",state:{sessionId:"native-one",title:"当前开发",running:false}}}));
 const post=vi.spyOn(frame.contentWindow!,"postMessage");fireEvent.click(screen.getByLabelText("发送修改需求"));
 await waitFor(()=>expect(post).toHaveBeenCalled());
 const request=post.mock.calls.at(-1)![0];expect(request.prompt).toContain(JSON.stringify(attachment.path));expect(p.actions.run).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
 fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data:{type:"localapp:native-composer-result",requestId:request.requestId}}));
 await waitFor(()=>expect(remove).toHaveBeenCalledWith(attachment.id));
});

it("retains attachment receipts with invalid workspace paths without calling a legacy agent",async()=>{
 const p=props();const remove=vi.fn();
 render(<AppDevelopmentDock {...p} attachments={[{id:"receipt",name:"brief.pdf",size:10,path:".localapp-attachments/receipt/../brief.pdf"}]} actions={{...p.actions,removeAttachment:remove}} application={{owner:"owner",name:"my-app"}}/>);
 fireEvent.click(screen.getByLabelText("发送修改需求"));
 await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent("附件缺少工作区路径"));
 expect(p.actions.run).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();expect(p.actions.setPrompt).not.toHaveBeenCalledWith("");
 expect(screen.getByLabelText("待发送附件")).toHaveTextContent("brief.pdf");
});

it("notifies the development controller of native turn transitions without treating history selection as a turn",()=>{
 const p=props();const activity=vi.fn();render(<AppDevelopmentDock {...p} actions={{...p.actions,nativeActivity:activity}} application={{owner:"owner",name:"my-app"}}/>);
 const frame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
 const announce=(running:boolean,sessionId="native-one")=>fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data:{type:"localapp:native-selection",state:{sessionId,title:"修改应用",running}}}));
 announce(false);expect(activity).not.toHaveBeenCalled();announce(true);announce(true);announce(false);
 expect(activity.mock.calls).toEqual([["native-one",true],["native-one",false]]);
 activity.mockClear();announce(true);announce(true,"native-two");announce(true,"native-two");announce(false,"native-two");
 expect(activity.mock.calls).toEqual([["native-one",true],["native-two",true],["native-two",false]]);
});

it("reports default visibility and synchronizes minimize and reveal with the platform", () => {
  const p = props();
  const onVisibilityChange = vi.fn();
  const view = render(<AppDevelopmentDock {...p} onVisibilityChange={onVisibilityChange} />);
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  view.rerender(<AppDevelopmentDock {...p} onVisibilityChange={onVisibilityChange} minimize={1} />);
  expect(screen.getByLabelText("已最小化的开发对话")).toBeInTheDocument();
  expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  view.rerender(<AppDevelopmentDock {...p} onVisibilityChange={onVisibilityChange} minimize={1} reveal={1} />);
  expect(screen.getByLabelText("最小化开发对话")).toBeInTheDocument();
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByLabelText("最小化开发对话"));
  expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByLabelText("恢复开发对话"));
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
});

it("allows queued messages during a native run and removes the full DSH entry",async()=>{
 const p=props();render(<AppDevelopmentDock {...p} application={{owner:"owner",name:"my-app"}} />);
 const frame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
 fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data:{type:"localapp:native-selection",state:{sessionId:"native-one",title:"当前开发",running:true}}}));
 expect(screen.getByLabelText("应用修改需求")).toBeEnabled();expect(screen.queryByLabelText("打开完整开发页")).toBeNull();
 const post=vi.spyOn(frame.contentWindow!,"postMessage");fireEvent.click(screen.getByLabelText("发送修改需求"));
 await waitFor(()=>expect(post).toHaveBeenCalled());
 const request=post.mock.calls.at(-1)![0];expect(request).toMatchObject({type:"localapp:native-composer",sessionId:"native-one",action:"submit",prompt:p.prompt});
 fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data:{type:"localapp:native-composer-result",requestId:request.requestId}}));
 await waitFor(()=>expect(p.actions.setPrompt).toHaveBeenCalledWith(""));
});
it("places the shared composer at the live transcript status seat",async()=>{
 const p=props();render(<AppDevelopmentDock {...p} application={{owner:"owner",name:"my-app"}} />);
 const frame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
 const doc=document.implementation.createHTMLDocument('native');doc.body.innerHTML='<div data-chat-running>深度求索中</div>';
 Object.defineProperty(frame,'contentDocument',{configurable:true,value:doc});fireEvent.load(frame);
 fireEvent(window,new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data:{type:"localapp:native-selection",state:{sessionId:"native-one",title:"当前开发",running:true}}}));
 fireEvent.click(screen.getByLabelText("展开开发对话"));
 await waitFor(()=>expect(doc.querySelector('[data-localapp-running-composer] textarea')).toBeTruthy());
 expect(doc.querySelector<HTMLElement>('[data-chat-running]')!.style.display).toBe('none');
 expect(document.querySelector('.app-development-dock > .development-dock-composer')).toBeNull();
});
it("keeps page annotations out of the draft and presents a removable summary",async()=>{
 const p=props();p.actions.setPrompt=vi.fn();
 render(<AppDevelopmentDock {...p} />);
 const root=document.createElement('main');root.setAttribute('data-localapp-app-root','');root.innerHTML='<h1 id="annotated-title">A short page title</h1>';document.body.append(root);
 fireEvent.click(screen.getByLabelText('标记页面问题'));fireEvent.click(root.querySelector('h1')!);
 await waitFor(()=>expect(screen.getByLabelText('待发送页面标记')).toBeVisible());
 expect(screen.getByLabelText('应用修改需求')).toHaveValue('Make a todo app');expect(p.actions.setPrompt).not.toHaveBeenCalled();
 expect(screen.getByLabelText('待发送页面标记')).toHaveTextContent('h1 · A short page title');
 expect(screen.getByLabelText('待发送页面标记')).not.toHaveTextContent('selector');
 fireEvent.click(screen.getByLabelText('移除页面标记'));
 await waitFor(()=>expect(screen.queryByLabelText('待发送页面标记')).toBeNull());root.remove();
});
