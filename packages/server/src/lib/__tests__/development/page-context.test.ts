import {expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
const {DevelopmentPageContext}=createRequire(__filename)('../../../../../dsh-app-development/dist/page-context.cjs');
it('isolates page reads by user/project and by the browser that claimed the request',async()=>{
 const broker=new DevelopmentPageContext();
 const read=broker.request('alice/project');
 expect(broker.poll('bob/project','client')).toEqual([]);
 const [request]=broker.poll('alice/project','client');
 expect(broker.poll('alice/project','other-client')).toEqual([]);
 expect(()=>broker.complete('bob/project','client',request.id,{})).toThrow();
 expect(()=>broker.complete('alice/project','other-client',request.id,{})).toThrow();
 broker.complete('alice/project','client',request.id,{text:'Current page'});
 await expect(read).resolves.toEqual({text:'Current page'});broker.close();
});
it('reports disconnected pages and releases pending reads on shutdown',async()=>{
 vi.useFakeTimers();try{
 const broker=new DevelopmentPageContext();const read=broker.request('scope');
 await vi.advanceTimersByTimeAsync(15000);await expect(read).resolves.toMatchObject({error:expect.stringContaining('未连接')});
 const next=broker.request('scope');broker.close();await expect(next).resolves.toMatchObject({error:expect.stringContaining('关闭')});
 }finally{vi.useRealTimers();}
});
it('returns the page from the submitting tab even when another tab polls first',async()=>{
 const broker=new DevelopmentPageContext();broker.activate('alice/project','submitting-tab');
 const read=broker.request('alice/project');expect(broker.poll('alice/project','old-tab')).toEqual([]);
 const [request]=broker.poll('alice/project','submitting-tab');
 broker.complete('alice/project','submitting-tab',request.id,{mark:{kind:'region',bounds:{width:305,height:53}}});
 await expect(read).resolves.toMatchObject({mark:{kind:'region'}});
 broker.activate('alice/project','other-tab');const next=broker.request('alice/project');
 expect(broker.poll('alice/project','submitting-tab')).toEqual([]);
 const [second]=broker.poll('alice/project','other-tab');broker.complete('alice/project','other-tab',second.id,{title:'Other page'});
 await expect(next).resolves.toMatchObject({title:'Other page'});broker.close();
});
