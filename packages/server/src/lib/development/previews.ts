export * from "@localapp/dsh-app-development/previews";
import { DevelopmentPreviews as PluginPreviews, type Preview } from "@localapp/dsh-app-development/previews";
import type { ProjectStore } from "./projects.js";
import type { DevelopmentBuilds } from "./builds.js";
declare module "fastify" { interface FastifyRequest { developmentPreview?: Preview; } }
export const previewHost: import("@localapp/dsh-app-development/previews").PreviewHost = {
 authorize(req,preview) {
  req.developmentPreview={...preview};req.visitorId=preview.owner;req.visitorName="开发预览";
  req.visitorRole="user";req.authSessionTokenHash=null;
 },
 cookie:(req,preview)=>req.cookies?.[`localapp_preview_${preview.id}`],
 setCookie(reply,token,preview) { reply.setCookie(`localapp_preview_${preview.id}`,token,{httpOnly:true,sameSite:"none",secure:true,partitioned:true,path:"/",maxAge:3600}); },
};
export class DevelopmentPreviews extends PluginPreviews {
 constructor(dataDir:string,projects:ProjectStore,builds:DevelopmentBuilds) { super(dataDir,projects,builds,previewHost); }
}
