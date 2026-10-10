import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
it("stores encrypted per-user models without a Server database", async () => {
  const { AgentSettingsStore } = await import("@localapp/dsh-multiuser/settings");
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/dsh-plugin-settings");
  await fs.mkdir(parent, { recursive: true }); const root = await fs.mkdtemp(path.join(parent, "storage-"));
  const records = new Map<string, string>();
  const persistence = { users: () => [...records.keys()], read: (userId: string) => records.get(userId), write: (userId: string, value: string) => { records.set(userId, value); } };
  try {
    const store = new AgentSettingsStore(root, persistence, ["pdf"]);
    store.write("alice", { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "https://model.test/v1", model: "own-model", apiKey: "test-secret-marker" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    expect(JSON.stringify([...records.values()])).not.toContain("test-secret-marker");
    expect(JSON.stringify(store.publicSettings("alice"))).not.toContain("test-secret-marker");
    expect(store.read("bob").providers).toHaveLength(0);
    expect(new AgentSettingsStore(root, persistence, ["pdf"]).read("alice").providers[0].apiKey).toBe("test-secret-marker");
    records.set("bob", records.get("alice")!);
    expect(() => store.read("bob")).toThrow();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
