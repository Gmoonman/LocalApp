import { Context } from "@deepseek-ai/cordis";
import { mountNativeClientModules } from "@localapp/dsh-multiuser/native-client";
import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { pathToFileURL } from "node:url";

it.each([
  { name: "agent-ui", contributions: ["@localapp/dsh-agent-ui"], schedule: false },
  { name: "multiuser", contributions: [], schedule: false },
  { name: "platform", contributions: ["@localapp/dsh-agent-ui", "@localapp/dsh-app-platform"], schedule: true },
  { name: "full", contributions: ["@localapp/dsh-agent-ui", "@localapp/dsh-app-platform", "@localapp/dsh-app-development"], schedule: true },
])("registers upstream UI and trajectory artifacts for $name with the real dsh module loader", async combination => {
  const ctx = new Context();
  try {
    const require = createRequire(import.meta.url);
    const contributions = combination.contributions.map(name => pathToFileURL(require.resolve(name + "/client-host")).href);
    const modules = await mountNativeClientModules(ctx, combination.schedule, { contributions });
    const graph = modules.graph();
    const ids = new Set(graph.entries.map(entry => entry.id));
    const pluginEntry = createRequire(import.meta.url).resolve("@localapp/dsh-multiuser/native-client");
    const filename = createRequire(pluginEntry).resolve("@deepseek-ai/dsh-client-web");
    const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
    const platform = new Set<string>();
    const shared = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === "PLATFORM_MODULES" && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
        for (const item of node.initializer.elements) if (ts.isStringLiteral(item)) platform.add(item.text);
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === "getStaticModules") {
        const collect = (child: ts.Node) => {
          if (ts.isPropertyAssignment(child) && ts.isStringLiteral(child.name)) shared.add(child.name.text);
          ts.forEachChild(child, collect);
        };
        ts.forEachChild(node, collect);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(platform.has("@deepseek-ai/dsh-client-ui-primitives")).toBe(true);
    expect(shared).toEqual(platform);
    for (const entry of graph.entries) for (const dependency of entry.inject ?? []) expect(ids.has(dependency) || shared.has(dependency), entry.id + " requires " + dependency).toBe(true);
    expect(ids.has("@deepseek-ai/dsh-client-modules")).toBe(true);
    for (const contribution of combination.contributions) expect(ids.has(contribution)).toBe(true);
    expect(ids.has("@deepseek-ai/dsh-client-ui-schedule")).toBe(combination.schedule);
    for (const entry of graph.entries) {
      const response = await modules.fetchBundle(new Request("http://localapp.test/" + entry.url));
      expect(response.status, entry.id).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(100);
    }
    expect(JSON.stringify(modules.graph())).toContain("@deepseek-ai/dsh-client-ui-trajectory");
    expect(modules.clientPath("@deepseek-ai/dsh-client-ui-trajectory")).toContain("client.js");
  } finally { await ctx.fiber.dispose(); }
});
