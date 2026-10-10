import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { DeepSeekHarness } from "../deepseek-harness.mjs";

it("creates native sessions only in the application workspace", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/dsh-native-create");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "session-"));
  const harness = new DeepSeekHarness({ ownerId: "owner", root, llmApiKey: "test-key", llmBaseUrl: "http://model.test/v1", llmModel: "test-model", capabilities: [] });
  try {
    const native = await harness.nativeApi();
    const settings = await native.gateway.invoke({ namespace: "settings", method: "describe", args: {} });
    expect(settings).toMatchObject({ writable: false, hasDocument: false, namespaces: [{ ns: "localapp-model", value: { provider: "localapp", model: "test-model" } }] });
    expect(JSON.stringify(settings)).not.toContain("test-key");
    const created = await native.gateway.invoke({ namespace: "session", method: "create", args: { request: {} } }) as { sessionId: string };
    expect(created.sessionId).toMatch(/^session-/);
    expect(JSON.stringify(await native.gateway.invoke({ namespace: "session", method: "list", args: { _request: {} } }))).toContain(created.sessionId);
    for (const sessionId of ["../escape", "/absolute", "nested/session", "", "a".repeat(129)]) {
      await expect(native.gateway.invoke({ namespace: "session", method: "create", args: { request: { sessionId } } })).rejects.toThrow("Invalid session ID");
    }
    const named = await native.gateway.invoke({ namespace: "session", method: "create", args: { request: { sessionId: "existing-session_1" } } });
    expect(named).toEqual({ sessionId: "existing-session_1" });
    const catalog = await native.gateway.invoke({ namespace: "session", method: "modelCatalog", args: {} });
    expect(JSON.stringify(catalog)).toContain("test-model");
    const selected = await native.gateway.invoke({ namespace: "session", method: "selectModel", args: { request: { sessionId: created.sessionId, provider: "localapp", model: "test-model" } } });
    expect(selected).toMatchObject({ selected: { provider: "localapp", model: "test-model" } });
    await expect(native.gateway.invoke({ namespace: "session", method: "selectModel", args: { request: { sessionId: created.sessionId, provider: "other", model: "test-model" } } })).rejects.toThrow();
    for (let index = 0; index < 8; index++) {
      await native.gateway.invoke({ namespace: "session", method: "create", args: { request: { sessionId: `capacity-${index}` } } });
    }
    await expect(native.gateway.invoke({ namespace: "session", method: "create", args: { request: {} } })).rejects.toThrow("Too many agent sessions");
    expect(await native.gateway.invoke({ namespace: "session", method: "create", args: { request: { sessionId: "existing-session_1" } } })).toEqual({ sessionId: "existing-session_1" });
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it("counts concurrent native creation before agents become available", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/dsh-native-create");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "concurrent-"));
  const harness = new DeepSeekHarness({ ownerId: "owner", root, llmApiKey: "test-key", llmBaseUrl: "http://model.test/v1", llmModel: "test-model", capabilities: [] });
  try {
    const native = await harness.nativeApi();
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => native.gateway.invoke({ namespace: "session", method: "create", args: { request: {} } })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(10);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(5);
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
});
