import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import {resolveDeepSeekPlugin} from './deepseek-plugin.mjs';
import Models from '@localapp/dsh-model-settings';
import {AgentSettingsStore} from './agent-settings.js';

import type {} from '@localapp/dsh-multiuser/native-client-assets';

import {developmentClientResources} from './native-client-resources.js';
import {isRequestUserAuthenticated} from '../plugins/auth.js';
import type {FastifyInstance} from 'fastify';
export async function registerModelSettings(app:FastifyInstance,ctx:Context,authenticate:(scope:FastifyInstance)=>Promise<void>,root?:string){
 if(!ctx.get('localappModelSettings')) await ctx.plugin(resolveDeepSeekPlugin(Models));
 const settings=new AgentSettingsStore(app.config.dataDir);
 const assetsContext=new Context();ctx.effect(()=>()=>assetsContext.fiber.dispose());
 const packages=[
 '@deepseek-ai/dsh-api-gateway','@deepseek-ai/dsh-api-remotes',
 '@deepseek-ai/dsh-api-settings-controller',
 '@deepseek-ai/dsh-client-connection','@deepseek-ai/dsh-client-locale',
 '@deepseek-ai/dsh-client-modules','@deepseek-ai/dsh-client-resources',
 '@deepseek-ai/dsh-client-ui-renderer','@deepseek-ai/dsh-client-ui-settings',
 '@deepseek-ai/dsh-client-ui-settings-models','@deepseek-ai/dsh-client-ui-theme',
 '@deepseek-ai/dsh-typert-registry','@localapp/dsh-model-settings'];
 const require=createRequire(typeof __filename === "string" ? __filename : import.meta.url);
 const {default:NativeAssets}=await import(pathToFileURL(require.resolve('@localapp/dsh-multiuser/native-client-assets')).href);
 const {default:EmbeddedWebServer}=await import(pathToFileURL(require.resolve('@localapp/dsh-multiuser/native-server')).href);
 const {mountNativeConnection}=await import(pathToFileURL(require.resolve('@localapp/dsh-multiuser/native-connection')).href);
 await assetsContext.plugin(resolveDeepSeekPlugin(NativeAssets),{baseUrl:pathToFileURL(require.resolve('@localapp/dsh-model-settings')).href,packages});
 const files=developmentClientResources(ctx,root);
 await ctx.localappModelSettings.registerHttp(app,{
 store:settings.models,publicUrl:app.config.publicUrl,userId:req=>req.userId!,authenticate,
 isAuthenticated:isRequestUserAuthenticated,
 create:async user=>{
  const userContext=new Context();
  try {
   await userContext.plugin(resolveDeepSeekPlugin(EmbeddedWebServer),{host:'127.0.0.1',port:0});
   const transport=await mountNativeConnection(userContext,{userId:user,trustedHosts:app.config.publicUrl?[new URL(app.config.publicUrl).host]:[],root:path.join(app.config.dataDir,'model-settings','connections',createHash('sha256').update(user).digest('hex'))});
   return {ctx:userContext,transport};
  } catch(error){await userContext.fiber.dispose();throw error;}
 },
 assets:{renderIndex:html=>assetsContext.nativeClientAssets.renderIndex(html),resource:(req,res)=>assetsContext.nativeClientAssets.resource(req,res),entry:files.entry}
 });
}
