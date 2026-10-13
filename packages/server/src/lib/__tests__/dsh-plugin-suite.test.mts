import { beforeEach, afterEach, expect, it } from "vitest";
import { createPluginSuite, type PluginSuiteOptions } from "../dsh-plugin-suite.mjs";
import { initMetaDb, closeMetaDb, getDb, flushMetaDb } from "../meta-sqlite.js";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
const root = path.resolve(import.meta.dirname, "../../../../../tmp/plugin-suite-tests");
beforeEach(async () => { fs.mkdirSync(root, { recursive: true }); await initMetaDb(root); });
afterEach(() => { closeMetaDb(); fs.rmSync(root, { recursive: true, force: true }); });
const options: PluginSuiteOptions = {
  multiuser: { capacity: 2 },
  platform: { owner: () => undefined, application: () => undefined, canAccess: () => false },
  development: {
    dataDir: root,
    persistence: { database: getDb, flush: flushMetaDb },
  },
};
it("stops development configuration requests when the owning plugin is unloaded", async () => {
  const context = await createPluginSuite(options);
  const app = Fastify();
  try {
    app.register(async scope => context.localappDevelopment.registerConfiguration(scope, {templateRepoUrl:"https://example.test/template"}));
    app.get("/health",async()=>({ok:true}));
    expect((await app.inject("/api/config")).json()).toEqual({templateRepoUrl:"https://example.test/template",gitDownloadUrl:null});
    await context.fiber.dispose();
    expect((await app.inject("/api/config")).statusCode).toBe(503);
    expect((await app.inject("/health")).statusCode).toBe(200);
  } finally {await app.close();await context.fiber.dispose();}
});
it.each(["multiuser", "platform", "full"] as const)("loads only the %s combination and stops it", async combination => {
  const context = await createPluginSuite({ ...options, combination });
  const multiuser = context.localappMultiuser;
  try {
    expect(context.get("localappMultiuser")).toBeDefined();
    expect(context.get("localappAgentUI")).toBeDefined();
    expect(context.get("localappDocuments")?.enabled).toBe(true);
    expect(Boolean(context.get("localappApps"))).toBe(combination !== "multiuser");
    expect(Boolean(context.get("localappDevelopment"))).toBe(combination === "full");
  } finally { await context.fiber.dispose(); }
  await expect(multiuser.acquire({ userId: "owner", applicationId: "test", role: "user", providerId: "model" }, "1", async () => ({ close: async () => {} }))).rejects.toThrow("closed");
});
it("defaults to the complete combination", async () => {
  const context = await createPluginSuite(options);
  try { expect(context.get("localappDevelopment")).toBeDefined(); }
  finally { await context.fiber.dispose(); }
});
it("reuses and disposes the Context carrying the shared HTTP listener", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { default: EmbeddedWebServer } = await import("@localapp/dsh-agent-runtime/native-server");
  const rootContext = new Context();
  await rootContext.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
  const carrier = rootContext.webServer as InstanceType<typeof EmbeddedWebServer>;
  carrier.register({ kind: "exact", path: "/shared-carrier", handler() {} });
  try {
    const suite = await createPluginSuite({ ...options, context: rootContext });
    expect(suite).toBe(rootContext);
    expect(suite.webServer).toBeInstanceOf(EmbeddedWebServer);
    expect((suite.webServer as InstanceType<typeof EmbeddedWebServer>).hasHttpRoute("/shared-carrier")).toBe(true);
    expect(suite.get("localappDevelopment")).toBeDefined();
  } finally { await rootContext.fiber.dispose(); }
  expect(() => carrier.register({ kind: "exact", path: "/after-stop", handler() {} })).toThrow("stopped");
});
it("rejects unknown combinations", async () => {
  await expect(createPluginSuite({ ...options, combination: "other" as "full" })).rejects.toThrow("Unknown LocalApp plugin combination");
});

it("loads multiuser without application or development configuration", async () => {
  const minimal = { combination: "multiuser", multiuser: { capacity: 2 }, documents: false } as const;
  const context = await createPluginSuite(minimal);
  try {
    expect(context.get("localappMultiuser")).toBeDefined();
    expect(context.get("localappApps")).toBeUndefined();
    expect(context.get("localappDevelopment")).toBeUndefined();
  } finally { await context.fiber.dispose(); }
});

it("loads application hosting without development configuration", async () => {
  const context = await createPluginSuite({ combination: "platform", multiuser: options.multiuser, platform: options.platform });
  try {
    expect(context.get("localappApps")).toBeDefined();
    expect(context.get("localappDevelopment")).toBeUndefined();
  } finally { await context.fiber.dispose(); }
});

it("rejects missing enabled-plugin configuration before altering the supplied Context", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const context = new Context();
  let disposed = false;
  context.effect(() => () => { disposed = true; });
  try {
    await expect(createPluginSuite({ context, combination: "platform", multiuser: options.multiuser })).rejects.toThrow("Application platform configuration is required");
    await expect(createPluginSuite({ context, multiuser: options.multiuser, platform: options.platform })).rejects.toThrow("Application development configuration is required");
    expect(context.get("localappMultiuser")).toBeUndefined();
    expect(context.get("localappDocuments")).toBeUndefined();
    expect(disposed).toBe(false);
  } finally { await context.fiber.dispose(); }
});

it.each(["multiuser", "platform", "full"] as const)("can omit document tools while retaining the %s combination", async combination => {
  const context = await createPluginSuite({ ...options, combination, documents: false });
  try {
    expect(context.get("localappDocuments")).toBeUndefined();
    expect(context.get("localappMultiuser")).toBeDefined();
    expect(Boolean(context.get("localappApps"))).toBe(combination !== "multiuser");
    expect(Boolean(context.get("localappDevelopment"))).toBe(combination === "full");
    const runtime = await context.localappMultiuser.acquire({ userId: "owner", applicationId: "test", role: "user", providerId: "model" }, "1", async () => ({ close: async () => {} }));
    expect(runtime).toBeDefined();
  } finally { await context.fiber.dispose(); }
});

it("loads conversation UI without application hosting or development",async()=>{
  const context=await createPluginSuite({combination:"multiuser",multiuser:{capacity:2},documents:false});
  try {
    expect(context.get("localappAgentUI")).toBeDefined();
    expect(context.get("localappApps")).toBeUndefined();
    expect(context.get("localappDevelopment")).toBeUndefined();
  } finally {await context.fiber.dispose();}
});
it.each(["platform","full"] as const)("publishes only enabled identity contributions for %s",async combination=>{
  const context=await createPluginSuite({...options,combination});const app=Fastify();
  try {
    context.localappAgentUI.registerHttp(app);
    expect((await app.inject("/api/agent/ui")).json().data.identities.map((i:{id:string})=>i.id)).toEqual(combination === "full" ? ["user","developer"] : ["user"]);
    const ui=context.localappAgentUI;
    await context.fiber.dispose();
    expect(ui.identities()).toEqual([]);
    expect((await app.inject("/api/agent/ui")).statusCode).toBe(503);
  } finally {await app.close();await context.fiber.dispose();}
});
it("keeps application services available when the conversation entry is disabled",async()=>{
  const context=await createPluginSuite({...options,agentUI:false});
  try {expect(context.get("localappAgentUI")).toBeUndefined();expect(context.get("localappApps")).toBeDefined();expect(context.get("localappDevelopment")).toBeDefined();}
  finally {await context.fiber.dispose();}
});
