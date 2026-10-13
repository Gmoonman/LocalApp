import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { developmentEnvironment, saveDevelopmentSettings } from "@localapp/dsh-app-development/environment";
const root=path.resolve(__dirname,"../../../../../../tmp/platform-development/environment-tests");
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
it("reports denied loopback tests and closes the executor",async()=>{
 const dependencies=path.join(root,"node_modules");fs.mkdirSync(path.join(dependencies,".bin"),{recursive:true});
 for(const name of ["vite","tsc","vitest"]) fs.writeFileSync(path.join(dependencies,".bin",name),"");
 saveDevelopmentSettings(root,{dependenciesDirectory:dependencies});
 const close=vi.fn(async()=>{});let calls=0;
 const report=await developmentEnvironment(root,async input=>{
  expect(input.networkBlocked).toBe(true);expect(input.workspaceRoot.startsWith(root)).toBe(true);
  return {initialize:async()=>{},close,executeDevelopmentCommand:async()=>({exitCode:++calls===1?0:1,timedOut:false,stdout:{text:""},stderr:{text:"listen EPERM"}})};
 });
 expect(report.ready).toBe(false);expect(report.checks.find(c=>c.id==="dependencies")?.ready).toBe(true);
 expect(report.checks.find(c=>c.id==="localTests")?.ready).toBe(false);expect(close).toHaveBeenCalledOnce();
});
it("rejects insecure remote previews before writing settings",()=>{
 expect(()=>saveDevelopmentSettings(root,{previewOrigin:"http://{previewId}.example.com"})).toThrow("HTTPS");
 expect(fs.existsSync(path.join(root,"development","settings.json"))).toBe(false);
});

it("checks the same allocated loopback ports used by release builds",async()=>{
 const dependencies=path.join(root,"node_modules");fs.mkdirSync(path.join(dependencies,".bin"),{recursive:true});
 for(const name of ["vite","tsc","vitest"]) fs.writeFileSync(path.join(dependencies,".bin",name),"");
 saveDevelopmentSettings(root,{dependenciesDirectory:dependencies});
 const close=vi.fn(async()=>{});let calls=0;
 const report=await developmentEnvironment(root,async input=>{
  expect(input.networkBlocked).toBe(true);
  expect(input.localTestPorts).toHaveLength(2);
  expect(new Set(input.localTestPorts).size).toBe(2);
  expect(input.localTestPorts!.every(port=>Number.isInteger(port)&&port>=1024&&port<=65535)).toBe(true);
  return {initialize:async()=>{},close,executeDevelopmentCommand:async(_command,args)=>{
   if(++calls===2){expect(args.join(" ")).toContain("LOCALAPP_TEST_BACKEND_PORT");expect(args.join(" ")).not.toContain("s.listen(0");}
   return {exitCode:0,timedOut:false,stdout:{text:""},stderr:{text:""}};
  }};
 });
 expect(report.ready).toBe(true);expect(close).toHaveBeenCalledOnce();
});

it("accepts a fixed HTTPS preview address on another port",()=>{
 expect(saveDevelopmentSettings(root,{previewOrigin:"https://apps.example.com:60014"}).previewOrigin).toBe("https://apps.example.com:60014");
});
