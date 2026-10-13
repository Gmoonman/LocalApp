import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { Context } from "@deepseek-ai/cordis";
import Multiuser from "@localapp/dsh-multiuser";
import { AgentSettingsStore } from "@localapp/dsh-agent-settings/settings";
import { registerAgentRoutes } from "@localapp/dsh-agent-runtime/agent-routes";
import { expect, it, vi } from "vitest";

it.each(["native", "context", "legacy"].flatMap(endpoint => [false, true].map(failure => ({ endpoint, failure }))))("protects $endpoint admission and releases the runtime after failure=$failure", async ({ endpoint, failure }) => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/runtime-request-lease");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const values = new Map<string, string>();
  const settings = new AgentSettingsStore(root, { users: () => [...values.keys()], read: id => values.get(id), write: (id, value) => { values.set(id, value); } }, []);
  settings.write("alice", { providers: ["first", "second"].map(id => ({ id, name: id, protocol: "openai-completions", baseUrl: "http://localhost:1/v1", model: id, apiKey: id })), defaultProviderId: "first", grants: {}, mcpServers: [] });
  const context = new Context();
  const app = Fastify();
  const opened: string[] = [], closed: string[] = [];
  let available = true;
  let admitted!: () => void, dispatch!: () => void;
  const entered = new Promise<void>(resolve => { admitted = resolve; });
  const pending = new Promise<void>(resolve => { dispatch = resolve; });
  let request: Promise<{ statusCode: number }> | undefined;
  const wait = async () => { admitted(); await pending; if (failure) throw new Error("Dispatch initialization failed"); };
  try {
    await context.plugin(Multiuser);
    await registerAgentRoutes(app, {
      dataDir: root, settings, runtimes: context.localappMultiuser,
      userId: () => "alice", isAuthenticated: () => true, resolveApp: () => { if (!available) throw new Error("Application unavailable"); return { id: "platform", capabilities: [] }; },
      environment: async () => ({ checks: [] }) as any,
      clientAssets: async () => { throw new Error("Unused"); },
      createHarness: config => ({
        initialize: async () => { opened.push(config.llmModel); }, close: async () => { closed.push(config.llmModel); },
        isRunning: () => false, cancel: () => true, listSessions: async () => [],
        bindNativeApplication: wait,
        run: wait,
        nativeApi: async () => {
          await wait();
          return { transport: { http: async (_user: string, _req: unknown, reply: any) => { reply.writeHead(200); reply.end('{}'); return true; } } };
        },
      }) as any,
    });
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "first" })).toString("base64url");
    request = app.inject({
      method: "POST",
      url: endpoint === "native" ? `/api/agent/native/${scope}/api/session/create` : endpoint === "context" ? "/api/agent/native-context" : "/api/agent/run",
      payload: { sessionId: "reserved-session", providerId: "first", prompt: "Continue", systemPrompt: "", tools: [] },
    });
    await entered;
    expect((await app.inject("/api/agent/sessions?providerId=first")).statusCode).toBe(200);
    const cancelled = await app.inject({ method: "POST", url: "/api/agent/cancel", payload: { sessionId: "reserved-session", providerId: "first" } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().success).toBe(true);
    const switched = await app.inject("/api/agent/sessions?providerId=second");
    expect(switched.statusCode).toBe(400);
    expect(switched.json().error).toContain("Wait for the current Agent turn");
    expect(opened).toEqual(["first"]);
    expect(closed).toEqual([]);
    dispatch();
    expect((await request!).statusCode).toBe(failure && endpoint !== "legacy" ? 400 : 200);
    expect((await app.inject("/api/agent/sessions?providerId=second")).statusCode).toBe(200);
    expect(opened).toEqual(["first", "second"]);
    expect(closed).toEqual(["first"]);
    available = false;
    await vi.waitFor(() => expect(closed).toEqual(["first", "second"]), { timeout: 2500, interval: 25 });
    expect(context.localappMultiuser.forUser("alice")).toHaveLength(0);
    expect((await app.inject("/api/agent/sessions?providerId=second")).statusCode).toBe(400);
  } finally { dispatch(); await request; await app.close(); await context.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
