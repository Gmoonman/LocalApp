import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {afterEach,expect,it} from 'vitest';
import {DevelopmentPreviews,type Preview} from '@localapp/dsh-app-development/previews';
const root=path.resolve(__dirname,'../../../../../../tmp/platform-development/preview-port-tests');
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
it('keeps previews separate on one host and blocks platform and other-preview access',async()=>{
 fs.mkdirSync(path.join(root,'development'),{recursive:true});
 fs.writeFileSync(path.join(root,'development/settings.json'),JSON.stringify({previewOrigin:'https://apps.example.com:60014'}));
 const app=Fastify();
 const store=new DevelopmentPreviews(root,{} as any,{} as any,{
  cookie:(req,p)=>req.headers[`x-preview-${p.id}`] as string|undefined,
  setCookie:()=>{},authorize:()=>{},
 });
 const make=(id:string,token:string):Preview=>({id,owner:'preview'+id,app:'test',dataDir:root,expires:Date.now()+60000,origin:'https://apps.example.com:60014',ticketExpires:Date.now()+60000,cookieHash:digest(token)});
 const a=make('a'.repeat(32),'token-a'),b=make('b'.repeat(32),'token-b');
 (store as any).previews.set(a.id,a);(store as any).previews.set(b.id,b);
 store.attach(app);app.get('/:owner/test/',async req=>({owner:(req.params as any).owner}));
 const headers={host:'apps.example.com:60014',[`x-preview-${a.id}`]:'token-a',[`x-preview-${b.id}`]:'token-b'};
 try{
  expect((await app.inject({url:`/${a.owner}/test/`,headers})).json().owner).toBe(a.owner);
  expect((await app.inject({url:`/${b.owner}/test/`,headers})).json().owner).toBe(b.owner);
  expect((await app.inject({url:'/api/me',headers:{...headers,referer:`${a.origin}/${a.owner}/test/`}})).json().data.id).toBe(a.owner);
  expect((await app.inject({url:'/api/me',headers})).statusCode).toBe(404);
  expect((await app.inject({url:`/${b.owner}/test/`,headers:{host:headers.host,[`x-preview-${a.id}`]:'token-a'}})).statusCode).toBe(401);
  expect((await app.inject({url:'/api/admin/users',headers:{host:headers.host,[`x-preview-${a.id}`]:'token-a'}})).statusCode).toBe(403);
  expect((await app.inject({url:`/${a.owner}/test/`,headers:{...headers,origin:'https://foreign.invalid'}})).statusCode).toBe(403);
  expect((await app.inject({url:'/',headers:{host:headers.host}})).statusCode).toBe(404);
  a.ticketHash=digest('open-once');
  const open=`/__development/open?previewId=${a.id}&ticket=open-once`;
  expect((await app.inject({url:open,headers:{host:headers.host}})).statusCode).toBe(302);
  expect((await app.inject({url:open,headers:{host:headers.host}})).statusCode).toBe(401);
  b.expires=Date.now()-1;
  expect((await app.inject({url:`/${b.owner}/test/`,headers})).statusCode).toBe(410);
 }finally{await app.close();}
});
it('allows only the project owner to switch the same preview back and forth',()=>{
 const project={id:'project',ownerId:'owner',name:'test'};
 const store=new DevelopmentPreviews(root,{get:(_id:string,user:string)=>{if(user!=='owner')throw Error('Forbidden');return project;}} as any,{} as any,{cookie:()=>undefined,setCookie:()=>{},authorize:()=>{}});
 const id='c'.repeat(32);
 const preview:Preview={id,projectId:project.id,productionOwner:'owner',dataMode:'test',owner:'preview'+id,app:'test',dataDir:root,expires:Date.now()+60000,origin:'https://apps.example.com:60014',ticketExpires:0};
 (store as any).previews.set(id,preview);
 expect(()=>store.setDataMode(undefined,'other',id,'production')).toThrow('Forbidden');
 expect(()=>store.setDataMode(undefined,'owner',id,'production')).toThrow('尚未上线');
 fs.mkdirSync(path.join(root,'owner/test'),{recursive:true});
 fs.writeFileSync(path.join(root,'owner/test/meta.json'),JSON.stringify({versions:[]}));
 expect(store.setDataMode(undefined,'owner',id,'production').id).toBe(id);
 expect(preview.dataMode).toBe('production');
 expect(store.setDataMode(undefined,'owner',id,'test','production').writeSource).toBe('production');
 expect(preview.readSource).toBe('test');
 expect(store.setDataMode(undefined,'owner',id,'test').id).toBe(id);
 expect(preview.dataMode).toBe('test');
});
it('locks automated verification previews to test reads and writes',()=>{
 const project={id:'project',ownerId:'owner',name:'test'};
 const store=new DevelopmentPreviews(root,{get:()=>project} as any,{} as any,{cookie:()=>undefined,setCookie:()=>{},authorize:()=>{}});
 fs.mkdirSync(path.join(root,'owner/test'),{recursive:true});fs.writeFileSync(path.join(root,'owner/test/meta.json'),JSON.stringify({versions:[]}));
 const id='f'.repeat(32),preview:Preview={id,verification:true,projectId:'project',productionOwner:'owner',dataMode:'test',owner:'preview'+id,app:'test',dataDir:root,expires:Date.now()+60000,origin:'https://apps.example.com:60014',ticketExpires:0};
 (store as any).previews.set(id,preview);
 expect(()=>store.setDataMode('project','owner',id,'production')).toThrow('只能使用测试');
 expect(()=>store.setDataMode('project','owner',id,'test','production')).toThrow('只能使用测试');
 expect(store.setDataMode('project','owner',id,'test','test')).toMatchObject({readSource:'test',writeSource:'test'});
});
