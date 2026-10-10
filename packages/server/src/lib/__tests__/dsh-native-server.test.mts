import { Context } from "@deepseek-ai/cordis";
import Fastify from "fastify";
import { expect, it } from "vitest";
it("runs dsh registered routes through the existing Server without opening another listener", async () => {
  const { default: EmbeddedWebServer } = await import("@localapp/dsh-multiuser/native-server");
  const ctx = new Context(); const app = Fastify();
  await ctx.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
  const native = ctx.webServer as InstanceType<typeof EmbeddedWebServer>;
  const removePrefix = native.register({ kind: "prefix", path: "/api", handler(req, res) { res.end(`native ${req.url}`); } });
  const removeExact = native.register({ kind: "exact", path: "/api/exact", handler(_req, res) { res.end("exact"); } });
  app.addHook("onRequest", async (req, reply) => {
    if (!native.hasHttpRoute(req.raw.url!)) return;
    reply.hijack(); await native.dispatchHttp(req.raw, reply.raw);
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${app.addresses()[0].port}`;
    expect(await (await fetch(`${base}/api/exact`)).text()).toBe("exact");
    expect(await (await fetch(`${base}/api/nested`)).text()).toBe("native /api/nested");
    expect((await fetch(`${base}/api-other`)).status).toBe(404);
    removeExact(); expect(await (await fetch(`${base}/api/exact`)).text()).toBe("native /api/exact");
    removePrefix(); expect((await fetch(`${base}/api/nested`)).status).toBe(404);
    expect(ctx.webServer).toBeInstanceOf(EmbeddedWebServer);
  } finally { await app.close(); await ctx.fiber.dispose(); }
});
