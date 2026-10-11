import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AppAgentSettings } from "./agent-settings";
it("saves skill, capability and individual tool choices for this application", async () => {
  const value = { appId: "owner/demo", capabilities: ["skills", "files", "terminal"], enabledCapabilities: [], enabledSkills: [], disabledTools: [], skills: [{ id: "pdf", name: "PDF", description: "Read PDFs", dependencies: "Python" }], tools: [{ name: "deleteRecord", description: "Delete a record", source: "app" }] };
  const fetchMock = vi.fn(async (_url: unknown, options?: RequestInit) => new Response(JSON.stringify({ success: true, data: options?.method === "PUT" ? { ...value, ...JSON.parse(String(options.body)) } : value })));
  vi.stubGlobal("fetch", fetchMock);
  render(<AppAgentSettings appId="owner/demo" />);
  fireEvent.click(await screen.findByLabelText("Skills"));
  fireEvent.click(screen.getByLabelText("PDF"));
  fireEvent.click(screen.getByRole("switch", { name: "deleteRecord" }));
  fireEvent.click(screen.getByRole("button", { name: "DSH" }));
  expect(screen.queryByRole("switch", { name: "deleteRecord" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "保存 Agent 设置" }));
  await screen.findByText("Agent 设置已保存");
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === "PUT")?.[1]?.body));
  expect(body).toEqual({ appId: "owner/demo", enabledCapabilities: ["skills"], enabledSkills: ["pdf"], disabledTools: ["deleteRecord"] });
});
it("keeps public skills unavailable when the application does not declare skills", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: { appId: "owner/demo", capabilities: [], enabledCapabilities: [], enabledSkills: [], disabledTools: [], skills: [{ id: "pdf", name: "PDF", description: "Read", dependencies: "Python" }], tools: [] } }))));
  render(<AppAgentSettings appId="owner/demo" />);
  await waitFor(() => expect(screen.getByLabelText("PDF")).toBeDisabled());
});
it("prevents enabling a skill when LocalApp system dependencies are missing", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: { appId: "owner/demo", capabilities: ["skills", "files", "terminal"], enabledCapabilities: ["skills", "files", "terminal"], enabledSkills: [], disabledTools: [], skills: [{ id: "pdf", name: "PDF", description: "Read", dependencies: "Python", available: false, unavailableReason: "系统文档处理环境尚未就绪，请联系管理员检查依赖。" }], tools: [] } }))));
  render(<AppAgentSettings appId="owner/demo" />);
  await waitFor(() => expect(screen.getByLabelText("PDF")).toBeDisabled());
  expect(screen.getByText("系统文档处理环境尚未就绪，请联系管理员检查依赖。")).toBeInTheDocument();
});
