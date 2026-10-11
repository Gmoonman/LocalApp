import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { Context } from "@deepseek-ai/cordis";
import Multiuser from "@localapp/dsh-multiuser";
import { AgentSettingsStore } from "@localapp/dsh-multiuser/settings";
import { registerAgentRoutes } from "@localapp/dsh-multiuser/agent-routes";
import { DeepSeekHarness } from "../deepseek-harness.mjs";
import { expect, it, vi } from "vitest";

it.each(["application", "grants"] as const)("stops persisted schedules when %s access is revoked", async reason => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/schedule-access-stop");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const values = new Map<string, string>();
  const settings = new AgentSettingsStore(root, { users: () => [...values.keys()], read: id => values.get(id), write: (id, value) => { values.set(id, value); } }, []);
  settings.write("alice", { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://model.test/v1", model: "own", apiKey: "own" }], defaultProviderId: "own", grants: { "alice/scheduled": ["schedule"] }, mcpServers: [] });
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const hasResult = request.messages.some((message: any) => message.role === "tool");
    const delta = hasResult ? { content: "Schedule saved" } : { tool_calls: [{ index: 0, id: "access-reminder", function: { name: "schedule_create", arguments: JSON.stringify({ title: "Access reminder", prompt: "Deliver access reminder marker", after_seconds: 4 }) } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: hasResult ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  let available = true;
  const context = new Context(), app = Fastify();
  try {
    await context.plugin(Multiuser);
    await registerAgentRoutes(app, {
      dataDir: root, settings, runtimes: context.localappMultiuser,
      userId: () => "alice", isAuthenticated: () => true,
      resolveApp: (_user, appId) => { if (!available) throw new Error("Application unavailable"); return { id: appId ?? "platform", capabilities: ["schedule"] }; },
      environment: async () => ({ checks: [] }) as any,
      clientAssets: async () => { throw new Error("Unused"); },
      createHarness: config => new DeepSeekHarness({ ...config, autoSessionTitles: false }),
    });
    const run = await app.inject({ method: "POST", url: "/api/agent/run", payload: { appId: "alice/scheduled", sessionId: "scheduled-session", prompt: "Create reminder", systemPrompt: "", tools: [] } });
    expect(run.statusCode).toBe(200);
    const before = requests.length;
    expect(before).toBeGreaterThanOrEqual(2);
    if (reason === "application") available = false;
    else settings.write("alice", { ...settings.read("alice"), grants: {} });
    await expect.poll(() => context.localappMultiuser.forUser("alice").length, { timeout: 3000 }).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 5000));
    expect(requests).toHaveLength(before);
    available = true;
    if (reason === "grants") settings.write("alice", { ...settings.read("alice"), grants: { "alice/scheduled": ["schedule"] } });
    const history = await app.inject("/api/agent/sessions/scheduled-session?appId=alice/scheduled");
    expect(history.statusCode).toBe(200);
    expect(history.body).toContain("Access reminder");
    await expect.poll(() => requests.some(request => JSON.stringify(request.messages).includes("Deliver access reminder marker") && request.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("Deliver access reminder marker"))), { timeout: 5000 }).toBe(true);
  } finally { await app.close(); await context.fiber.dispose(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 15000);
