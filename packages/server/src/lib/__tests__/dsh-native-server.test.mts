import { Context } from "@deepseek-ai/cordis";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { connect } from "node:net";
import { once } from "node:events";

it("dispatches native upgrades exclusively and preserves compatibility upgrades", async () => {
  const { default: EmbeddedWebServer } = await import("@localapp/dsh-multiuser/native-server");
  const ctx = new Context();
  await ctx.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
  const carrier = ctx.webServer as InstanceType<typeof EmbeddedWebServer>;
  const listener = carrier.createListener((_request, response) => response.end("http"));
  let compatibilityCalls = 0;
  listener.on("upgrade", (_request, socket) => {
    compatibilityCalls++;
    socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\ncompatibility");
  });
  const remove = carrier.registerUpgrade({ path: "/events", handler(_request, socket) {
    socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nnative");
  } });
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const request = async (url: string) => {
    const socket = connect(carrier.port, "127.0.0.1");
    socket.setEncoding("utf8"); let result = "";
    socket.on("data", value => { result += value; });
    socket.write(`GET ${url} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    await once(socket, "close"); return result;
  };
  try {
    expect(await request("/events?cursor=1")).toContain("\r\n\r\nnative");
    expect(compatibilityCalls).toBe(0);
    expect(await request("/other")).toContain("compatibility");
    remove(); expect(await request("/events")).toContain("compatibility");
    expect(compatibilityCalls).toBe(2);
    carrier.registerUpgrade({ path: "/broken", handler() { throw new Error("upgrade failed"); } });
    expect(await request("/broken")).toBe("");
    expect(compatibilityCalls).toBe(2);
    await ctx.fiber.dispose();
    expect(await request("/other")).toBe("");
    expect(compatibilityCalls).toBe(2);
  } finally { await ctx.fiber.dispose(); await new Promise<void>(resolve => listener.close(() => resolve())); }
});
it("carries native routes and the compatibility handler on one listening server", async () => {
  const { default: EmbeddedWebServer } = await import("@localapp/dsh-multiuser/native-server");
  const ctx = new Context();
  let app: ReturnType<typeof Fastify> | undefined;
  try {
    await ctx.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
    const native = ctx.webServer as InstanceType<typeof EmbeddedWebServer>;
    app = Fastify({ serverFactory: handler => native.createListener(handler) });
    app.get("/compatibility", async () => ({ compatibility: true }));
    const remove = native.register({ kind: "exact", path: "/native", handler(_request, response) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ native: true }));
    } });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    expect(native.port).toBe(app.addresses()[0].port);
    expect(await (await fetch(base + "/native")).json()).toEqual({ native: true });
    expect(await (await fetch(base + "/compatibility")).json()).toEqual({ compatibility: true });
    remove();
    expect((await fetch(base + "/native")).status).toBe(404);
    expect(() => native.createListener(() => {})).toThrow("already");
    await ctx.fiber.dispose();
    expect((await fetch(base + "/compatibility")).status).toBe(503);
  } finally { await app?.close(); await ctx.fiber.dispose(); }
});
it("rejects new HTTP, upgrade and fallback contributions after the carrier stops", async () => {
  const { default: EmbeddedWebServer } = await import("@localapp/dsh-multiuser/native-server");
  const ctx = new Context();
  try {
    await ctx.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
    const native = ctx.webServer as InstanceType<typeof EmbeddedWebServer>;
    native.register({ kind: "exact", path: "/existing", handler() {} });
    native.registerUpgrade({ path: "/events", handler() {} });
    await ctx.fiber.dispose();
    expect(native.hasHttpRoute("/existing")).toBe(false);
    expect(native.hasUpgradeRoute("/events")).toBe(false);
    expect(() => native.register({ kind: "exact", path: "/new", handler() {} })).toThrow("stopped");
    expect(() => native.registerUpgrade({ path: "/new", handler() {} })).toThrow("stopped");
    expect(() => native.registerFallback(() => {})).toThrow("stopped");
  } finally { await ctx.fiber.dispose(); }
});
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
    const removeFallback = native.registerFallback((_req, res) => { res.end("fallback"); });
    expect(await (await fetch(`${base}/page`)).text()).toBe("fallback");
    expect(() => native.registerFallback(() => {})).toThrow("already registered");
    removeFallback(); expect((await fetch(`${base}/page`)).status).toBe(404);
    expect(native.port).toBe(0);
    expect(ctx.webServer).toBeInstanceOf(EmbeddedWebServer);
  } finally { await app.close(); await ctx.fiber.dispose(); }
});
