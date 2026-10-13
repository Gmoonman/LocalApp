import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { expect, it } from 'vitest';
import { UserModelStore } from '@localapp/dsh-model-settings/storage';
import { mountUserModels } from '@localapp/dsh-model-settings/runtime';
const parent=path.resolve(import.meta.dirname,'../../../../../tmp/model-settings/tests');
async function fixture(){await fs.mkdir(parent,{recursive:true});const directory=await fs.mkdtemp(path.join(parent,'case-'));const store=new UserModelStore(directory,user=>({providers:user==='alice'?[{id:'existing',name:'Existing',protocol:'openai-completions',baseUrl:'http://127.0.0.1:3059/v1',model:'original',apiKey:'migration-secret'}]:[],defaultProviderId:user==='alice'?'existing':''}));return {directory,store};}
it('migrates encrypted credentials and defaults with per-user isolation',async()=>{
 const {directory,store}=await fixture();try{
 expect(store.providers('alice')[0].apiKey).toBe('migration-secret');expect(store.read('alice').defaultProviderId).toBe('existing');expect(store.providers('bob')).toEqual([]);
 const location=(user:string)=>path.join(directory,'model-settings',createHash('sha256').update(user).digest('hex')+'.json');
 expect(await fs.readFile(location('alice'),'utf8')).not.toContain('migration-secret');
 await fs.copyFile(location('alice'),location('bob'));expect(()=>store.read('bob')).toThrow();
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
it('uses dsh settings and catalog with conflict checks, redacted credentials and complete profiles',async()=>{
 const {directory,store}=await fixture();const alice=new Context(),bob=new Context();try{
 await mountUserModels(alice,'alice',store);await mountUserModels(bob,'bob',store);
 const controller=alice.get('settingsController') as {describe():{namespaces:{revision:number}[]};mutate(ns:string,ops:unknown[],revision?:number):Promise<unknown>};
 const credentials=alice.get('credentials') as {set(ref:string,value:string):Promise<void>;describe(ref:string):Promise<{configured:boolean}>};
 const otherCredentials=bob.get('credentials') as {resolve(ref:string):Promise<unknown>};
 expect(alice.llm.listConfigurableProviders().some(p=>p.provider==='openai')).toBe(true);
 const revision=controller.describe().namespaces[0].revision;
 await controller.mutate('llm-pi-ai',[{op:'set',path:['providers','deepseek'],value:{apiKeyEnv:'DEEPSEEK_API_KEY'}}],revision);
 expect(store.providers('alice').some(p=>p.id==='deepseek'&&p.model)).toBe(true);
 await expect(controller.mutate('llm-pi-ai',[],revision)).rejects.toThrow('changed');
 await expect(controller.mutate('llm-pi-ai',[{op:'set',path:['providers','__proto__','polluted'],value:true}])).rejects.toThrow('path');
 await credentials.set('DEEPSEEK_API_KEY' as never,'private-marker');
 const view=await credentials.describe('DEEPSEEK_API_KEY' as never);expect(view.configured).toBe(true);expect(JSON.stringify(view)).not.toContain('private-marker');expect(await otherCredentials.resolve('DEEPSEEK_API_KEY' as never)).toBeUndefined();
 const doc=store.read('alice');doc.providers.existing.models=[{id:'original',input:['text','image']},{id:'second'}];doc.providers.existing.headers={'X-Test':'preserved'};store.save('alice',doc);
 store.updateLegacy('alice',store.providers('alice'),doc.defaultProviderId);expect(store.read('alice').providers.existing.models).toHaveLength(2);expect(store.read('alice').providers.existing.headers).toEqual({'X-Test':'preserved'});
 await controller.mutate('llm-pi-ai',[{op:'unset',path:['providers','existing']}]);expect(store.read('alice').defaultProviderId).toBe('deepseek');
 }finally{await alice.fiber.dispose();await bob.fiber.dispose();await fs.rm(directory,{recursive:true,force:true});}
});
it('runs native developer prompts through the configured dsh route and preserves advanced options',async()=>{
 const {vi}=await import('vitest');const {DeepSeekHarness}=await import('../deepseek-harness.mjs');
 await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'native-'));const requests:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{
 requests.push({body:JSON.parse(options.body),headers:new Headers(options.headers)});
 return new Response('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'model-a',choices:[{index:0,delta:{role:'assistant',content:'configured route replied'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'model-a',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 }));
 const harness=new DeepSeekHarness({ownerId:'alice',root,capabilities:[],llmApiKey:'private-test',llmBaseUrl:'http://model.test/v1',llmModel:'model-a',protocol:'openai-completions',dshRoute:'custom-route',dshProfile:{api:'openai-completions',baseURL:'http://model.test/v1',headers:{'X-LocalApp-Test':'preserved'},models:[{id:'model-a',input:['text','image']},{id:'model-b'}]}});
 try{
 const native=await harness.nativeApi();const {sessionId}=await native.gateway.invoke({namespace:'session',method:'create',args:{request:{}}}) as {sessionId:string};
 await native.gateway.invoke({namespace:'session',method:'prompt',args:{request:{sessionId,requestId:'configuration-test',mode:'queue',content:[{type:'text',text:'hello'}]}}});
 const read=async()=>{const controller=new AbortController();const stream=await native.gateway.stream({namespace:'session',method:'follow',args:{request:{address:{kind:'session',sessionId}}},signal:controller.signal});const iterator=stream[Symbol.asyncIterator]();try{return (await iterator.next()).value;}finally{controller.abort();await iterator.return?.();}};
 await vi.waitFor(async()=>expect(JSON.stringify(await read())).toContain('configured route replied'));
 expect(requests[0].body.model).toBe('model-a');expect(requests[0].headers.get('authorization')).toBe('Bearer private-test');expect(requests[0].headers.get('x-localapp-test')).toBe('preserved');
 const events:any[]=[];await harness.run('alice',{sessionId:'compatibility-model-settings',prompt:'hello',systemPrompt:'test',tools:[]},event=>events.push(event),new AbortController().signal);expect(events.some(e=>e.type==='text_delta'&&e.text==='configured route replied')).toBe(true);
 expect(events.at(-1).type).toBe('done');
 }finally{await harness.close();vi.unstubAllGlobals();await fs.rm(root,{recursive:true,force:true});}
});
it('requires login and same public origin, and takes identity only from authentication',async()=>{
 const {default:Fastify}=await import('fastify');const {default:ModelSettings}=await import('@localapp/dsh-model-settings');
 const {directory,store}=await fixture(),root=new Context(),app=Fastify();
 try{
 await root.plugin(ModelSettings);
 await root.localappModelSettings.registerHttp(app,{store,publicUrl:'https://models.example:60004',userId:req=>String(req.headers['x-test-user']),isAuthenticated:()=>true,
 authenticate:async scope=>{scope.addHook('onRequest',async(req,reply)=>{if(!req.headers['x-test-user'])return reply.code(401).send();});},
 create:async()=>({ctx:new Context(),transport:{http:async(user,_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({user}));return true;},upgrade:async()=>false}}),
 assets:{renderIndex:async html=>html,resource:async()=>false,entry:async()=>null}});
 const endpoint='/api/model-settings/native/api/settings/describe';
 expect((await app.inject({method:'POST',url:endpoint})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:endpoint,headers:{'x-test-user':'alice',host:'models.example:60004',origin:'https://attacker.example'}})).statusCode).toBe(403);
 const response=await app.inject({method:'POST',url:endpoint+'?userId=bob',headers:{'x-test-user':'alice',host:'models.example:60004',origin:'https://models.example:60004'}});
 expect(response.statusCode).toBe(200);expect(response.json()).toEqual({user:'alice'});
 }finally{await app.close();await root.fiber.dispose();await fs.rm(directory,{recursive:true,force:true});}
});
