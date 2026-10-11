import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import MultiuserRuntime from "@localapp/dsh-multiuser";
import Fastify from "fastify";
const identity = { userId: "alice", applicationId: "app", role: "user" as const, providerId: "model" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function runtime() { return { close: vi.fn(async () => {}) }; }
async function mount(capacity = 100) {
  const ctx = new Context(); await ctx.plugin(MultiuserRuntime, { capacity });
  return { ctx, service: ctx.localappMultiuser };
}
describe("dsh multiuser runtime plugin", () => {
  it("stops reading browser credentials when the plugin closes", async () => {
    const { ctx, service } = await mount();
    const app = Fastify();
    const token = vi.fn(() => undefined);
    try {
      await service.registerBrowserSessions(app, {
        token, findUserById: () => null, resolveAuthSession: () => null,
        refreshAuthSession: () => null, revokeAuthSession: () => false,
      });
      app.get("/session", async request => ({ visitorId: request.visitorId }));
      expect((await app.inject("/session")).statusCode).toBe(200);
      expect(token).toHaveBeenCalledOnce();
      await ctx.fiber.dispose();
      expect((await app.inject("/session")).statusCode).toBe(503);
      expect(token).toHaveBeenCalledOnce();
      await expect(service.registerBrowserSessions(app, {} as never)).rejects.toThrow("closed");
    } finally { await app.close(); await ctx.fiber.dispose(); }
  });
  it("does not create an Agent host if the service stops before its scope starts", async () => {
    const { ctx, service } = await mount();
    const app = Fastify();
    const agent = vi.fn(async () => ({} as never));
    let registrations = 0;
    app.addHook("onRegister", () => { if (++registrations === 2) void service.close(); });
    try {
      service.registerModelRoutes(app, { authenticate: async () => {}, llm: {} as never, agent });
      await expect(app.ready()).rejects.toThrow("service closed");
      expect(registrations).toBe(2);
      expect(agent).not.toHaveBeenCalled();
    } finally { await app.close(); await ctx.fiber.dispose(); }
  });
  it("creates encrypted settings through the service and refuses creation after stopping", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const parent = path.resolve(import.meta.dirname, "../../../../../tmp/multiuser-settings-factory");
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, "settings-"));
    const { ctx, service } = await mount();
    const values = new Map<string, string>();
    const persistence = { users: () => [...values.keys()], read: (user: string) => values.get(user), write: (user: string, value: string) => { values.set(user, value); } };
    try {
      const settings = service.createSettings(root, persistence, []);
      settings.write("alice", { providers: [{ id: "model", name: "Model", protocol: "openai-completions", baseUrl: "https://example.test", model: "test", apiKey: "private-model-key" }], defaultProviderId: "model", grants: {}, mcpServers: [], applications: {} });
      expect(settings.read("alice").providers[0].apiKey).toBe("private-model-key");
      expect(values.get("alice")).not.toContain("private-model-key");
      expect(settings.read("bob").providers).toEqual([]);
      await ctx.fiber.dispose();
      const unused = path.join(root, "after-stop");
      expect(() => service.createSettings(unused, persistence, [])).toThrow("service closed");
      expect(() => service.createSecrets(path.join(unused, "master.key"))).toThrow("service closed");
      await expect(fs.access(unused)).rejects.toThrow();
    } finally { await ctx.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it("anonymous logout does not close any account runtime", async () => {
    const { ctx, service } = await mount(), app = Fastify();
    const logout = vi.fn(), findUserById = vi.fn();
    try {
      service.registerHttp(app, { authentication: { visitorId: () => null, findUserById, logout } as never, groups: {} as never });
      const first = await service.acquire(identity, "v1", async () => runtime());
      const second = await service.acquire({ ...identity, userId: "bob" }, "v1", async () => runtime());
      expect((await app.inject({ method: "POST", url: "/api/auth/logout" })).statusCode).toBe(200);
      expect(logout).toHaveBeenCalledTimes(1);
      expect(findUserById).not.toHaveBeenCalled();
      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
    } finally { await app.close(); await ctx.fiber.dispose(); }
  });
  it("logout invalidates pending creation and developer work without stopping another user", async () => {
    const { ctx, service } = await mount(), app = Fastify();
    const pending = deferred<ReturnType<typeof runtime>>();
    const logout = vi.fn();
    let opening: Promise<ReturnType<typeof runtime>> | undefined;
    try {
      service.registerHttp(app, { authentication: { visitorId: () => "alice", findUserById: (id: string) => id === "alice" ? { id } : null, logout } as never, groups: {} as never });
      await app.ready();
      opening = service.acquire(identity, "v1", () => pending.promise);
      const rejected = expect(opening).rejects.toThrow("invalidated");
      const developer = await service.acquire({ ...identity, role: "developer" }, "v1", async () => runtime());
      const other = await service.acquire({ ...identity, userId: "bob" }, "v1", async () => runtime());
      const response = app.inject({ method: "POST", url: "/api/auth/logout" });
      await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
      expect(service.forUser("alice")).toHaveLength(0);
      const late = runtime(); pending.resolve(late);
      expect((await response).statusCode).toBe(200);
      await rejected;
      expect(late.close).toHaveBeenCalledTimes(1);
      expect(developer.close).toHaveBeenCalledTimes(1);
      expect(other.close).not.toHaveBeenCalled();
      expect(service.forUser("bob")).toEqual([other]);
    } finally { pending.resolve(runtime()); await opening?.catch(() => {}); await app.close(); await ctx.fiber.dispose(); }
  });
  it("separates users, applications, roles and providers", async () => {
    const { ctx, service } = await mount();
    try {
      const first = await service.acquire(identity, "v1", async () => runtime());
      expect(await service.acquire(identity, "v1", async () => runtime())).toBe(first);
      for (const changed of [{ userId: "bob" }, { applicationId: "other" }, { role: "developer" as const }, { providerId: "other" }]) {
        expect(await service.acquire({ ...identity, ...changed }, "v1", async () => runtime())).not.toBe(first);
      }
      expect(service.forUser("bob")).toHaveLength(1);
      expect(service.forUser("unknown")).toHaveLength(0);
    } finally { await ctx.fiber.dispose(); }
  });
  it("shares initialization and reserves capacity before the factory finishes", async () => {
    const { ctx, service } = await mount(1); const pending = deferred<ReturnType<typeof runtime>>(); const factory = vi.fn(() => pending.promise);
    const first = service.acquire(identity, "v1", factory); const second = service.acquire(identity, "v1", factory);
    await expect(service.acquire({ ...identity, userId: "bob" }, "v1", async () => runtime())).rejects.toThrow("capacity");
    const value = runtime(); pending.resolve(value);
    expect(await first).toBe(value); expect(await second).toBe(value); expect(factory).toHaveBeenCalledTimes(1);
    await ctx.fiber.dispose(); expect(value.close).toHaveBeenCalledTimes(1);
  });
  it("closes old configuration before replacement and releases failed capacity", async () => {
    const { ctx, service } = await mount(1);
    try {
      const old = await service.acquire(identity, "v1", async () => runtime());
      await expect(service.acquire(identity, "v2", async () => { expect(old.close).toHaveBeenCalledTimes(1); throw new Error("failed"); })).rejects.toThrow("failed");
      await service.acquire({ ...identity, userId: "bob" }, "v1", async () => runtime());
    } finally { await ctx.fiber.dispose(); }
  });
  it("invalidates pending creation only for the selected user and application", async () => {
    const { ctx, service } = await mount(); const pending = deferred<ReturnType<typeof runtime>>();
    const opening = service.acquire(identity, "v1", () => pending.promise);
    const rejected = expect(opening).rejects.toThrow("invalidated");
    const other = await service.acquire({ ...identity, userId: "bob" }, "v1", async () => runtime());
    const closing = service.invalidate("alice", "app"); const value = runtime(); pending.resolve(value);
    await closing; await rejected; expect(value.close).toHaveBeenCalledTimes(1); expect(other.close).not.toHaveBeenCalled();
    expect(service.forUser("alice")).toHaveLength(0);
    await ctx.fiber.dispose();
  });
  it("refuses work through a fresh service view after explicit Server shutdown", async () => {
    const { ctx, service } = await mount();
    await service.close();
    await expect(ctx.localappMultiuser.acquire(identity, "v1", async () => runtime())).rejects.toThrow("closed");
    await ctx.fiber.dispose();
  });
  it("disposes late creation and refuses new work after Cordis stops", async () => {
    const { ctx, service } = await mount(); const pending = deferred<ReturnType<typeof runtime>>();
    const opening = service.acquire(identity, "v1", () => pending.promise); const rejected = expect(opening).rejects.toThrow("invalidated");
    const closing = ctx.fiber.dispose(); await Promise.resolve(); const value = runtime(); pending.resolve(value);
    await closing; await rejected; expect(value.close).toHaveBeenCalledTimes(1);
    await expect(service.acquire(identity, "v1", async () => runtime())).rejects.toThrow("closed");
  });
});

it("keeps real dsh sessions and model requests separate for two users", async () => {
  const { default: fs } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const temporary = path.resolve(import.meta.dirname, "../../../../../tmp/dsh-plugin-tests");
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, "users-"));
  const { ctx, service } = await mount();
  const requests: Array<{ model: string; messages: unknown[] }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: `${body.model} finished` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  try {
    for (const userId of ["alice", "bob"]) {
      const harness = await service.acquire({ ...identity, userId }, userId, async () => {
        const value = new DeepSeekHarness({ ownerId: userId, root: path.join(root, userId), llmApiKey: "test-key", llmBaseUrl: "http://model.test/v1", llmModel: `${userId}-model`, capabilities: [] });
        await value.initialize(); return value;
      });
      await harness.run(userId, { sessionId: "same-session", prompt: `${userId} private request`, systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
    }
    const alice = service.forUser<InstanceType<typeof DeepSeekHarness>>("alice")[0];
    const bob = service.forUser<InstanceType<typeof DeepSeekHarness>>("bob")[0];
    expect(JSON.stringify(await alice.history("same-session"))).toContain("alice private request");
    expect(JSON.stringify(await alice.history("same-session"))).not.toContain("bob private request");
    expect(JSON.stringify(await bob.history("same-session"))).toContain("bob private request");
    expect(JSON.stringify(await bob.history("same-session"))).not.toContain("alice private request");
    expect(requests.map(request => request.model)).toEqual(["alice-model", "bob-model"]);
    await service.invalidate("alice"); expect(service.forUser("alice")).toHaveLength(0);
    expect(await bob.history("same-session")).not.toHaveLength(0);
  } finally { await ctx.fiber.dispose(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
});
it("closes previously registered personal API routes when the multiuser plugin stops", async () => {
  const { default: Fastify } = await import("fastify");
  const { ctx, service } = await mount();
  const app = Fastify();
  const list = vi.fn(() => [{ key: "private-key", createdAt: "now" }]);
  const host = { createApiKey: () => ({ key: "private-key", userId: "alice", createdAt: "now" }), getUserRole: () => "user", listApiKeysByUser: list, userId: () => "alice" };
  try {
    const authenticate = vi.fn(async (scope: import("fastify").FastifyInstance) => {
      scope.addHook("onRequest", async (request, reply) => {
        if (request.headers.authorization !== "Bearer alice") return reply.status(401).send({ error: "Unauthorized" });
      });
    });
    service.registerKeyRoutes(app, { authenticate, keys: host });
    app.get("/unrelated", async () => ({ success: true }));
    expect((await app.inject({ url: "/api/keys" })).statusCode).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect((await app.inject({ url: "/api/keys", headers: { authorization: "Bearer alice" } })).statusCode).toBe(200);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
    await ctx.fiber.dispose();
    const stopped = await app.inject({ url: "/api/keys", headers: { authorization: "Bearer alice" } });
    expect(stopped.statusCode).toBe(503);
    expect(stopped.body).not.toContain("private-key");
    expect(list).toHaveBeenCalledOnce();
    expect((await app.inject({ url: "/unrelated" })).statusCode).toBe(200);
    await expect(service.registerKeys(app, host)).rejects.toThrow("closed");
    expect(() => service.registerModelRoutes(app, undefined as never)).toThrow("closed");
    expect(() => service.registerAdministrationRoutes(app, undefined as never)).toThrow("closed");
    expect(() => service.registerPersonalResources(app, undefined as never)).toThrow("closed");
    expect(() => service.registerKeyRoutes(app, undefined as never)).toThrow("closed");
    await expect(service.registerWebAssets(app, "unused")).rejects.toThrow("closed");
  } finally { await app.close(); await ctx.fiber.dispose(); }
});
