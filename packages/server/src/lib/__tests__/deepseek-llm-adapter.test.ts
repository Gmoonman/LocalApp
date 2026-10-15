import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());
it.each([
  ['{"error":{"message":"No available upstream","code":"unavailable"}}', "No available upstream"],
  ["<html>upstream unavailable</html>", "upstream unavailable"],
  ["", "LLM request failed (503)"],
])("retains provider failures in DSH error facts: %s", async (body, expected) => {
  const { LocalAppLlmAdapter } = await import("../deepseek-llm-adapter.mjs");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {status:503, headers:{"x-request-id":"req-503"}})));
  const adapter = new LocalAppLlmAdapter({llmApiKey:"secret-key", llmBaseUrl:"http://model/v1"}, () => {});
  try {
    for await (const _event of adapter.stream({provider:"localapp", model:"test", messages:[]})) {}
    expect.fail("must reject the failed HTTP response");
  } catch (error: any) {
    expect(error.message).toContain(expected);
    expect(error.message).toContain("req-503");
    expect(error.failure).toMatchObject({status:503, code:"SERVER", requestId:"req-503"});
  }
});
it("bounds and redacts error details before exposing them to users and history", async () => {
  const { LocalAppLlmAdapter } = await import("../deepseek-llm-adapter.mjs");
  const body = 'secret-key Authorization: Bearer hidden-token api_key="other-secret" ' + "x".repeat(20000);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {status:503})));
  const adapter = new LocalAppLlmAdapter({llmApiKey:"secret-key", llmBaseUrl:"http://model/v1"}, () => {});
  let failure: any;
  try { for await (const _event of adapter.stream({provider:"localapp", model:"test", messages:[]})) {} } catch (error) { failure = error; }
  expect(failure.message).not.toMatch(/secret-key|hidden-token|other-secret/);
  expect(failure.message.length).toBeLessThan(8500);
  expect(failure.message).toContain("[truncated]");
});
it("handles interleaved tool arguments, reasoning, split SSE frames and UTF-8", async () => {
  const { LocalAppLlmAdapter } = await import("../deepseek-llm-adapter.mjs");
  const chunks = [
    { choices: [{ delta: { reasoning_content: "思考", content: "你好" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "first", arguments: '{"a":' } }, { index: 1, id: "b", function: { name: "second", arguments: '{"b":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '2}' } }] }, finish_reason: "tool_calls" }] },
  ];
  const bytes = new TextEncoder().encode(chunks.map((v) => `data: ${JSON.stringify(v)}\r\n\r\n`).join("") + 'data: [DONE]');
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }))));
  const adapter = new LocalAppLlmAdapter({ llmApiKey: "test", llmBaseUrl: "http://model/v1" }, () => {});
  const events: any[] = [];
  for await (const event of adapter.stream({ provider: "localapp", model: "test", messages: [] })) events.push(event);
  const blocks = events.filter((e) => e.type === "block-end").map((e) => e.block);
  expect(blocks).toContainEqual({ type: "text", text: "你好" });
  expect(blocks).toContainEqual({ type: "reasoning", text: "思考" });
  expect(blocks).toContainEqual({ type: "tool-call", id: "a", name: "first", arguments: '{"a":1}' });
  expect(blocks).toContainEqual({ type: "tool-call", id: "b", name: "second", arguments: '{"b":2}' });
  expect(events.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" } });
});
it("rejects truncated model output", async () => {
  const { LocalAppLlmAdapter } = await import("../deepseek-llm-adapter.mjs");
  vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')));
  const adapter = new LocalAppLlmAdapter({ llmApiKey: "test", llmBaseUrl: "http://model/v1" }, () => {});
  await expect((async () => { for await (const _event of adapter.stream({ provider: "localapp", model: "test", messages: [] })) {} })()).rejects.toThrow("before completion");
});
