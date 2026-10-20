import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { HarnessAgent } from "@localapp/sdk-agent/harness-client";
import { AppConversationDock } from "./app-conversation-dock";
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => ({ok:true,json:async()=>({success:true,data:{enabled:true,identities:[{id:"user"},{id:"developer"}]}})}))));
const { developerMount, developerLoad } = vi.hoisted(() => ({ developerMount: vi.fn(), developerLoad: vi.fn() }));
vi.mock("./development-page", () => { developerLoad(); return { DevelopmentPage: (props: any) => { developerMount(props); return <div>开发者控制器</div>; } }; });
vi.mock("./dsh-view", () => ({ DshMessages: () => null, DshMarkdown: () => null, DshDiff: () => null, DshTerminal: () => null }));

it("gives ordinary users the shared chat without mounting development APIs", async () => {
  HTMLElement.prototype.scrollTo = vi.fn();
  developerMount.mockClear();
  const agent = {
    appId: "owner/app", sessionId: "session", providerId: undefined,
    state: { messages: [], interactions: [], isStreaming: false },
    settings: vi.fn(async () => ({ providers: [{ id: "model", name: "我的模型", model: "test" }], defaultProviderId: "model" })),
    listSessions: vi.fn(async () => []), subscribe: vi.fn(() => () => {}), startBackgroundEvents: vi.fn(),
  };
  const onSend = vi.fn(async () => {});
  render(<AppConversationDock application={{ owner: "owner", name: "app" }} isOwner={false} agent={agent as unknown as HarnessAgent} onSend={onSend} />);
  await waitFor(() => expect(screen.getByLabelText("对话模型")).toHaveTextContent("我的模型 · test"));
  expect(screen.queryByLabelText("切换对话身份")).toBeNull();
  expect(screen.queryByLabelText("打开完整开发页")).toBeNull();
  fireEvent.change(screen.getByLabelText("应用对话消息"), { target: { value: "添加工作项" } });
  fireEvent.click(screen.getByLabelText("发送对话消息"));
  await waitFor(() => expect(screen.getAllByText("原生会话尚未就绪").length).toBeGreaterThan(0));
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.getByLabelText("应用对话消息")).toHaveValue("添加工作项");
  expect(developerMount).not.toHaveBeenCalled();
  expect(developerLoad).not.toHaveBeenCalled();
});

it("offers owner identity switching while keeping a separate user conversation", async () => {
  developerMount.mockClear();
  render(<AppConversationDock application={{ owner: "owner", name: "app" }} isOwner agent={null} onSend={vi.fn()} />);
  await waitFor(() => expect(developerMount).toHaveBeenCalled());
  const props = developerMount.mock.calls.at(-1)![0];
  expect(props.dock.identity).toBe("developer");
  expect(props.dock.onIdentityChange).toBeTypeOf("function");
  expect(props.dock.userConversation.messages).toEqual([]);
  expect(props.dock.userConversation.project.id).toBe("application");
});

it("keeps application-owner chat usable without the development plugin", async () => {
  developerMount.mockClear();
  vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,json:async()=>({success:true,data:{enabled:true,identities:[{id:"user"}]}})})));
  render(<AppConversationDock application={{owner:"owner",name:"app"}} isOwner agent={null} onSend={vi.fn()}/>);
  await screen.findByLabelText("应用对话消息");
  expect(developerMount).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("切换对话身份")).toBeNull();
});
it("does not render an entry when the Agent UI plugin is disabled", async () => {
  developerMount.mockClear();
  vi.stubGlobal("fetch",vi.fn(async()=>({ok:false})));
  render(<AppConversationDock application={{owner:"owner",name:"app"}} isOwner agent={null} onSend={vi.fn()}/>);
  await waitFor(()=>expect(fetch).toHaveBeenCalledWith("/api/agent/ui",expect.anything()));
  expect(screen.queryByLabelText("应用对话消息")).toBeNull();
  expect(developerMount).not.toHaveBeenCalled();
});

it("keeps creation development available with user AI disabled and supports explicit developer reveal", async () => {
  developerMount.mockClear();
  const view = render(<AppConversationDock application={{owner:"owner",name:"app"}} isOwner agent={null} onSend={vi.fn()} userConversationEnabled={false}/>);
  await waitFor(() => expect(developerMount).toHaveBeenCalled());
  let props = developerMount.mock.calls.at(-1)![0];
  expect(props.dock.identity).toBe("developer");
  expect(props.dock.userConversationEnabled).toBe(false);
  props.dock.onIdentityChange("user");
  await waitFor(() => expect(developerMount.mock.calls.at(-1)![0].dock.identity).toBe("user"));
  view.rerender(<AppConversationDock application={{owner:"owner",name:"app"}} isOwner agent={null} onSend={vi.fn()} userConversationEnabled={false} developerReveal={1}/>);
  await waitFor(() => expect(developerMount.mock.calls.at(-1)![0].dock.identity).toBe("developer"));
});
