import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { Context } from "@deepseek-ai/cordis";
import Multiuser from "@localapp/dsh-multiuser";
import { AgentSettingsStore } from "@localapp/dsh-multiuser/settings";
import { registerAgentRoutes } from "@localapp/dsh-multiuser/agent-routes";
import { expect, it } from "vitest";
it("restores one scheduled workspace using the default provider after removal of its original provider", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/schedule-restoration");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const hash = (values: string[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
  const oldDirectory = hash(["alice", "platform", "deleted"]);
  const associations = path.join(root, "agent", "associations");
  await fs.mkdir(associations, { recursive: true });
  await fs.writeFile(path.join(associations, hash(["alice", "platform"]) + ".json"), JSON.stringify({ version: 1, directory: oldDirectory }));
  const values = new Map<string, string>();
  const settings = new AgentSettingsStore(root, { users: () => [...values.keys()], read: id => values.get(id), write: (id, value) => { values.set(id, value); } }, []);
  settings.write("alice", { providers: ["first", "default", "third"].map(id => ({ id, name: id, protocol: "openai-completions", baseUrl: "http://localhost:1/v1", model: id, apiKey: id })), defaultProviderId: "default", grants: { platform: ["schedule"] }, mcpServers: [] });
  const initialized: any[] = [];
  const context = new Context();
  const app = Fastify();
  try {
    await context.plugin(Multiuser);
    await registerAgentRoutes(app, {
      dataDir: root, settings, runtimes: context.localappMultiuser,
      userId: () => "alice", isAuthenticated: () => true, resolveApp: () => ({ id: "platform", capabilities: ["schedule"] }),
      environment: async () => ({ checks: [] }) as any,
      clientAssets: async () => { throw new Error("Not used during restoration"); },
      createHarness: config => ({ initialize: async () => { initialized.push(config); }, close: async () => {}, isRunning: () => false }) as any,
    });
    expect(initialized).toHaveLength(1);
    expect(initialized[0].llmModel).toBe("default");
    expect(initialized[0].llmApiKey).toBe("default");
    expect(initialized[0].root).toBe(path.join(root, "agent", oldDirectory));
    expect(initialized[0].capabilities).toEqual(["schedule"]);
    expect(context.localappMultiuser.forUser("alice")).toHaveLength(1);
  } finally { await app.close(); await context.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
