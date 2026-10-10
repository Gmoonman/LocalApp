import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { DeepSeekHarness } from "../deepseek-harness.mjs";

it("exposes real Harness sessions and native trajectory records through the dsh Gateway", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/dsh-native-session");
  await fs.mkdir(parent, { recursive: true }); const root = await fs.mkdtemp(path.join(parent, "gateway-"));
  const harnesses: DeepSeekHarness[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "finished" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })));
  try {
    for (const userId of ["alice", "bob"]) {
      const harness = new DeepSeekHarness({ ownerId: userId, root: path.join(root, userId), llmApiKey: "test-key", llmBaseUrl: "http://model.test/v1", llmModel: "test-model", capabilities: [] });
      harnesses.push(harness);
      await harness.run(userId, { sessionId: `${userId}-session`, prompt: `${userId} private message`, systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
      const native = await harness.nativeApi();
      const workspace = await native.gateway.invoke({ namespace: "workspace", method: "initializeDefault", args: {} });
      expect(JSON.stringify(workspace)).toContain(path.join(root, userId, "workspace"));
      await expect(native.gateway.invoke({ namespace: "workspace", method: "create", args: { request: { path: root } } })).rejects.toThrow("workspace");
      const sessions = await native.gateway.invoke({ namespace: "session", method: "list", args: { _request: {} } }) as { items: Array<{ id: string }> };
      expect(JSON.stringify(sessions)).toContain(`${userId}-session`);
      expect(JSON.stringify(sessions)).not.toContain(`${userId === "alice" ? "bob" : "alice"}-session`);
      const controller = new AbortController();
      const stream = await native.gateway.stream({ namespace: "session", method: "follow", args: { request: { address: { kind: "session", sessionId: `${userId}-session` } } }, signal: controller.signal });
      const iterator = stream[Symbol.asyncIterator](); const opening = await iterator.next();
      controller.abort(); await iterator.return?.();
      const snapshot = opening.value as { cursor: number };
      const page = await native.gateway.invoke({ namespace: "session", method: "page", args: { request: { address: { kind: "session", sessionId: userId + "-session" }, throughSeq: snapshot.cursor } } });
      expect(JSON.stringify(page)).toContain(userId + " private message");
      await expect(native.gateway.invoke({ namespace: "session", method: "page", args: { request: { address: { kind: "session", sessionId: (userId === "alice" ? "bob" : "alice") + "-session" }, throughSeq: -1 } } })).rejects.toThrow();
      expect(JSON.stringify(opening.value)).toContain("request/header");
      expect(JSON.stringify(opening.value)).toContain(`${userId} private message`);
      await harness.close();
      const restored = new DeepSeekHarness({ ownerId: userId, root: path.join(root, userId), llmApiKey: "test-key", llmBaseUrl: "http://model.test/v1", llmModel: "test-model", capabilities: [] });
      harnesses[harnesses.length - 1] = restored;
      const restoredNative = await restored.nativeApi();
      const restoredPage = await restoredNative.gateway.invoke({ namespace: "session", method: "page", args: { request: { address: { kind: "session", sessionId: userId + "-session" }, throughSeq: snapshot.cursor } } });
      expect(restoredPage).toEqual(page);
      await expect(restoredNative.gateway.invoke({ namespace: "session", method: "create", args: { request: { cwd: path.dirname(root) } } })).rejects.toThrow("workspace");
    }
  } finally { await Promise.all(harnesses.map(harness => harness.close())); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
});
