import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { DeepSeekHarness } from "../deepseek-harness.mjs";

it.each([true, false])("only tolerates an already closed persistence handle during shutdown: %s", async alreadyClosed => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/close-projection");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const harness = new DeepSeekHarness({ ownerId: "test-owner", root, llmBaseUrl: "http://model.test/v1", llmApiKey: "test", llmModel: "test", capabilities: [] });
  try {
    await harness.nativeApi();
    const ctx = (harness as any).ctx;
    const session = { id: "completed-child" };
    const list = vi.spyOn(ctx.sessions, "list").mockReturnValue([session]);
    const error = Object.assign(new Error("flush failed"), { name: alreadyClosed ? "SessionHandleClosedError" : "Error" });
    const write = vi.spyOn(ctx.get("sessionProjectionCache"), "write").mockRejectedValue(error);
    if (alreadyClosed) await expect(harness.close()).resolves.toBeUndefined();
    else await expect(harness.close()).rejects.toBe(error);
    expect(write).toHaveBeenCalledWith(session);
    list.mockRestore(); write.mockRestore();
  } finally { vi.restoreAllMocks(); await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
});
