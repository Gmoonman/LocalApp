import fs from "node:fs";
import path from "node:path";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {initMetaDb,closeMetaDb,getDb,flushMetaDb} from "../../meta-sqlite.js";
import {ProjectStore} from "../../development/projects.js";
import {DevelopmentBuilds,createBuildOperations} from "../../development/builds.js";
const dir=path.resolve(__dirname,"../../../../../../tmp/platform-development/build-tests");let projects:ProjectStore;
beforeEach(async()=>{closeMetaDb();fs.rmSync(dir,{recursive:true,force:true});await initMetaDb(dir);projects=new ProjectStore(dir);});
afterEach(()=>{closeMetaDb();fs.rmSync(dir,{recursive:true,force:true});});
it.each(["active", "initializing"])("selects developer Skills and stops when the document extension is removed: %s", async mode => {
 const { Context } = await import("@deepseek-ai/cordis");
 const { default: Development } = await import("@localapp/dsh-app-development");
 const { default: Multiuser } = await import("@localapp/dsh-multiuser");
 const { default: Documents } = await import("@localapp/dsh-document-tools");
 const { default: Fastify } = await import("fastify");
 const { AgentSettingsStore } = await import("../../agent-settings.js");
 const context = new Context(), app = Fastify();
 let ready = false, config: any, closed = 0;
 let release!: () => void, entered!: () => void;
 const pending = new Promise<void>(resolve => { release = resolve; });
 const initializing = new Promise<void>(resolve => { entered = resolve; });
 try {
  await context.plugin(Multiuser); await context.plugin(Development, { dataDir: dir, persistence: { database: getDb, flush: flushMetaDb } });
  const documents = await context.plugin(Documents);
  const project = context.localappDevelopment.projects.create("alice", "skills-app", { "src/a": "preserved" });
  const settings = new AgentSettingsStore(dir);
  settings.write("alice", { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://localhost:1/v1", model: "own", apiKey: "own" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
  app.register(async scope => context.localappDevelopment.registerRoutes(scope, {
   builds: context.localappDevelopment.builds(createBuildOperations()), previews: {} as never,
   user: () => "alice", isAuthenticated: () => true, settings, runtimeRegistry: context.localappMultiuser,
   pythonEnvironment: () => undefined, documents: () => context.get("localappDocuments"),
   environment: async () => ({ checks: ["runner", "python", "pypdf", "pdfplumber", "reportlab"].map(id => ({ id, status: ready ? "ready" : "missing" })) }) as never,
   createHarness: input => { config = input; return { initialize: async () => { entered(); if (mode === "initializing") await pending; }, close: async () => { closed++; }, listSessions: async () => [] } as never; },
  }));
  const url = `/api/development/projects/${project.id}/agent/settings`;
  const payload = { enabledCapabilities: ["skills"], disabledTools: [], enabledSkills: ["pdf"] };
  expect((await app.inject({ method: "PUT", url, payload })).statusCode).toBe(400);
  ready = true;
  expect((await app.inject({ method: "PUT", url, payload })).statusCode).toBe(200);
  expect((await app.inject({ url })).json().data.enabledSkills).toEqual(["pdf"]);
  expect((await app.inject({ method: "PUT", url, payload: { enabledCapabilities: ["skills"], disabledTools: ["bash"] } })).statusCode).toBe(200);
  expect(settings.read("alice").applications["development:" + project.id].skills).toEqual(["pdf"]);
  const request = app.inject({ url: `/api/development/projects/${project.id}/agent/sessions` });
  await initializing;
  if (mode === "active") expect((await request).statusCode).toBe(200);
  expect(config.skills).toEqual(["pdf"]); expect(config.publicSkillsRoot).toBe(context.localappDocuments.root);
  await documents.dispose(); release();
  if (mode === "initializing") expect((await request).statusCode).toBe(400);
  expect(closed).toBe(1);
  expect((await app.inject({ url })).json().data.skills.every((skill: any) => !skill.available)).toBe(true);
 } finally { release(); await app.close(); await context.fiber.dispose(); }
});
it("builds a fixed version and reconciles interrupted records",async()=>{
 const binary=Buffer.from([0,255,137,80,78,71]);
 const p=projects.create("alice","example-app",{"src/main.ts":"first","public/logo.png":{encoding:"base64",content:binary.toString("base64")}});let finish!:()=>void;const gate=new Promise<void>(r=>finish=r);
 const builds=new DevelopmentBuilds(dir,projects,async input=>{await gate;expect(fs.readFileSync(path.join(input.workspace,"public/logo.png"))).toEqual(binary);expect(fs.readFileSync(path.join(input.workspace,"src/main.ts"),"utf8")).toBe("first");return {path:path.join(input.workspace,"app.localapp"),sha256:"test"};});
 const b=builds.start(p.id,"alice");const f=projects.read(p.id,"alice","src/main.ts");projects.write(p.id,"alice",f.path,"second",f.hash);finish();await builds.wait(b.id);
 expect(builds.get(p.id,"alice",b.id).status).toBe("succeeded");expect(()=>builds.get(p.id,"bob",b.id)).toThrow();
 const file=path.join(projects.directory,p.id,"builds",b.id,"record.json");const record=JSON.parse(fs.readFileSync(file,"utf8"));record.status="running";fs.writeFileSync(file,JSON.stringify(record));
 const restarted=new DevelopmentBuilds(dir,projects,async()=>{throw Error("never")});expect(restarted.get(p.id,"alice",b.id).status).toBe("interrupted");
});
it("does not mark failed or cancelled builds publishable",async()=>{
 const p=projects.create("alice","example-app",{"src/a":"a"});const builds=new DevelopmentBuilds(dir,projects,async()=>{throw Error("build failed")});const b=builds.start(p.id,"alice");await builds.wait(b.id);expect(builds.get(p.id,"alice",b.id).status).toBe("failed");expect(builds.get(p.id,"alice",b.id).log).toContain("build failed");
});

it("cancels active builds when the development plugin is disposed",async()=>{
 const {Context}=await import("@deepseek-ai/cordis");
 const {default:ApplicationDevelopment}=await import("@localapp/dsh-app-development");
 const ctx=new Context();
 await ctx.plugin(ApplicationDevelopment,{dataDir:dir,persistence:{database:getDb,flush:flushMetaDb}});
 const p=ctx.localappDevelopment.projects.create("alice","example-app",{"src/a":"a"});
 let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
 const builds=ctx.localappDevelopment.builds(createBuildOperations(),async input=>{
  started();await new Promise<void>((resolve)=>{input.signal.addEventListener("abort",()=>resolve(),{once:true});});
  throw Error("cancelled");
 });
 const b=builds.start(p.id,"alice");await ready;
 await ctx.fiber.dispose();
 expect(builds.get(p.id,"alice",b.id).status).toBe("cancelled");
 expect(()=>builds.start(p.id,"alice")).toThrow("构建服务已停止");
});

it("stops serving development contributions after the plugin is disposed", async () => {
 const { Context } = await import("@deepseek-ai/cordis");
 const { default: ApplicationDevelopment } = await import("@localapp/dsh-app-development");
 const { default: Fastify } = await import("fastify");
 const { AgentSettingsStore } = await import("../../agent-settings.js");
 const context = new Context();
 const app = Fastify();
 try {
  await context.plugin(ApplicationDevelopment, { dataDir: dir, persistence: { database: getDb, flush: flushMetaDb } });
  const development = context.localappDevelopment;
  expect(() => development.registerRoutes(app, {} as never)).toThrow("Multiuser runtime service is required");
  const { default: Multiuser } = await import("@localapp/dsh-multiuser");
  await context.plugin(Multiuser);
  const project = development.projects.create("alice", "lifecycle-app", { "src/a": "preserved" });
  const builds = development.builds(createBuildOperations());
  app.register(async scope => development.registerRoutes(scope, {
   builds, previews: {} as never,
   user: () => "alice", isAuthenticated: () => true, settings: new AgentSettingsStore(dir),
   pythonEnvironment: () => undefined,
   createHarness: () => { throw new Error("This route must not create an Agent"); },
  }));
  const before = await app.inject({ url: "/api/development/projects" });
  expect(before.statusCode).toBe(200);
  expect(before.json().data.map((entry: { id: string }) => entry.id)).toContain(project.id);
  await context.fiber.dispose();
  const after = await app.inject({ url: "/api/development/projects" });
  expect(after.statusCode).toBe(503);
  expect(() => development.agentRunner({} as never)).toThrow("plugin is stopped");
  expect(() => development.builds(createBuildOperations())).toThrow("plugin is stopped");
  expect(() => development.previews({} as never, {} as never)).toThrow("plugin is stopped");
  expect(() => development.releases({} as never)).toThrow("plugin is stopped");
  expect(() => development.registerSource(app, { user: () => "alice" })).toThrow("plugin is stopped");

  expect(after.body).not.toContain(project.id);
  expect(development.projects.read(project.id, "alice", "src/a").content).toBe("preserved");
 } finally { await app.close(); await context.fiber.dispose(); }
});

it("does not launch a queued build after the service closes",async()=>{
 const project=projects.create("alice","queued-app",{"src/a":"preserved"});
 const task=vi.fn(async()=>{throw new Error("Queued task must not execute");});
 const builds=new DevelopmentBuilds(dir,projects,task);
 const build=builds.start(project.id,"alice");
 await builds.close();
 expect(task).not.toHaveBeenCalled();
 expect(builds.get(project.id,"alice",build.id).status).toBe("cancelled");
 expect(()=>builds.start(project.id,"alice")).toThrow("构建服务已停止");
 await builds.close();
 expect(projects.read(project.id,"alice","src/a").content).toBe("preserved");
});

it.each(["ownership", "account", "active-account", "mcp", "provider", "python", "active-python"])("closes developer runtime when access changes: %s", async change => {
 const { Context } = await import("@deepseek-ai/cordis");
 const { default: ApplicationDevelopment } = await import("@localapp/dsh-app-development");
 const { default: Multiuser } = await import("@localapp/dsh-multiuser");
 const { default: Fastify } = await import("fastify");
 const { AgentSettingsStore } = await import("../../agent-settings.js");
 const context = new Context(), app = Fastify();
 let entered!: () => void, resume!: () => void;
 const initializing = new Promise<void>(resolve => { entered = resolve; });
 const pending = new Promise<void>(resolve => { resume = resolve; });
 let closed = 0, request: Promise<{statusCode: number}> | undefined;
 let accountExists = true;
 let pythonEnvironment: import("../../python-environment.js").PythonEnvironment | undefined;
 const active = change === "active-account" || change === "active-python";
 let capabilities: readonly string[] | undefined;
 let mcpServers: unknown;
 try {
  await context.plugin(Multiuser);
  await context.plugin(ApplicationDevelopment, { dataDir: dir, persistence: { database: getDb, flush: flushMetaDb } });
  const development = context.localappDevelopment;
  const project = development.projects.create("alice", "initialization-app", { "src/a": "preserved" });
  const settings = new AgentSettingsStore(dir);
  settings.write("alice", { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://localhost:1/v1", model: "own", apiKey: "own" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
  if (change === "active-account") settings.write("alice", { ...settings.read("alice"), mcpServers: [{ serverName: "project", transport: "stdio", command: "node", args: ["project-mcp.js"], env: { PROJECT_MARKER: "alice" } }] });
  app.register(async scope => development.registerRoutes(scope, {
   builds: development.builds(createBuildOperations()), previews: {} as never,
   user: () => "alice", isAuthenticated: () => true, settings,
   accountExists: () => accountExists,
   runtimeRegistry: context.localappMultiuser,
   pythonEnvironment: () => pythonEnvironment,
   createHarness: config => {
    capabilities = config.capabilities;
    mcpServers = config.mcpServers;
    return ({ initialize: async () => { entered(); await pending; }, close: async () => { closed++; }, listSessions: async () => [] }) as never;
   },
  }));
  request = app.inject({ url: `/api/development/projects/${project.id}/agent/sessions` });
  await initializing;
  expect(capabilities).toContain("jobs");
  expect(capabilities).toContain("subagents");
  expect(capabilities).toContain("workflow");
  expect(capabilities).toContain("web");
  expect(capabilities).toContain("schedule");
  expect(mcpServers).toEqual(settings.read("alice").mcpServers);
  expect(capabilities?.includes("mcp")).toBe(change === "active-account");
  if (active) {
   resume();
   expect((await request).statusCode).toBe(200);
   expect(context.localappMultiuser.forUser("alice")).toHaveLength(1);
  }
  if (change === "ownership") {
   getDb().run("UPDATE development_projects SET ownerId = 'bob' WHERE id = ?", [project.id]); flushMetaDb();
  } else if (change === "mcp") settings.write("alice", { ...settings.read("alice"), mcpServers: [{ serverName: "changed", transport: "stdio", command: "node" }] });
  else if (change === "provider") settings.write("alice", { ...settings.read("alice"), providers: [], defaultProviderId: "" });
  else if (change === "python" || change === "active-python") pythonEnvironment = { executable: path.join(dir, "new-python", "bin", "python"), directory: path.join(dir, "new-python"), baseDirectory: path.join(dir, "base-python"), version: "3.12.0", revision: "changed-environment", managed: true };
  else accountExists = false;
  resume();
  if (active) await vi.waitFor(() => expect(closed).toBe(1), { timeout: 3000 });
  else expect((await request).statusCode).toBe(change === "mcp" || change === "provider" || change === "python" ? 400 : 404);
  expect(closed).toBe(1);
  expect(context.localappMultiuser.forUser("alice")).toHaveLength(0);
  expect(development.projects.read(project.id, change === "ownership" ? "bob" : "alice", "src/a").content).toBe("preserved");
 } finally { resume(); await request; await app.close(); await context.fiber.dispose(); }
});

it("keeps the current test preview for read-only native turns and builds after source changes",async()=>{
 const {Context}=await import('@deepseek-ai/cordis');
 const {default:Development}=await import('@localapp/dsh-app-development');
 const {default:Multiuser}=await import('@localapp/dsh-multiuser');
 const {default:Fastify}=await import('fastify');
 const {AgentSettingsStore}=await import('../../agent-settings.js');
 const context=new Context(),app=Fastify();let config:any;
 try{
  await context.plugin(Multiuser);await context.plugin(Development,{dataDir:dir,persistence:{database:getDb,flush:flushMetaDb}});
  const development=context.localappDevelopment,project=development.projects.create('alice','page-read-test',{'src/a':'before'});
  const settings=new AgentSettingsStore(dir);settings.write('alice',{providers:[{id:'own',name:'Own',protocol:'openai-completions',baseUrl:'http://localhost:1/v1',model:'own',apiKey:'own'}],defaultProviderId:'own',grants:{},mcpServers:[]});
  const builds=development.builds(createBuildOperations()),start=vi.spyOn(builds,'start').mockReturnValue({id:'test'} as never);
  app.register(async scope=>development.registerRoutes(scope,{builds,previews:{} as never,user:()=> 'alice',isAuthenticated:()=>true,settings,runtimeRegistry:context.localappMultiuser,pythonEnvironment:()=>undefined,createHarness:value=>{config=value;return {initialize:async()=>{},close:async()=>{},listSessions:async()=>[]} as never;}}));
  expect((await app.inject({url:`/api/development/projects/${project.id}/agent/sessions`})).statusCode).toBe(200);
  expect(config.applicationTools.map((tool:any)=>tool.name)).toEqual(expect.arrayContaining(['get_current_page','run_preview_check','get_preview_check_results']));
  config.onNativePrompt('read-only');config.onNativeAgentStatus('read-only','idle');expect(start).not.toHaveBeenCalled();development.projects.assertIdle(project.id,'alice');
  config.onNativePrompt('edit');fs.writeFileSync(path.join(development.projects.workspace(project.id,'alice'),'src/a'),'after');config.onNativeAgentStatus('edit','idle');
  expect(start).toHaveBeenCalledExactlyOnceWith(project.id,'alice','preview');development.projects.assertIdle(project.id,'alice');
  config.onNativePrompt('verify-after-edit');fs.writeFileSync(path.join(development.projects.workspace(project.id,'alice'),'src/a'),'third');
  const run=await config.applicationTools.find((tool:any)=>tool.name==='run_preview_check').execute({steps:[{action:'assert',selector:'h1',visible:true}]});
  expect(run.status).toBe('queued');expect(start).toHaveBeenCalledTimes(1);
  const results=config.applicationTools.find((tool:any)=>tool.name==='get_preview_check_results').execute({});
  expect(JSON.parse(JSON.stringify(results))).toEqual(results);
  expect(results[0]).toMatchObject({status:'queued',error:null,results:[],imageError:null,screenshotUrl:null});
  const failed={id:'checked-build',sourceVersion:run.sourceVersion,status:'failed'};
  start.mockReturnValue(failed as never);vi.spyOn(builds,'get').mockReturnValue(failed as never);
  config.onNativeAgentStatus('verify-after-edit','idle');
  await vi.waitFor(()=>expect(JSON.parse(fs.readFileSync(path.join(development.projects.directory,project.id,'verification',run.id+'.json'),'utf8'))).toMatchObject({status:'failed',result:{error:expect.stringContaining('编译未通过')}}));

 }finally{await app.close();await context.fiber.dispose();}
});
