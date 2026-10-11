import { render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformShell } from "./platform-shell";

const routerPush = vi.hoisted(() => vi.fn());
const openLogin = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("@/components/auth-modals/auth-provider", () => ({
  useAuthModals: () => ({ openLogin }),
}));

vi.mock("./platform-agent", () => ({
  usePlatformAgent: () => ({
    chatMessages: [],
    isRunning: false,
    aiError: null,
    agentSend: vi.fn(),
    handleToolResult: vi.fn(),
  }),
}));

class MockEventSource {
  static urls: string[] = [];
  constructor(url: string) { MockEventSource.urls.push(url); }
  addEventListener() {}
  close() {}
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  routerPush.mockReset();
  openLogin.mockReset();
  MockEventSource.urls = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

describe("PlatformShell offline lifecycle", () => {
  it("loads development preview resources without platform presence", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/me") return json({success:true,data:{id:"preview",name:"开发预览"}});
      if (url.includes("/meta")) return json({success:true,data:{name:"preview-app",userId:"preview",lifecycleStatus:"online",developmentPreview:true}});
      if (url.includes("/api/favorites")) return json({success:true,data:{count:0,favorited:false}});
      return new Response('<html><body><div id="root"></div><script type="module" src="./preview.js"></script></body></html>',{headers:{"Content-Type":"text/html"}});
    });
    vi.stubGlobal("fetch",fetchMock);
    render(<PlatformShell userId="preview" name="preview-app"/>);
    await waitFor(()=>expect(document.querySelector('script[data-localapp-app-asset$="/preview.js"]')).not.toBeNull());
    expect(fetchMock.mock.calls.some(([url])=>String(url).includes("/presence/"))).toBe(false);
    expect(MockEventSource.urls).toEqual([]);
  });

  it("opens login in place and preserves the blocked application URL", async () => {
    window.history.replaceState({}, "", "/owner/private-app/?tab=billing#usage");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/me") return json({ success: false });
      if (url.includes("/meta")) return json({ success: true, data: { name: "private-app", userId: "owner", lifecycleStatus: "online" } });
      if (url.includes("/api/favorites")) return json({ success: true, data: { count: 0, favorited: false } });
      if (url.startsWith("/api/issues?")) return json({ success: true, data: [], meta: { open: 0 } });
      return new Response("<html><body><div id=\"root\"></div><script type=\"module\" src=\"/app.js\"></script></body></html>", { headers: { "Content-Type": "text/html" } });
    }));

    render(<PlatformShell userId="owner" name="private-app" />);
    await waitFor(() => expect(document.querySelector("[data-localapp-native-shell]")).not.toBeNull());

    const handled = !window.dispatchEvent(new CustomEvent("localapp:platform_request", {
      cancelable: true,
      detail: { type: "localapp:platform_request", id: "login-1", capability: "auth.login" },
    }));

    expect(handled).toBe(true);
    expect(openLogin).toHaveBeenCalledWith({ returnTo: "/owner/private-app/?tab=billing#usage" });
  });

  it("keeps platform navigation and does not load offline app resources or presence", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/me") return json({ success: true, data: { id: "owner", name: "owner" } });
      if (url === "/api/pages/owner/offline-app/meta") {
        return json({ success: true, data: { name: "offline-app", userId: "owner", lifecycleStatus: "offline" } });
      }
      if (url.includes("/api/favorites")) return json({ success: true, data: { count: 0, favorited: false } });
      if (url.startsWith("/api/issues?")) return json({ success: true, data: [], meta: { open: 0 } });
      return new Response("<html><body><div id=\"root\"></div></body></html>", { headers: { "Content-Type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<PlatformShell userId="owner" name="offline-app" />);

    expect(await screen.findByRole("heading", { name: "应用暂时下线" })).toBeInTheDocument();
    expect(container.querySelector("[data-localapp-native-shell]")).not.toBeNull();
    expect(within(screen.getByTestId("localapp-platform-nav-left")).getByText("offline-app")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新状态" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用设置" })).toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/pages/owner/offline-app/meta", { credentials: "include" }));
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/serve/owner/offline-app/")).toBe(false);
    expect(MockEventSource.urls).toEqual([]);
  });

  it("does not show application settings to a non-owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/me") return json({ success: true, data: { id: "viewer", name: "viewer" } });
      if (url.includes("/meta")) return json({ success: true, data: { name: "offline-app", userId: "owner", lifecycleStatus: "offline" } });
      if (url.includes("/api/favorites")) return json({ success: true, data: { count: 0, favorited: false } });
      return json({ success: true, data: [], meta: { open: 0 } });
    }));

    render(<PlatformShell userId="owner" name="offline-app" />);

    expect(await screen.findByRole("heading", { name: "应用暂时下线" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "应用设置" })).toBeNull();
  });

  it("fails closed when lifecycle metadata cannot be confirmed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/me") return json({ success: true, data: { id: "owner", name: "owner" } });
      if (url === "/api/pages/owner/unknown-app/meta") {
        return new Response(JSON.stringify({ success: false, error: "unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/favorites")) return json({ success: true, data: { count: 0, favorited: false } });
      if (url.startsWith("/api/issues?")) return json({ success: true, data: [], meta: { open: 0 } });
      return new Response("<html><body><div id=\"root\"></div></body></html>", { headers: { "Content-Type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformShell userId="owner" name="unknown-app" />);

    expect(await screen.findByRole("heading", { name: "暂时无法加载应用" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/serve/owner/unknown-app/")).toBe(false);
    expect(MockEventSource.urls).toEqual([]);
  });
});

it.each(["disabled", "missing", "failure", "network"])("keeps developer controls hidden when plugin status is %s", async state => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/system/plugins") {
      if (state === "network") throw new Error("Network unavailable");
      if (state === "failure") return new Response("Unavailable", { status: 503 });
      return json(state === "missing" ? { success: true, data: {} } : { success: true, data: { development: false } });
    }
    if (url === "/api/me") return json({ success: true, data: { id: "owner", name: "owner" } });
    if (url.includes("/meta")) return json({ success: true, data: { name: "plugin-app", userId: "owner", lifecycleStatus: "online" } });
    if (url.includes("/api/favorites")) return json({ success: true, data: { count: 0, favorited: false } });
    if (url.startsWith("/api/issues?")) return json({ success: true, data: [], meta: { open: 0 } });
    return json({ success: true, data: [] });
  }));
  const view = render(<PlatformShell userId="owner" name="plugin-app" />);
  await screen.findByRole("button", { name: "展开应用对话" });
  expect(screen.queryByRole("button", { name: "展开开发对话" })).toBeNull();
  view.unmount();
});
