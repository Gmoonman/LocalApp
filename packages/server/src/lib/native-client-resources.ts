import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis" with { "resolution-mode": "import" };
import type NativeClientAssets from "@localapp/dsh-multiuser/native-client-assets" with { "resolution-mode": "import" };
const loading=new WeakMap<Context,Promise<NativeClientAssets>>();
export function nativeClientAssets(context:Context) {
 let ready=loading.get(context);
 if(!ready) {
  ready=(async()=>{
   const require=createRequire(path.join(__dirname,"../package.json"));
   const {default:Assets}=await import(pathToFileURL(require.resolve("@localapp/dsh-multiuser/native-client-assets")).href);
   if(!context.get("nativeClientAssets")) await context.plugin(Assets, {
    contributions: [
     ...(context.get("localappAgentUI") ? [pathToFileURL(require.resolve("@localapp/dsh-agent-ui/client-host")).href] : []),
     ...(context.get("localappApps") ? [pathToFileURL(require.resolve("@localapp/dsh-app-platform/client-host")).href] : []),
     ...(context.get("localappDevelopment") ? [pathToFileURL(require.resolve("@localapp/dsh-app-development/client-host")).href] : []),
    ],
   });
   return context.nativeClientAssets;
  })();loading.set(context,ready);
 }
 return ready;
}
export function developmentClientResources(context:Context,root?:string) {
 return {
  async renderIndex(html:string){return (await nativeClientAssets(context)).renderIndex(html);},
  async resource(request:import("node:http").IncomingMessage,response:import("node:http").ServerResponse){return (await nativeClientAssets(context)).resource(request,response);},
  async entry(filename:string){
   if(!root||!/^(?:entry\.(?:js|css)|assets\/[a-zA-Z0-9_.-]+\.(?:woff2?|ttf))$/.test(filename)) return null;
   try {
    const bytes=await fs.readFile(path.join(root,filename));
    const mime=filename.endsWith(".js")?"application/javascript":filename.endsWith(".css")?"text/css":filename.endsWith(".woff2")?"font/woff2":filename.endsWith(".woff")?"font/woff":"font/ttf";
    return {bytes,mime};
   } catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
  }
 };
}
