import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { DeepSeekHarness } from "../deepseek-harness.mjs";

it("runs a native prompt and restores its original trajectory", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/dsh-native-prompt");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "session-"));
  await fs.writeFile(path.join(root, "application-prompt.json"), JSON.stringify({ systemPrompt: "Use the current application context" }));
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    requests.push({ ...JSON.parse(options.body), authorization: options.headers.Authorization });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "native finished" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  const config = { ownerId: "owner", root, llmApiKey: "test-key", llmBaseUrl: "http://model.test/v1", llmModel: "test-model", capabilities: [] };
  let harness = new DeepSeekHarness(config);
  try {
    const native = await harness.nativeApi();
    const { sessionId } = await native.gateway.invoke({ namespace: "session", method: "create", args: { request: {} } }) as { sessionId: string };
    const request = { sessionId, requestId: "native-request-1", mode: "queue", content: [{ type: "text", text: "native hello" }] };
    expect(await native.gateway.invoke({ namespace: "session", method: "prompt", args: { request } })).toEqual({ accepted: true });
    const read = async (gateway: typeof native.gateway) => {
      const controller = new AbortController();
      const stream = await gateway.stream({ namespace: "session", method: "follow", args: { request: { address: { kind: "session", sessionId } } }, signal: controller.signal });
      const iterator = stream[Symbol.asyncIterator]();
      try { return (await iterator.next()).value; }
      finally { controller.abort(); await iterator.return?.(); }
    };
    await vi.waitFor(async () => expect(JSON.stringify(await read(native.gateway))).toContain("native finished"));
    const snapshot = await read(native.gateway);
    expect(JSON.stringify(snapshot)).toContain("request/header");
    expect(JSON.stringify(snapshot)).toContain("native hello");
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("test-model");
    expect(requests[0].authorization).toBe("Bearer test-key");
    expect(requests[0].messages.some((message: any) => message.role === "system" && message.content.includes("Use the current application context"))).toBe(true);
    await native.gateway.invoke({ namespace: "session", method: "prompt", args: { request } });
    expect(requests).toHaveLength(1);
    await harness.close();
    harness = new DeepSeekHarness(config);
    expect(JSON.stringify(await read((await harness.nativeApi()).gateway))).toContain("native finished");
  } finally { await harness.close(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
});
