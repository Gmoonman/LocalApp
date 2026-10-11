import { expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { WsManager } from "@localapp/dsh-app-platform/ws-manager";

it("stops idle maintenance while preserving database shutdown ordering", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { default: Platform } = await import("@localapp/dsh-app-platform");
  const parent = path.resolve(process.cwd(), "../../tmp/platform-lifecycle");
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "database-"));
  const context = new Context();
  const app = Fastify();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let database: typeof context.localappApps.database | undefined;
  try {
    await context.plugin(Platform, { owner: () => undefined, application: () => undefined, canAccess: () => false });
    const platform = context.localappApps;
    database = platform.database;
    const file = path.join(directory, "app.db");
    const connection = await database.getConnection(file);
    database.execRawSql(file, "CREATE TABLE values_to_keep (value TEXT)");
    database.execRawSql(file, "INSERT INTO values_to_keep VALUES ('preserved')");
    platform.registerDatabaseMaintenance(app);
    expect(vi.getTimerCount()).toBe(1);
    await context.fiber.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(connection.exec("SELECT value FROM values_to_keep")[0].values).toEqual([["preserved"]]);
    expect(() => platform.registerDatabaseMaintenance(app)).toThrow("plugin is stopped");
    expect(() => platform.registerApplicationServing(app, undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.registerPackageManagement(app, undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.createDeviceNotificationSources(undefined as never, undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.peers(undefined as never, undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.syncJobs(undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.syncSessions(undefined as never)).toThrow("plugin is stopped");
    await app.close();
    expect(() => connection.exec("SELECT 1")).toThrow();
    const reopened = await database.getConnection(file);
    expect(reopened.exec("SELECT value FROM values_to_keep")[0].values).toEqual([["preserved"]]);
  } finally {
    await app.close(); await context.fiber.dispose(); database?.closeAllConnections();
    vi.useRealTimers(); await fs.rm(directory, { recursive: true, force: true });
  }
});

it("disposes cleanup and closes clients while rejecting further WebSocket requests", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { default: Platform } = await import("@localapp/dsh-app-platform");
  const { default: websocket } = await import("@fastify/websocket");
  const directory = path.resolve(process.cwd(), "../../tmp/platform-lifecycle");
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.mkdtemp(path.join(directory, "verification-"));
  const context = new Context();
  const app = Fastify();
  const intervals = vi.spyOn(globalThis, "setInterval");
  const clear = vi.spyOn(globalThis, "clearInterval");
  const connections = new WsManager();
  const broken = { close: vi.fn(() => { throw new Error("socket failed"); }), terminate: vi.fn() };
  const healthy = { close: vi.fn(), terminate: vi.fn() };
  const users = vi.fn(() => [{ id: "alice", name: "alice" }]);
  const dataHost = { allow: () => true, users, user: () => null, groups: () => [], group: () => null };
  let client: WebSocket | undefined;
  try {
    await context.plugin(Platform, { owner: () => undefined, application: () => undefined, canAccess: () => false });
    const platform = context.localappApps;
    platform.verification(root);
    const cleanupTimer = intervals.mock.results.at(-1)!.value;
    await app.register(websocket);
    app.register(async scope => {
      await platform.registerWebSocket(scope, {
        connections, keyOwner: () => "alice", unread: () => [], highWater: () => 0,
      });
      await platform.registerPlatformData(scope, dataHost);
    });
    await app.ready();
    expect((await app.inject({ url: "/api/platform/users" })).statusCode).toBe(200);
    expect(users).toHaveBeenCalledOnce();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    client = new WebSocket(`${address.replace("http:", "ws:")}/api/ws`, {
      headers: { authorization: "Bearer test-key" },
    });
    const ready = await new Promise<string>((resolve, reject) => {
      client!.once("message", data => resolve(data.toString()));
      client!.once("error", reject);
    });
    expect(JSON.parse(ready).type).toBe("bus:ready");
    const closed = new Promise<{ code: number; reason: string }>(resolve => {
      client!.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    connections.add("alice", broken as never);
    connections.add("bob", healthy as never);
    await context.fiber.dispose();
    expect(await closed).toEqual({ code: 1001, reason: "Platform plugin stopped" });
    expect(clear).toHaveBeenCalledWith(cleanupTimer);
    expect(broken.close).toHaveBeenCalledWith(1001, "Platform plugin stopped");
    expect(broken.terminate).toHaveBeenCalledOnce();
    expect(healthy.close).toHaveBeenCalledWith(1001, "Platform plugin stopped");
    expect(connections.totalConnections()).toBe(0);
    expect((await app.inject({ url: "/api/ws" })).statusCode).toBe(503);
    expect((await app.inject({ url: "/api/platform/users" })).statusCode).toBe(503);
    expect(users).toHaveBeenCalledOnce();
    expect(() => platform.verification(root)).toThrow("plugin is stopped");
    expect(() => platform.registerPlatformData(app, dataHost)).toThrow("plugin is stopped");
    expect(() => platform.registerApplicationDataRoutes(app, undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.registerApplicationInteractionRoutes(app, undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.registerNotificationRoutes(app, undefined as never, undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.registerDeviceRoutes(app, undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.registerSynchronizationRoutes(app, undefined as never)).toThrow("plugin is stopped");
    await expect(platform.initializeSynchronization(undefined as never)).rejects.toThrow("plugin is stopped");
    await expect(platform.initializeStorage(undefined as never)).rejects.toThrow("plugin is stopped");
    expect(() => platform.syncSource(root, undefined as never, undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.syncTarget(root, undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.resolveAgentApp("alice")).toThrow("plugin is stopped");
  } finally {
    client?.terminate();
    await app.close();
    await context.fiber.dispose();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
});
it.each(["device", "desktop"])("ends active %s action streams when the platform plugin stops", async kind => {
 const {Context}=await import("@deepseek-ai/cordis");const {default:Platform}=await import("@localapp/dsh-app-platform");
 const context=new Context();const app=Fastify();const requestId="12345678-1234-4234-8234-123456789012";
 const snapshot={id:requestId,status:"pending",updatedAt:"2026-10-10T00:00:00Z"};
 const store={cleanupDesktopActions:()=>{},getDesktopActionSnapshot:()=>snapshot};
 let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
 try{
  await context.plugin(Platform,{owner:()=>undefined,application:()=>undefined,canAccess:()=>false});
  const platform=context.localappApps;
  const host={store,config:{},protocolVersion:1,connection:{},requireUser:()=>"alice",visitor:()=>"alice",keyOwner:()=>"alice",user:()=>null,guardTimer:(_label:string,callback:()=>unknown)=>callback};
  const contribution=kind==="device"?platform.createDeviceActionRoutes(host as any):platform.createDesktopActionRoutes(host as any);
  app.register(async scope=>contribution.register(scope));
  const address=await app.listen({host:"127.0.0.1",port:0});
  const response=await fetch(`${address}/api/${kind}-actions/${requestId}/events`);
  expect(response.status).toBe(200);reader=response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("pending");
  await context.fiber.dispose();
  expect((await reader.read()).done).toBe(true);
  expect((await app.inject({url:`/api/${kind}-actions/${requestId}`})).statusCode).toBe(503);
 }finally{await reader?.cancel();await app.close();await context.fiber.dispose();}
});
it.each(["presence", "collaboration", "crdt"])("ends active %s streams when the platform plugin stops", async kind => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { default: Platform } = await import("@localapp/dsh-app-platform");
  const context = new Context();
  const app = Fastify();
  const directory = path.resolve(process.cwd(), "../../tmp/platform-lifecycle");
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.mkdtemp(path.join(directory, "collaboration-"));
  await fs.mkdir(path.join(root, "alice", "demo"), { recursive: true });
  await fs.writeFile(path.join(root, "alice", "demo", "meta.json"), JSON.stringify({
    name: "demo", versions: [], collaboration: { enabled: true, resources: { documents: { mode: "crdt", read: "authenticated" } } },
  }));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await context.plugin(Platform, { owner: () => undefined, application: () => undefined, canAccess: () => false });
    const platform = context.localappApps;
    const collaboration = platform.createCollaboration({ visitor: () => ({ id: "alice", name: "alice" }), user: () => null, verification: () => null });
    const crdt = platform.createCrdt({ visitorId: () => "alice", validateApiKey: () => null, user: () => null, verification: () => null });
    app.get("/events", (req, reply) => kind === "presence"
      ? collaboration.handlePresenceEvents(req, reply, "alice", "demo")
      : kind === "collaboration"
        ? collaboration.handleCollaborationEvents(req, reply, root, "alice", "demo")
        : crdt.handleCrdtEvents(req, reply, root, "alice", "demo"));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/events?clientId=test&resource=documents&documentId=test`);
    expect(response.status).toBe(200);
    reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await context.fiber.dispose();
    expect((await reader.read()).done).toBe(true);
    expect(() => platform.createCollaboration(undefined as never)).toThrow("plugin is stopped");
    expect(() => platform.createCrdt(undefined as never)).toThrow("plugin is stopped");
  } finally {
    await reader?.cancel();
    await app.close();
    await context.fiber.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
