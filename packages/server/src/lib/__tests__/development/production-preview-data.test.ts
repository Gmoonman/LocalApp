import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import {afterEach,expect,it} from 'vitest';
import {getConnection,getDbPath,execRawSql,closeAllConnections} from '@localapp/dsh-app-platform/app-db';
import {handleApplicationData} from '@localapp/dsh-app-platform/data-handler';
const root=path.resolve(__dirname,'../../../../../../tmp/platform-development/production-read-tests');
afterEach(()=>{closeAllConnections();fs.rmSync(root,{recursive:true,force:true});});
it('reads current production snapshots, rejects mutations and preserves writable test data',async()=>{
 const page=path.join(root,'preview','demo'),prod=getDbPath(path.join(root,'owner','demo'));
 fs.mkdirSync(page,{recursive:true});
 const resources=path.join(page,'backend/resources/items');fs.mkdirSync(resources,{recursive:true});
 fs.writeFileSync(path.join(resources,'schema.json'),JSON.stringify({$schema:'https://localapp.dev/schemas/backend/resource-schema.schema.json',name:'items',fields:{title:{type:'string'}}}));
 fs.writeFileSync(path.join(resources,'queries.json'),JSON.stringify({$schema:'https://localapp.dev/schemas/backend/queries.schema.json',queries:{list:{kind:'query',sql:'SELECT title, :currentUserId AS viewer FROM items ORDER BY id',access:'public'}}}));
 fs.writeFileSync(path.join(resources,'mutations.json'),JSON.stringify({$schema:'https://localapp.dev/schemas/backend/mutations.schema.json',mutations:{add:{kind:'mutation',sql:'INSERT INTO items(title) VALUES (:title)',params:{title:{type:'string',required:true}},access:'public'}}}));
 for(const db of [prod,getDbPath(page)]){await getConnection(db);execRawSql(db,'CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT)');}
 execRawSql(prod,"INSERT INTO items(title) VALUES ('production')");execRawSql(getDbPath(page),"INSERT INTO items(title) VALUES ('test')");
 const app=Fastify();
 app.post('/:mode/:kind/:name',async(req,reply)=>{
  const p=req.params as any;
  return handleApplicationData(req,reply,root,'preview','demo',`api/${p.kind}/${p.name}`,{visitor:{id:'preview',name:'preview'},...(p.mode==='production'?{readOnlyProduction:{databasePath:prod,ownerId:'owner'}}:p.mode.startsWith('rw-')?{previewData:{databasePath:prod,ownerId:'owner',readSource:p.mode==='rw-test-read'?'test':'production',writeSource:p.mode==='rw-test-write'?'test':'production'}}:{})});
 });
 const query=async(mode:string)=>(await app.inject({method:'POST',url:`/${mode}/queries/list`,payload:{}})).json();
 try{
  const first=JSON.stringify(await query('production'));
  expect(first).toContain('production');expect(first).toContain('owner');
  const before=(await getConnection(prod)).export();
  expect((await app.inject({method:'POST',url:'/production/mutations/add',payload:{params:{title:'forbidden'}}})).statusCode).toBe(403);
  expect(Buffer.from((await getConnection(prod)).export())).toEqual(Buffer.from(before));
  expect((await app.inject({method:'POST',url:'/test/mutations/add',payload:{params:{title:'test-write'}}})).statusCode).toBe(200);
  expect(JSON.stringify(await query('test'))).toContain('test-write');
  expect(JSON.stringify(await query('production'))).not.toContain('test-write');
  expect((await app.inject({method:'POST',url:'/rw-test-read/mutations/add',payload:{params:{title:'production-write'}}})).statusCode).toBe(200);
  expect(JSON.stringify(await query('production'))).toContain('production-write');
  expect(JSON.stringify(await query('rw-test-read'))).not.toContain('production-write');
  expect((await app.inject({method:'POST',url:'/rw-test-write/mutations/add',payload:{params:{title:'isolated-write'}}})).statusCode).toBe(200);
  expect(JSON.stringify(await query('test'))).toContain('isolated-write');
  expect(JSON.stringify(await query('rw-test-write'))).not.toContain('isolated-write');
  execRawSql(prod,"INSERT INTO items(title) VALUES ('new-production')");
  expect(JSON.stringify(await query('production'))).toContain('new-production');
  expect(fs.readdirSync(page).some(n=>n.startsWith('.production-read-'))).toBe(false);
 }finally{await app.close();}
});
