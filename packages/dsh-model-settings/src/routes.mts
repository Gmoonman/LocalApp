import type {FastifyInstance,FastifyRequest} from 'fastify';
import {Context} from '@deepseek-ai/cordis';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Duplex} from 'node:stream';
import {mountUserModels} from './runtime.mjs';
import {UserModelStore} from './storage.cjs';
export interface ModelSettingsHost {
 store:UserModelStore;
 publicUrl?:string;
 userId(request:FastifyRequest):string;
 isAuthenticated(request:FastifyRequest,user:string):boolean;
 authenticate(scope:FastifyInstance):Promise<void>;
 create(user:string):Promise<{ctx:Context;transport:{http(user:string,req:IncomingMessage,res:ServerResponse):Promise<boolean>;upgrade(user:string,req:IncomingMessage,socket:Duplex,head:Buffer):Promise<boolean>}}>;
 assets:{renderIndex(html:string):Promise<string>;resource(req:IncomingMessage,res:ServerResponse):Promise<boolean>;entry(file:string):Promise<{bytes:Buffer;mime:string}|null>};
}
export async function registerUserModelRoutes(app:FastifyInstance,host:ModelSettingsHost){
 const sessions=new Map<string,Promise<Awaited<ReturnType<ModelSettingsHost['create']>>>>();
 const runtime=(user:string)=>{let promise=sessions.get(user);if(!promise){promise=(async()=>{const native=await host.create(user);try{await mountUserModels(native.ctx,user,host.store);return native;}catch(e){await native.ctx.fiber.dispose();throw e;}})();sessions.set(user,promise);void promise.catch(()=>sessions.delete(user));}return promise;};
 const upgrades=new WeakMap<IncomingMessage,{socket:Duplex;head:Buffer}>();
 const capture=(req:IncomingMessage,socket:Duplex,head:Buffer)=>{if(new URL(req.url??'/', 'http://localapp.invalid').pathname==='/api/model-settings/native/api/remote.mux')upgrades.set(req,{socket,head});};
 const checks=new Set<()=>void>();app.server.prependListener('upgrade',capture);
 app.addHook('onClose',async()=>{app.server.removeListener('upgrade',capture);for(const close of checks)close();await Promise.allSettled([...sessions.values()].map(async item=>{await (await item).ctx.fiber.dispose();}));sessions.clear();});
 app.register(async scope=>{
  await host.authenticate(scope);
  const base='/api/model-settings/native/';
  scope.get(base,async(req,reply)=>{await runtime(host.userId(req));const html=`<!doctype html><html><head><meta charset="utf-8"><base href="${base}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="client/entry.css"></head><body><div id="root"></div><script>globalThis.__LOCALAPP_USER_MODEL_SETTINGS__=true;</script><script type="module" src="client/entry.js"></script></body></html>`;return reply.header('Cache-Control','no-store').type('text/html').send(await host.assets.renderIndex(html));});
  scope.register(async rpc=>{
  rpc.addHook('onRequest',async(req,reply)=>{
   const user=host.userId(req),native=await runtime(user),original=req.raw.url;
   const pathname=new URL(original??'/', 'http://localapp.invalid').pathname;
   const relative=pathname.slice(base.length);
   const publicOrigin=host.publicUrl?new URL(host.publicUrl):undefined;
   const forwardedProtocol=req.headers['x-forwarded-proto'];
   const protocol=forwardedProtocol==='https'||forwardedProtocol==='http'?forwardedProtocol:req.protocol;
   const expectedOrigin=publicOrigin&&publicOrigin.host===req.headers.host?publicOrigin.origin:`${protocol}://${req.headers.host}`;
   if(relative.startsWith('api/')&&!(req.method==='GET'&&!req.headers.origin)){if(req.headers.origin!==expectedOrigin)return reply.status(403).send({success:false,error:'Invalid model settings origin'});}
   // The outer Server authenticates and checks the browser origin above. The
   // private dsh listener serves the configured public host, including when
   // the outer Server was reached through another same-origin proxy address.
   const originalHost=req.raw.headers.host,originalOrigin=req.raw.headers.origin;
   if(publicOrigin){req.raw.headers.host=publicOrigin.host;if(originalOrigin)req.raw.headers.origin=publicOrigin.origin;}
   req.raw.url='/'+(original??'').slice(base.length);
   try{
    if(relative.startsWith('client/')){const asset=await host.assets.entry(relative.slice(7));if(!asset)return reply.status(404).send();return reply.type(asset.mime).send(asset.bytes);}
    if(relative.startsWith('plugins/')){reply.hijack();if(!await host.assets.resource(req.raw,reply.raw)){reply.raw.writeHead(404);reply.raw.end();}return;}
    reply.hijack();const upgrade=upgrades.get(req.raw);upgrades.delete(req.raw);if(upgrade){if(!host.isAuthenticated(req,user)){upgrade.socket.destroy();return;}const timer=setInterval(()=>{if(!host.isAuthenticated(req,user))upgrade.socket.destroy();},1000);timer.unref();const close=()=>{clearInterval(timer);checks.delete(close);upgrade.socket.destroy();};checks.add(close);upgrade.socket.once('close',close);}const handled=upgrade?await native.transport.upgrade(user,req.raw,upgrade.socket,upgrade.head):await native.transport.http(user,req.raw,reply.raw);if(!handled){reply.raw.writeHead(404);reply.raw.end();}
   }finally{req.raw.url=original;if(originalHost===undefined)delete req.raw.headers.host;else req.raw.headers.host=originalHost;if(originalOrigin===undefined)delete req.raw.headers.origin;else req.raw.headers.origin=originalOrigin;}
  });
  rpc.all(base+'*',async()=>{});
  });
 });
}
