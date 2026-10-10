import { Context } from "@deepseek-ai/cordis";
import { mountNativeClientModules } from "@localapp/dsh-multiuser/native-client";
import { expect, it } from "vitest";

it("registers upstream UI and trajectory artifacts with the real dsh module loader", async () => {
  const ctx = new Context();
  try {
    const modules = await mountNativeClientModules(ctx);
    const graph = modules.graph();
    const ids = new Set(graph.entries.map(entry => entry.id));
    for (const entry of graph.entries) for (const dependency of entry.inject ?? []) expect(ids.has(dependency), entry.id + " requires " + dependency).toBe(true);
    expect(ids.has("@deepseek-ai/dsh-client-modules")).toBe(true);
    for (const entry of graph.entries) {
      const response = await modules.fetchBundle(new Request("http://localapp.test/" + entry.url));
      expect(response.status, entry.id).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(100);
    }
    expect(JSON.stringify(modules.graph())).toContain("@deepseek-ai/dsh-client-ui-trajectory");
    expect(modules.clientPath("@deepseek-ai/dsh-client-ui-trajectory")).toContain("client.js");
  } finally { await ctx.fiber.dispose(); }
});
