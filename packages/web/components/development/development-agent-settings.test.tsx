import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DevelopmentAgentSettings } from "./development-agent-settings";
afterEach(() => vi.unstubAllGlobals());
it("loads project preferences and saves capability and tool changes", async () => {
  const request = vi.fn(async (_url, options) => new Response(JSON.stringify({ success: true, data: { availableCapabilities: ["files", "terminal", "web", "schedule"], enabledCapabilities: ["files", "terminal", "web", "schedule"], disabledTools: [], enabledSkills: [], skills: [{ id: "pdf", name: "PDF", description: "读取 PDF", available: true }, { id: "xlsx", name: "Excel", description: "读取 Excel", available: false, unavailableReason: "依赖未就绪" }] } })));
  vi.stubGlobal("fetch", request);
  render(<DevelopmentAgentSettings projectId="own-project" />);
  fireEvent.click(screen.getByRole("button", { name: "开发 Agent 设置" }));
  fireEvent.click(await screen.findByRole("switch", { name: "终端命令" }));
  expect(screen.getByRole("switch", { name: "网页访问" })).toBeChecked();
  expect(screen.getByRole("switch", { name: "定时任务" })).toBeChecked();
  fireEvent.click(screen.getByRole("switch", { name: "PDF" }));
  expect(screen.getByRole("switch", { name: "Excel" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("禁用工具"), { target: { value: "write\nwrite\nbash" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("/api/development/projects/own-project/agent/settings", expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabledCapabilities: ["files", "web", "schedule"], enabledSkills: ["pdf"], disabledTools: ["write", "bash"] }) })));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
it("keeps saving unavailable when project settings cannot be read", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false, error: "项目不可访问" }), { status: 404 })));
  render(<DevelopmentAgentSettings projectId="foreign" />);
  fireEvent.click(screen.getByRole("button", { name: "开发 Agent 设置" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("项目不可访问");
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
});
