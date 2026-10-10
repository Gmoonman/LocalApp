import { Context } from "@deepseek-ai/cordis";
import NativeClientAssets from "@localapp/dsh-multiuser/native-client-assets";
import { expect, it } from "vitest";

it("renders upstream boot injections without sharing execution services", async () => {
  const ctx = new Context();
  ctx.provide("agents", { marker: "execution" });
  try {
    await ctx.plugin(NativeClientAssets);
    const html = await ctx.nativeClientAssets.renderIndex('<html><head></head><body><div id="root"></div></body></html>');
    expect(html).toContain("__DSH_BOOT__");
    expect(html).toContain("__ModuleLoader__");
    expect(html).toContain("@deepseek-ai/dsh-client-ui-trajectory");
    expect(html).not.toContain("execution");
  } finally { await ctx.fiber.dispose(); }
});
