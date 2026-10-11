import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppShell from "./app-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/my/info",
}));

vi.mock("@/components/auth-modals/auth-provider", () => ({
  useAuthModals: () => ({ openLogin: vi.fn() }),
}));

describe("AppShell dashboard content width", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({
      success: true,
      data: String(input) === "/api/system/plugins" ? { applications: true, development: true } : { id: "u1", name: "test-owner", role: "user" },
    }), { headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "(max-width: 1023px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a 1600px shared content cap while preserving responsive padding", async () => {
    render(<AppShell><div data-testid="dashboard-content">内容</div></AppShell>);

    const content = await screen.findByTestId("dashboard-content");
    expect(content.parentElement).toHaveClass("mx-auto", "max-w-[1600px]", "p-4", "md:p-6");
    expect(content.parentElement).not.toHaveClass("max-w-7xl");
  });

  it("shows task history but not system administration to an ordinary user", async () => {
    render(<AppShell><div>content</div></AppShell>);

    expect(await screen.findByRole("link", { name: "任务" })).toHaveAttribute("href", "/my/tasks");
    expect(screen.getByRole("link", { name: "设备通知" })).toHaveAttribute("href", "/my/device-notifications");
    expect(screen.queryByRole("link", { name: "系统设置" })).toBeNull();
  });
});

describe("AppShell control-plane navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({
      success: true,
      data: String(input) === "/api/system/plugins" ? { applications: true, development: true } : { id: "admin", name: "admin", role: "admin" },
    }), { headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "(max-width: 1023px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows application development and administration without the retired Studio entry", async () => {
    render(<AppShell><div>content</div></AppShell>);

    expect(await screen.findByRole("link", { name: "应用开发" })).toHaveAttribute("href", "/my/development");
    expect(screen.queryByRole("link", { name: "Studio" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "任务" })).toHaveAttribute("href", "/my/tasks");
    expect(screen.getByRole("link", { name: "设备通知" })).toHaveAttribute("href", "/my/device-notifications");
    expect(screen.getByRole("link", { name: "对端连接" })).toHaveAttribute("href", "/my/peers");
    expect(screen.getByRole("link", { name: "系统设置" })).toHaveAttribute("href", "/my/system");
  });
});

describe("AppShell plugin combinations", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    { combination: "multiuser", applications: false, development: false },
    { combination: "platform", applications: true, development: false },
    { combination: "full", applications: true, development: true },
  ])("shows only contributions available in $combination", async plugins => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({ success: true, data: url === "/api/system/plugins" ? plugins : { id: "admin", name: "admin", role: "admin" } }))));
    render(<AppShell><div>content</div></AppShell>);
    expect(await screen.findByRole("link", { name: "模型与 Agent" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "用户管理" })).toBeInTheDocument();
    expect(Boolean(screen.queryByRole("link", { name: "我的应用" }))).toBe(plugins.applications);
    expect(Boolean(screen.queryByRole("link", { name: "应用管理" }))).toBe(plugins.applications);
    expect(Boolean(screen.queryByRole("link", { name: "设备通知" }))).toBe(plugins.applications);
    expect(Boolean(screen.queryByRole("link", { name: "应用开发" }))).toBe(plugins.development);
    expect(Boolean(screen.queryByRole("link", { name: "任务" }))).toBe(plugins.development);
  });
});

it.each(["network", "http", "missing"])("hides plugin navigation when status is %s", async state => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/system/plugins") {
      if (state === "network") throw new Error("Network unavailable");
      if (state === "http") return new Response(JSON.stringify({ success: true, data: { applications: true, development: true } }), { status: 503 });
      return new Response(JSON.stringify({ success: true, data: {} }));
    }
    return new Response(JSON.stringify({ success: true, data: { id: "admin", name: "admin", role: "admin" } }));
  }));
  const view = render(<AppShell><div>content</div></AppShell>);
  await screen.findByRole("link", { name: "模型与 Agent" });
  expect(screen.queryByRole("link", { name: "应用开发" })).toBeNull();
  expect(screen.queryByRole("link", { name: "我的应用" })).toBeNull();
  expect(screen.getByRole("link", { name: "用户管理" })).toBeInTheDocument();
  view.unmount(); vi.unstubAllGlobals();
});
