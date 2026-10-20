import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginDialog } from "./login-dialog";
import { resolveAuthReturnTo } from "./auth-return";

const authState = vi.hoisted(() => ({
  loginOpen: true,
  loginReturnTo: "/test-owner/outer-ai-usage/?tab=records#latest" as string | null,
  closeLogin: vi.fn(),
  openChangePassword: vi.fn(),
  setPendingOldPassword: vi.fn(),
}));

vi.mock("./auth-provider", () => ({ useAuthModals: () => authState }));

describe("LoginDialog return target", () => {
  const originalLocation = window.location;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    authState.loginReturnTo = "/test-owner/outer-ai-usage/?tab=records#latest";
    delete (window as any).location;
    (window as any).location = originalLocation;
  });

  it("returns to the blocked application after login", async () => {
    const mockLocation = { href: "http://localhost/test-owner/outer-ai-usage/", origin: "http://localhost" };
    delete (window as any).location;
    (window as any).location = mockLocation;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    })));

    render(<LoginDialog />);
    fireEvent.change(screen.getByLabelText("用户名或邮箱"), { target: { value: "test-owner" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "123456" } });
    fireEvent.submit(screen.getByRole("button", { name: "登录" }).closest("form")!);

    await waitFor(() => expect(mockLocation.href).toBe("/test-owner/outer-ai-usage/?tab=records#latest"));
  });

  it.each([
    ["http://localhost/app/", "/app/"],
    ["http://localhost/app/#records", "/app/#records"],
    ["http://localhost/app/#old", "/app/#records"],
  ])("reloads the authenticated document when returning from %s to %s", async (current, target) => {
    const reload = vi.fn();
    const mockLocation = { href: current, origin: "http://localhost", reload };
    delete (window as any).location;
    (window as any).location = mockLocation;
    const replace = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    authState.loginReturnTo = target;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    })));

    render(<LoginDialog />);
    fireEvent.change(screen.getByLabelText("用户名或邮箱"), { target: { value: "test-owner" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "123456" } });
    fireEvent.submit(screen.getByRole("button", { name: "登录" }).closest("form")!);

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledWith(window.history.state, "", target);
    expect(authState.closeLogin).toHaveBeenCalledOnce();
  });

  it("keeps the dialog open and shows a rejected login", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false, error: "Invalid credentials" }), { status: 401 })));
    render(<LoginDialog />);
    fireEvent.submit(screen.getByRole("button", { name: "登录" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
    expect(authState.closeLogin).not.toHaveBeenCalled();
  });

  it("rejects cross-origin return targets", () => {
    expect(resolveAuthReturnTo("https://evil.example/steal-session")).toBe("/");
  });
});
