import { Context } from "@deepseek-ai/cordis";
import NativeClientAssets from "@localapp/dsh-agent-runtime/native-client-assets";
import { expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

it("renders upstream boot injections without sharing execution services", async () => {
  const ctx = new Context();
  ctx.provide("agents", { marker: "private-agent-execution-marker" });
  try {
    await ctx.plugin(NativeClientAssets);
    const html = await ctx.nativeClientAssets.renderIndex('<html><head></head><body><div id="root"></div></body></html>');
    expect(html).toContain("__DSH_BOOT__");
    expect(html).toContain("__ModuleLoader__");
    expect(html).toContain("@deepseek-ai/dsh-client-ui-trajectory");
    expect(html).not.toContain("private-agent-execution-marker");
    expect(html).not.toContain("@localapp/dsh-app-platform");
    expect(html).not.toContain("@localapp/dsh-app-development");
  } finally { await ctx.fiber.dispose(); }
});

it.each([false, true])("loads application client contributions with development %s without starting application services", async development => {
  const ctx = new Context();
  try {
    await ctx.plugin(NativeClientAssets, {
      contributions: ["@localapp/dsh-agent-ui/client-host", "@localapp/dsh-app-platform/client-host", ...(development ? ["@localapp/dsh-app-development/client-host"] : [])].map(name => pathToFileURL(createRequire(import.meta.url).resolve(name)).href),
    });
    const html = await ctx.nativeClientAssets.renderIndex('<html><head></head><body><div id="root"></div></body></html>');
    expect(html).toContain("@localapp/dsh-app-platform");
    expect(html).toContain("@deepseek-ai/dsh-client-ui-trajectory");
    expect(ctx.get("localappApps")).toBeUndefined();
    expect(ctx.get("localappDevelopment")).toBeUndefined();
    if (development) expect(html).toContain("@localapp/dsh-app-development");
    else expect(html).not.toContain("@localapp/dsh-app-development");
  } finally { await ctx.fiber.dispose(); }
});
