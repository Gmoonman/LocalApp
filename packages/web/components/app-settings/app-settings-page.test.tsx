import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSettingsPage } from "./app-settings-page";

const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

const settings = {
  app: {
    name: "demo",
    userId: "owner",
    currentVersion: 2,
    versionCount: 2,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T01:00:00.000Z",
    lifecycleStatus: "online",
    versions: [
      { version: 2, createdAt: "2026-07-19T01:00:00.000Z", fileCount: 4, totalSize: 2048 },
    ],
  },
  sourceKind: "uploaded",
  sourceManifest: { description: "source", shell: { navbar: true }, db: { mode: "crud" } },
  platformManifest: { description: "platform", shell: { navbar: false } },
  effectiveManifest: { description: "platform", shell: { navbar: false }, db: { mode: "crud" } },
  platformEditableKeys: ["description", "pageAccess", "shell", "db", "notify", "lifecycle"],
};

describe("AppSettingsPage", () => {
  let lifecycleStatus: "online" | "offline";

  beforeEach(() => {
    lifecycleStatus = "online";
    routerPush.mockReset();
    window.history.replaceState(null, "", "/");
    vi.spyOn(window, "prompt").mockReturnValue("demo");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (String(input).endsWith("/data")) {
        return new Response(JSON.stringify({ success: true, data: {
          database: { exists: true, size: 4096 },
          files: { count: 2, size: 6144 },
          backups: [
            { id: "zip", name: "complete", createdAt: "2026-07-20T00:00:00.000Z", size: 3072, source: "manual", format: "zip", fileCount: 2, fileSize: 6144 },
            { id: "db", name: "legacy", createdAt: "2026-07-19T00:00:00.000Z", size: 1024, source: "automatic", format: "legacy-db", fileCount: 0, fileSize: 0 },
          ],
        } }));
      }
      if (url.endsWith("/lifecycle") && options?.method === "PUT") {
        lifecycleStatus = JSON.parse(String(options.body)).status;
      }
      if (url.endsWith("/data/factory-reset") && options?.method === "POST") lifecycleStatus = "online";
      if (url === "/api/me/pages/demo" && options?.method === "DELETE") {
        return new Response(JSON.stringify({ success: true, data: { deleted: true, name: "demo" } }));
      }
      const currentSettings = {
        ...settings,
        app: { ...settings.app, lifecycleStatus },
        platformManifest: { ...settings.platformManifest, lifecycle: { status: lifecycleStatus } },
      };
      return new Response(JSON.stringify({ success: true, data: currentSettings }));
    }));
  });

  it("renders categorized tabs and application information", async () => {
    const { container } = render(React.createElement(AppSettingsPage, { name: "demo" }));
    await screen.findByRole("heading", { name: "demo 设置" });

    for (const tab of ["应用信息", "基础设置", "访问控制", "数据权限", "通知", "数据管理", "应用管理"]) {
      expect(screen.getByRole("tab", { name: tab })).toBeInTheDocument();
    }
    expect(container.firstElementChild).toHaveClass("w-full");
    expect(container.firstElementChild).not.toHaveClass("max-w-5xl");
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.getAllByText("v2").length).toBeGreaterThan(0);
  });

  it("switches between editable platform config and read-only source config", async () => {
    render(React.createElement(AppSettingsPage, { name: "demo" }));
    await screen.findByRole("heading", { name: "demo 设置" });
    fireEvent.click(screen.getByRole("tab", { name: "基础设置" }));

    const description = screen.getByLabelText("应用描述");
    expect(description).toHaveValue("platform");
    expect(description).toBeEnabled();
    expect(screen.getByRole("button", { name: "平台配置" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "应用自带配置" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "应用自带配置" }));
    await waitFor(() => expect(screen.getByLabelText("应用描述")).toHaveValue("source"));
    expect(screen.getByLabelText("应用描述")).toBeDisabled();
    expect(screen.getByText("只读")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "平台配置" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "应用自带配置" })).toHaveAttribute("aria-pressed", "true");
  });

  it("saves the Agent conversation switch and keeps source configuration read-only", async () => {
    render(<AppSettingsPage name="demo" />);
    await screen.findByRole("heading", { name: "demo 设置" });
    fireEvent.click(screen.getByRole("tab", { name: "基础设置" }));
    expect(screen.getByRole("switch", { name: "启用 Agent 对话框" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "启用 Agent 对话框" }));
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/me/pages/demo/settings/manifest-platform", expect.objectContaining({
      method: "PUT", body: expect.any(String),
    })));
    const call = vi.mocked(fetch).mock.calls.find(([url, options]) => String(url).endsWith("/manifest-platform") && options?.method === "PUT");
    expect(JSON.parse(String(call?.[1]?.body)).shell).toEqual({ navbar: false, agentConversation: true });
    fireEvent.click(screen.getByRole("button", { name: "应用自带配置" }));
    expect(screen.getByRole("switch", { name: "启用 Agent 对话框" })).toBeDisabled();
  });

  it("inherits an enabled source setting until the owner explicitly overrides it", async () => {
    const currentFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      const response = await currentFetch(...args);
      const body = await response.json();
      body.data.sourceManifest.shell.agentConversation = true;
      return new Response(JSON.stringify(body));
    }));
    render(<AppSettingsPage name="demo" />);
    await screen.findByRole("heading", { name: "demo 设置" });
    fireEvent.click(screen.getByRole("tab", { name: "基础设置" }));
    expect(screen.getByRole("switch", { name: "启用 Agent 对话框" })).toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "启用 Agent 对话框" }));
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true));
    const call = vi.mocked(fetch).mock.calls.find(([, options]) => options?.method === "PUT");
    expect(JSON.parse(String(call?.[1]?.body)).shell.agentConversation).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "应用自带配置" }));
    expect(screen.getByRole("switch", { name: "启用 Agent 对话框" })).toBeChecked();
  });

  it("keeps the configuration source switcher in the header across all tabs", async () => {
    render(React.createElement(AppSettingsPage, { name: "demo" }));
    await screen.findByRole("heading", { name: "demo 设置" });

    const switcher = screen.getByRole("group", { name: "配置来源" });
    const tablist = screen.getByRole("tablist");
    expect(switcher.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "数据管理" }));
    expect(screen.getByRole("group", { name: "配置来源" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "应用管理" }));
    expect(screen.getByRole("group", { name: "配置来源" })).toBeInTheDocument();
  });

  it("shows complete application data and imports a ZIP archive", async () => {
    const { container } = render(React.createElement(AppSettingsPage, { name: "demo" }));
    await screen.findByRole("heading", { name: "demo 设置" });
    fireEvent.click(screen.getByRole("tab", { name: "数据管理" }));

    await screen.findByRole("heading", { name: "应用数据" });
    expect(screen.getAllByText(/2 个文件/).length).toBeGreaterThan(0);
    expect(screen.getByText("完整数据包")).toBeInTheDocument();
    expect(screen.getByText("旧格式，仅数据库")).toBeInTheDocument();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain(".zip");
    const archive = new File(["zip"], "data.zip", { type: "application/zip" });
    fireEvent.change(input, { target: { files: [archive] } });

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls;
      const request = calls.find(([url, options]) => String(url).endsWith("/data/import") && options?.method === "POST");
      expect(request).toBeDefined();
      const form = request?.[1]?.body as FormData;
      expect(form.get("archive")).toBe(archive);
      expect(form.get("database")).toBeNull();
    });
  });

  it("takes an app offline and brings it back online from application management", async () => {
    render(React.createElement(AppSettingsPage, { name: "demo" }));
    await screen.findByRole("heading", { name: "demo 设置" });
    fireEvent.click(screen.getByRole("tab", { name: "基础设置" }));
    fireEvent.change(screen.getByLabelText("应用描述"), { target: { value: "unsaved draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "应用管理" }));

    expect(screen.getByRole("heading", { name: "运行状态" })).toBeInTheDocument();
    expect(screen.getByText("已上线")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下线应用" }));

    await waitFor(() => expect(screen.getByText("已下线")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "查看下线页" })).toHaveAttribute("href", "/owner/demo");
    const offlineCall = vi.mocked(fetch).mock.calls.find(([url, options]) =>
      String(url).endsWith("/lifecycle") && options?.method === "PUT",
    );
    expect(JSON.parse(String(offlineCall?.[1]?.body))).toEqual({ status: "offline" });

    fireEvent.click(screen.getByRole("button", { name: "重新上线" }));
    await waitFor(() => expect(screen.getByText("已上线")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "基础设置" }));
    expect(screen.getByLabelText("应用描述")).toHaveValue("unsaved draft");
  });

  it("restores factory settings from application management and returns the app online", async () => {
    render(React.createElement(AppSettingsPage, { name: "demo" }));
    await screen.findByRole("heading", { name: "demo 设置" });
    fireEvent.click(screen.getByRole("tab", { name: "应用管理" }));
    fireEvent.click(screen.getByRole("button", { name: "下线应用" }));
    await waitFor(() => expect(screen.getByText("已下线")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "恢复出厂设置" }));
    await waitFor(() => expect(screen.getByText("已上线")).toBeInTheDocument());

    const resetCall = vi.mocked(fetch).mock.calls.find(([url, options]) =>
      String(url).endsWith("/data/factory-reset") && options?.method === "POST",
    );
    expect(JSON.parse(String(resetCall?.[1]?.body))).toEqual({ confirmName: "demo" });
  });

  it("separates factory reset from permanent deletion and requires the exact app name", async () => {
    render(React.createElement(AppSettingsPage, { name: "demo" }));
    await screen.findByRole("heading", { name: "demo 设置" });

    fireEvent.click(screen.getByRole("tab", { name: "数据管理" }));
    expect(screen.queryByRole("button", { name: "恢复出厂设置" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "应用管理" }));
    expect(screen.getByRole("button", { name: "恢复出厂设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "永久删除应用" })).toBeInTheDocument();

    vi.mocked(window.prompt).mockReturnValueOnce("wrong");
    fireEvent.click(screen.getByRole("button", { name: "永久删除应用" }));
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) =>
      String(url) === "/api/me/pages/demo" && options?.method === "DELETE",
    )).toBe(false);

    vi.mocked(window.prompt).mockReturnValueOnce("demo");
    fireEvent.click(screen.getByRole("button", { name: "永久删除应用" }));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/my/apps"));
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) =>
      String(url) === "/api/me/pages/demo" && options?.method === "DELETE",
    )).toBe(true);
  });
});
