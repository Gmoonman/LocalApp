import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { DeepSeekHarness } from "../../src/lib/deepseek-harness.mjs";

it("restores and delivers a persisted dsh schedule with the replacement model", async () => {
  const parent = path.resolve(__dirname, "../../../../tmp/dsh-schedule-restart");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push({ ...request, authorization: init.headers.Authorization ?? init.headers.authorization });
    const hasResult = request.messages.some((message: any) => message.role === "tool");
    const delta = hasResult ? { content: "Persisted reminder completed" } : { tool_calls: [{ index: 0, id: "restart-reminder", function: { name: "schedule_create", arguments: JSON.stringify({ title: "Restart reminder", prompt: "Deliver restart reminder marker", after_seconds: 5 }) } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: hasResult ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  let harness: DeepSeekHarness | undefined;
  try {
    harness = new DeepSeekHarness({ ownerId: "alice", root, capabilities: ["schedule"], llmModel: "before-restart", llmApiKey: "before-key", llmBaseUrl: "http://localhost:1/v1" });
    await harness.run("alice", { sessionId: "restart-reminder-session", prompt: "Create a reminder", systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
    expect(JSON.stringify(await harness.history("restart-reminder-session"))).toContain("Restart reminder");
    await harness.close();
    harness = new DeepSeekHarness({ ownerId: "alice", root, capabilities: ["schedule"], llmModel: "after-restart", llmApiKey: "after-key", llmBaseUrl: "http://localhost:1/v1" });
    await harness.initialize();
    await expect.poll(() => requests.some(request => request.model === "after-restart" && JSON.stringify(request.messages).includes("Deliver restart reminder marker")), { timeout: 12000 }).toBe(true);
    await expect.poll(async () => {
      const history = JSON.stringify(await harness!.history("restart-reminder-session"));
      return history.includes("Deliver restart reminder marker") && (history.match(/Persisted reminder completed/g) ?? []).length >= 2;
    }, { timeout: 5000 }).toBe(true);
    const request = requests.find(request => request.model === "after-restart");
    expect(JSON.stringify(request.messages)).toContain("Create a reminder");
    expect(request.authorization).toBe("Bearer after-key");
  } finally { await harness?.close(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 20000);
