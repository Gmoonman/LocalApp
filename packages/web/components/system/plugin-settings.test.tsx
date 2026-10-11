import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SystemPluginSettings } from "./plugin-settings";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("loads the running combination and locks startup-controlled selection", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: { combination: "platform", controlledByEnvironment: true } }))));
  render(<SystemPluginSettings />);
  expect(await screen.findByRole("combobox")).toBeDisabled();
  expect(screen.getByRole("combobox")).toHaveTextContent("应用平台");
  expect(screen.getByRole("button", { name: "保存并重启" })).toBeDisabled();
  expect(screen.getByRole("switch", { name: "公共文档 Skills" })).toBeEnabled();
  fireEvent.click(screen.getByRole("switch", { name: "公共文档 Skills" }));
  expect(screen.getByRole("button", { name: "保存并重启" })).toBeEnabled();
});
it("saves the selected combination and reports restart without changing it again", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method === "PUT" ? { success: true, data: { restarting: true } } : { success: true, data: { combination: "full", controlledByEnvironment: false } })));
  vi.stubGlobal("fetch", fetchMock);
  render(<SystemPluginSettings />);
  const select = await screen.findByRole("combobox");
  fireEvent.keyDown(select, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "多人 Agent" }));
  fireEvent.click(screen.getByRole("button", { name: "保存并重启" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/system/settings/plugins", expect.objectContaining({ method: "PUT", body: JSON.stringify({ combination: "multiuser", documentsEnabled: true }) })));
  expect(await screen.findByRole("status")).toHaveTextContent("正在重启");
  expect(select).toBeDisabled();
});
it("can save only the document extension selection", async () => {
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method === "PUT" ? { success: true } : { success: true, data: { combination: "full", documentsEnabled: true } })));
  vi.stubGlobal("fetch", fetchMock);
  render(<SystemPluginSettings />);
  fireEvent.click(await screen.findByRole("switch", { name: "公共文档 Skills" }));
  fireEvent.click(screen.getByRole("button", { name: "保存并重启" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/system/settings/plugins", expect.objectContaining({ body: JSON.stringify({ combination: "full", documentsEnabled: false }) })));
});
