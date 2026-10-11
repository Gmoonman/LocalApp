import { expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import initSqlJs from "sql.js";
it("does not initialize workflow hosts after stopping during authentication", async () => {
 const {Context}=await import("@deepseek-ai/cordis");
 const {default:Development}=await import("@localapp/dsh-app-development");
 const root=path.resolve(process.cwd(),"../../tmp/development-lifecycle");await fs.mkdir(root,{recursive:true});
 const dataDir=await fs.mkdtemp(path.join(root,"pending-auth-"));const SQL=await initSqlJs();const db=new SQL.Database();
 const context=new Context();const app=Fastify();
 let resume!:()=>void;const pending=new Promise<void>(resolve=>{resume=resolve;});
 const authenticate=vi.fn(()=>pending);const development=vi.fn(async()=>undefined as never);
 try{
  await context.plugin(Development,{dataDir,persistence:{database:()=>db,flush:()=>{}}});
  context.localappDevelopment.registerWorkflowRoutes(app,{authenticate,development,workspaces:undefined as never,tasks:undefined as never});
  const ready=app.ready();const rejected=expect(ready).rejects.toThrow("stopped");
  await vi.waitFor(()=>expect(authenticate).toHaveBeenCalledOnce());
  await context.fiber.dispose();resume();await rejected;
  expect(development).not.toHaveBeenCalled();
 }finally{resume();await app.close();await context.fiber.dispose();db.close();await fs.rm(dataDir,{recursive:true,force:true});}
});
it("stops debug routes and identity simulation with the development plugin", async () => {
 const {Context}=await import("@deepseek-ai/cordis");
 const {default:Development}=await import("@localapp/dsh-app-development");
 const root=path.resolve(process.cwd(),"../../tmp/development-lifecycle");await fs.mkdir(root,{recursive:true});
 const dataDir=await fs.mkdtemp(path.join(root,"toolkit-"));const SQL=await initSqlJs();const db=new SQL.Database();
 const context=new Context();const app=Fastify();const user={id:"alice",name:"alice",role:"user",displayName:null,avatarUrl:null};const setIdentity=vi.fn();
 try{
  await context.plugin(Development,{dataDir,persistence:{database:()=>db,flush:()=>{}}});
  const development=context.localappDevelopment;
  const host={dataDir,user:()=>user,users:()=>[user],keyOwner:()=>"alice",userId:()=>"alice",setIdentity,recentRequests:()=>[]};
  const toolkit=development.createDevToolkit(host);await toolkit.installRequestContext(app);app.get("/probe",async()=>({success:true}));app.register(async scope=>toolkit.register(scope));await app.ready();
  const headers={"x-api-key":"key","x-localapp-dev-page":"demo"};
  expect((await app.inject({url:"/api/dev/context",headers})).statusCode).toBe(200);
  await app.inject({url:"/probe",headers});expect(setIdentity).toHaveBeenCalled();setIdentity.mockClear();
  await context.fiber.dispose();
  expect((await app.inject({url:"/api/dev/context",headers})).statusCode).toBe(503);
  await app.inject({url:"/probe",headers});expect(setIdentity).not.toHaveBeenCalled();
  expect(()=>development.createDevToolkit(host)).toThrow("stopped");
  expect(()=>development.registerWorkflowRoutes(app, undefined as never)).toThrow("stopped");
  expect(()=>development.registerDeveloperUtilities(app, undefined as never)).toThrow("stopped");
  await expect(development.initializeRuntime(app, undefined as never)).rejects.toThrow("stopped");
 }finally{await app.close();await context.fiber.dispose();db.close();await fs.rm(dataDir,{recursive:true,force:true});}
});
