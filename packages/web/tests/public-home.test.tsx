import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomePage from "../app/(dashboard)/page";

vi.mock("@/components/auth-modals/auth-provider", () => ({
  useAuthModals: () => ({ openLogin: vi.fn() }),
}));

describe("public home", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/me") {
          return new Response(JSON.stringify({ success: false }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "/api/home/stats") {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                users: 12,
                pages: 8,
                schemas: 16,
                deploys: 42,
                monthDeploys: 7,
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            latest: "1.0.0",
            min: "1.0.0",
            versions: {
              "1.0.0": {
                platforms: {
                  "macos/aarch64": "/api/cli/download?os=macos&arch=aarch64",
                },
              },
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("presents LocalApp as an Agent application platform", async () => {
    render(<HomePage />);

    expect(
      await screen.findByRole("heading", {
        name: "把你的想法，变成每天用的应用。",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("开发")).toBeInTheDocument();
    expect(screen.getByText("上线")).toBeInTheDocument();
    expect(screen.getByText("源码在你手里")).toBeInTheDocument();
    expect(screen.getByText("专注应用本身")).toBeInTheDocument();
    expect(screen.getByText("每个人各有空间")).toBeInTheDocument();
    expect(screen.queryByText("Agent 应用发射台")).not.toBeInTheDocument();
    expect(screen.queryByText("CDN")).not.toBeInTheDocument();
  });

  it("offers a copyable starter.md instruction for agents", async () => {
    render(<HomePage />);

    expect(await screen.findByText("使用外部 Agent 在本地开发")).toBeInTheDocument();
    const phrase = screen.getByText(
      /阅读 http:\/\/localhost:3000\/starter\.md，按照本地开发流程/,
    );
    expect(phrase).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "查看 starter.md 完整说明" }),
    ).toHaveAttribute("href", "/starter.md");
  });

  it("shows only valid CLI commands in the workflow", async () => {
    render(<HomePage />);

    await screen.findByRole("heading", {
      name: "把你的想法，变成每天用的应用。",
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "连接" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      screen.getByText("localapp login http://localhost:3000 --profile online --api-key <API_KEY>"),
    ).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "开发" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText("localapp app pull --profile online --name my-app --directory ./my-app")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "上线" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      screen.getByText("localapp app push --profile online --directory ./my-app"),
    ).toBeInTheDocument();
  });
});
