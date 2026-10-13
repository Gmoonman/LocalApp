import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import {afterEach,expect,it} from 'vitest';
import {registerOwnApplicationPages} from '@localapp/dsh-app-platform/own-pages-routes';
const root=path.resolve(__dirname,'../../../../../tmp/application-market-tests');
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
it('lists and searches online applications without exposing private or offline apps',async()=>{
 const create=(name:string,level:string,lifecycle='online',description='文档工具')=>{
  fs.mkdirSync(path.join(root,'owner',name),{recursive:true});
  fs.writeFileSync(path.join(root,'owner',name,'meta.json'),JSON.stringify({userId:'owner',name,currentVersion:1,description,createdAt:'2026-10-11',updatedAt:'2026-10-11',versions:[],pageAccess:{level,acl:['allowed']},lifecycle:{status:lifecycle}}));
 };
 create('public','public');create('private','owner');create('members','authenticated');create('listed','acl');create('offline','public','offline');
 const app=Fastify();await registerOwnApplicationPages(app,{dataDir:root,visitorId:req=>req.headers['x-user'] as string,deleteAppObjects:async()=>{}});
 try{
  const query=async(url:string,user?:string)=>(await app.inject({url,headers:user?{'x-user':user}:{}})).json().data;
  expect((await query('/api/market/apps')).apps.map((a:any)=>a.name)).toEqual(['public']);
  expect((await query('/api/market/apps','allowed')).apps.map((a:any)=>a.name)).toEqual(['listed','members','public']);
  const own=await query('/api/market/apps?limit=2','owner');expect(own.total).toBe(4);expect(own.apps).toHaveLength(2);
  expect((await query('/api/market/apps?q=PRIVATE','owner')).apps.map((a:any)=>a.name)).toEqual(['private']);
  expect((await query('/api/market/apps?q=文档')).total).toBe(1);
  expect((await query('/api/market/apps?q=missing')).total).toBe(0);
  expect((await app.inject({url:'/api/market/apps'})).headers['cache-control']).toBe('private, no-store');
 }finally{await app.close();}
});
