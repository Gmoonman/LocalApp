import Fastify from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import EmbeddedWebServer from "@localapp/dsh-agent-runtime/native-server";
import { mountNativeConnection } from "@localapp/dsh-agent-runtime/native-connection";
import { requireRequestUser } from "../../src/plugins/auth.js";
import { initMetaDb, closeMetaDb, createUser, createApiKey } from "../../src/lib/meta-sqlite.js";
import { expect, it } from "vitest";

it("dispatches real dsh RPC through one Server using authenticated user contexts", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../tmp/dsh-native-connection");
  await fs.mkdir(parent, { recursive: true }); const root = await fs.mkdtemp(path.join(parent, "http-"));
  await initMetaDb(root);
  const app = Fastify(); const contexts: Context[] = [];
  const connections = new Map<string, Awaited<ReturnType<typeof mountNativeConnection>>>();
  const keys = new Map<string, string>();
  let lastRequest: IncomingMessage | undefined;
  let lastResponse: ServerResponse | undefined;
  try {
    for (const userId of ["alice", "bob"]) {
      createUser(userId, userId, "unused-test-password-hash"); keys.set(userId, createApiKey(userId).key);
      const ctx = new Context(); contexts.push(ctx);
      await ctx.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
      const modelCredentials = { marker: userId };
      ctx.provide("credentials", modelCredentials);
      const connection = await mountNativeConnection(ctx, { userId, root: path.join(root, userId) });
      expect(ctx.get("credentials")).toEqual(modelCredentials);
      connections.set(userId, connection);
      ctx.connection.rpc.handle("/rpc", async (_endpoint, payload) => ({ ok: true, value: { owner: userId, payload } }));
    }
    app.addHook("onRequest", async (req, reply) => {
      const userId = requireRequestUser(req, reply); if (!userId) return;
      const native = connections.get(userId); if (!native) return reply.status(403).send();
      lastRequest = req.raw; lastResponse = reply.raw;
      reply.hijack(); if (!await native.http(userId, req.raw, reply.raw)) { reply.raw.writeHead(404); reply.raw.end(); }
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${app.addresses()[0].port}`;
    const send = (key?: string, origin?: string) => fetch(`${base}/rpc/owner`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "X-API-Key": key } : {}), ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ type: "client-request", rpcId: "one", method: "owner", payload: { userId: "alice" } }),
    });
    expect((await send()).status).toBe(401);
    expect((await send("test-invalid-api-key")).status).toBe(401);
    for (const userId of ["alice", "bob"]) {
      const response = await send(keys.get(userId)); expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect((await response.json()).result.value.owner).toBe(userId);
    }
    expect((await send(keys.get("alice"), "https://untrusted.test")).status).toBe(403);
    await expect(connections.get("alice")!.http("bob", lastRequest!, lastResponse!)).rejects.toThrow("another user");
    await contexts[0].fiber.dispose();
    await expect(connections.get("alice")!.http("alice", lastRequest!, lastResponse!)).rejects.toThrow("closed");
  } finally { await app.close(); await Promise.all(contexts.map(ctx => ctx.fiber.dispose())); closeMetaDb(); await fs.rm(root, { recursive: true, force: true }); }
});
