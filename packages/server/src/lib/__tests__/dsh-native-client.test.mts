import { Context } from "@deepseek-ai/cordis";
import { mountNativeClientModules } from "@localapp/dsh-multiuser/native-client";
import { expect, it } from "vitest";

it("registers upstream UI and trajectory artifacts with the real dsh module loader", async () => {
  const ctx = new Context();
  try {
    const modules = await mountNativeClientModules(ctx);
    expect(JSON.stringify(modules.graph())).toContain("@deepseek-ai/dsh-client-ui-trajectory");
    expect(modules.clientPath("@deepseek-ai/dsh-client-ui-trajectory")).toContain("client.js");
  } finally { await ctx.fiber.dispose(); }
});
