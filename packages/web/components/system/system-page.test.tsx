import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemPage } from "./system-page";

describe("SystemPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (String(input) === "/api/system/settings/network" && options?.method === "PUT") {
        return new Response(JSON.stringify({ success: true, data: { restarting: true } }), { status: 202 });
      }
      return new Response(JSON.stringify({ success: true, data: {
        listenHost: "127.0.0.1", listenPort: 3000, publicUrl: "", workspaceDir: "workspaces", allowInsecureLan: false,
      } }));
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("requests an administrator network setting change with credentials", async () => {
    render(<SystemPage />);
    await screen.findByLabelText("监听端口");
    fireEvent.change(screen.getByLabelText("监听主机"), { target: { value: "0.0.0.0" } });
    fireEvent.change(screen.getByLabelText("监听端口"), { target: { value: "43127" } });
    fireEvent.click(screen.getByLabelText("允许不安全的局域网访问"));
    fireEvent.click(screen.getByRole("button", { name: "保存并重启" }));

    await waitFor(() => expect(screen.getByText("已请求重启以应用网络设置")).toBeInTheDocument());
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/system/settings/network", expect.objectContaining({
      method: "PUT",
      credentials: "include",
      body: JSON.stringify({ listenHost: "0.0.0.0", listenPort: 43127, allowInsecureLan: true }),
    }));
  });

  it("shows a load error and retries instead of leaving the page loading forever", async () => {
    let attempts = 0;
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url) === "/api/system/plugins") return new Response(JSON.stringify({ success: true, data: { development: true } }));
      attempts += 1;
      if (attempts === 1) return new Response(JSON.stringify({ success: false, error: "网络不可用" }), { status: 503 });
      return new Response(JSON.stringify({ success: true, data: {
        listenHost: "127.0.0.1", listenPort: 3000, publicUrl: "", workspaceDir: "workspaces", allowInsecureLan: false,
      } }));
    });
    render(<SystemPage />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("网络不可用"));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByLabelText("监听端口")).toHaveValue(3000);
  });
  it("hides application development environment in a reduced plugin combination", async () => {
    vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify({ success: true, data: String(url) === "/api/system/plugins" ? { development: false } : { listenHost: "127.0.0.1", listenPort: 3000, publicUrl: "", workspaceDir: "workspaces", allowInsecureLan: false } })));
    render(<SystemPage />);
    await screen.findByLabelText("监听端口");
    expect(screen.queryByRole("tab", { name: "应用开发环境" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Python 环境" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "插件组合" })).toBeInTheDocument();
  });

});

it.each(["network", "http", "missing"])("hides development environment when plugin status is %s", async state => {
  vi.stubGlobal("fetch", vi.fn(async input => {
    if (String(input) === "/api/system/plugins") {
      if (state === "network") throw new Error("Network unavailable");
      if (state === "http") return new Response(JSON.stringify({ success: true, data: { development: true } }), { status: 503 });
      return new Response(JSON.stringify({ success: true, data: {} }));
    }
    return new Response(JSON.stringify({ success: true, data: { listenHost: "127.0.0.1", listenPort: 3000, publicUrl: "", workspaceDir: "workspaces", allowInsecureLan: false } }));
  }));
  const view = render(<SystemPage />);
  await screen.findByLabelText("监听端口");
  expect(screen.queryByRole("tab", { name: "应用开发环境" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Python 环境" })).toBeInTheDocument();
  view.unmount(); vi.unstubAllGlobals();
});
