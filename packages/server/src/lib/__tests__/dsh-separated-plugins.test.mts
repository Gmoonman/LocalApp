import {Context} from '@deepseek-ai/cordis';
import {expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import AgentRuntime from '@localapp/dsh-agent-runtime';
import Environment from '@localapp/dsh-execution-environment';
import Settings from '@localapp/dsh-agent-settings';
import Sync from '@localapp/dsh-app-sync';
import Collaboration from '@localapp/dsh-collaboration';
import Devices from '@localapp/dsh-device-services';

it('runs without the account or application plugin and separates user, app and role',async()=>{
 const ctx=new Context();await ctx.plugin(AgentRuntime,{capacity:4});
 const a={userId:'a',applicationId:'app',role:'user' as const,providerId:'p'};
 const create=()=>Promise.resolve({close:vi.fn(async()=>{})});
 try{
  const first=await ctx.localappAgentRuntime.acquire(a,'1',create);
  const developer=await ctx.localappAgentRuntime.acquire({...a,role:'developer'},'1',create);
  const other=await ctx.localappAgentRuntime.acquire({...a,userId:'b'},'1',create);
  expect(ctx.get('localappMultiuser')).toBeUndefined();
  expect(developer).not.toBe(first);expect(other).not.toBe(first);
  await ctx.localappAgentRuntime.invalidate('a','app');
  expect(first.close).toHaveBeenCalledOnce();expect(developer.close).toHaveBeenCalledOnce();
  expect(other.close).not.toHaveBeenCalled();
 }finally{await ctx.fiber.dispose();}
});
it('stops environment routes without closing the independent agent runtime',async()=>{
 const ctx=new Context();await ctx.plugin(AgentRuntime);
 const scope=ctx.isolate('localappExecutionEnvironment');
 const fiber=scope.plugin(Environment,{documents:false});await fiber;
 const app=Fastify();
 await scope.localappExecutionEnvironment.registerEnvironment(app,{dataDir:'unused',checkEnvironment:async()=>({checkedAt:'now',platform:'test',ready:true,checks:[]})});
 try{
  expect((await app.inject('/api/system/agent-environment')).statusCode).toBe(200);
  expect(ctx.get('localappDocuments')).toBeUndefined();
  await fiber.dispose();
  expect((await app.inject('/api/system/agent-environment')).statusCode).toBe(503);
  await expect(ctx.localappAgentRuntime.acquire({userId:'a',applicationId:'app',role:'user',providerId:'p'},'1',async()=>({close:async()=>{}}))).resolves.toBeDefined();
 }finally{await app.close();await ctx.fiber.dispose();}
});
it('loads sync, collaboration, device and settings contributions without application registration',async()=>{
 const ctx=new Context();
 try{
  await ctx.plugin(Settings);await ctx.plugin(Sync);await ctx.plugin(Collaboration);await ctx.plugin(Devices);
  expect(ctx.get('localappApps')).toBeUndefined();
  expect(ctx.localappAppSync).toBeDefined();expect(ctx.localappDeviceServices).toBeDefined();
  const events=ctx.localappCollaboration.createCollaboration({visitor:()=>({id:'a',name:'A'}),user:()=>null,verification:()=>null});
  await ctx.fiber.dispose();
  expect(()=>ctx.localappCollaboration.createCollaboration(undefined as never)).toThrow();
  await events.dispose();
 }finally{await ctx.fiber.dispose();}
});
