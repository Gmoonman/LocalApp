import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
afterEach(() => vi.unstubAllGlobals());
describe("file bundle SDK", () => {
  it("uses current application API and preserves the retry key", async () => {
    vi.stubGlobal("window", { location: { pathname: "/serve/owner/app/" } });
    const fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 202,
        json: async () => ({
          success: true,
          data: { id: "task", state: "queued" },
        }),
      });
    vi.stubGlobal("fetch", fetch);
    const client = createClient();
    const files = [{ key: "a".repeat(20) + ".xlsx", path: "目录/导出.xlsx" }];
    expect(
      await client.createFileBundle(files, { idempotencyKey: "retry" }),
    ).toMatchObject({ id: "task" });
    expect(fetch).toHaveBeenCalledWith("/serve/owner/app/api/content/bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files, idempotencyKey: "retry" }),
    });
    await client.getFileBundle("task");
    expect(fetch).toHaveBeenLastCalledWith(
      "/serve/owner/app/api/content/bundles/task",
      { method: "GET" },
    );
    expect(client.fileBundleDownloadUrl("task")).toBe(
      "/serve/owner/app/api/content/bundles/task/download",
    );
  });
  it("downloads by browser link instead of fetching a ZIP into memory", () => {
    vi.stubGlobal("window", { location: { pathname: "/serve/owner/app/" } });
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    const appendChild = vi.fn();
    vi.stubGlobal("document", {
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => link),
      body: { appendChild },
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    createClient().downloadFileBundle("task");
    expect(link.href).toBe(
      "/serve/owner/app/api/content/bundles/task/download",
    );
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
