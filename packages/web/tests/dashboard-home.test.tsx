import React from "react";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HomePage from "../app/(dashboard)/page";

vi.mock("@/components/auth-modals/auth-provider", () => ({ useAuthModals: () => ({ openLogin: vi.fn() }) }));
vi.mock("@/components/development/create-application-dialog", () => ({
  CreateApplicationDialog: ({ open }: { open: boolean }) => open ? <div role="dialog" aria-label="创建应用">创建应用需求</div> : null,
}));
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const data = url === "/api/me" ? { id: "owner", name: "alice", displayName: "小明" }
      : url.includes("/pages?") ? Array.from({ length: 14 }, (_, i) => ({ name: `app-${i}`, currentVersion: 2, updatedAt: new Date().toISOString() }))
      : url.includes("/favorites?") ? [{ pagePath: "bob/team", pageName: "团队看板", ownerName: "bob", createdAt: new Date().toISOString() }]
      : url.includes("/recent?") ? Array.from({ length: 9 }, (_, i) => ({ pagePath: `bob/recent-${i}`, lastVisitedAt: new Date().toISOString() })) : [];
    return new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("limits home collections without losing full-list navigation or app owners", async () => {
  render(<HomePage />);
  await screen.findByRole("link", { name: "打开 app-0" });
  expect(screen.getAllByRole("link", { name: /^打开 app-/ })).toHaveLength(8);
  expect(screen.getByRole("link", { name: "打开 app-0" })).toHaveAttribute("href", "/alice/app-0");
  expect(screen.getByRole("link", { name: /团队看板/ })).toHaveAttribute("href", "/bob/team");
  expect(screen.queryByText("recent-5")).not.toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: /查看全部/ })).toHaveLength(3);
});

it("opens real creation and local development dialogs only when requested", async () => {
  render(<HomePage />);
  await screen.findByRole("heading", { name: "你的应用工作台" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "创建应用", exact: true }));
  expect(screen.getByRole("dialog", { name: "创建应用" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "本地开发", exact: true }));
  expect(screen.getByRole("dialog", { name: "在自己的电脑上开发" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "连接" })).toBeInTheDocument();
});

it("keeps failed app lists distinct from an empty account", async () => {
  const fetcher = vi.mocked(fetch);
  fetcher.mockImplementation(async input => new Response(JSON.stringify(String(input) === "/api/me" ? { success: true, data: { id: "owner", name: "alice" } } : { success: false, error: "unavailable" })));
  render(<HomePage />);
  expect(await screen.findAllByRole("alert")).toHaveLength(3);
  expect(screen.queryByRole("button", { name: "创建第一个应用" })).not.toBeInTheDocument();
});
