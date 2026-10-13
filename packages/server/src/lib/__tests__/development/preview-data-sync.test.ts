import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import {afterEach,expect,it} from 'vitest';
import {DevelopmentPreviews,type Preview} from '@localapp/dsh-app-development/previews';
import {initContentStorage,putObject,getObject} from '@localapp/dsh-app-platform/content-storage';
import {closeAllConnections} from '@localapp/dsh-app-platform/app-db';
import {listAppBackups} from '@localapp/dsh-app-platform/app-data-service';
const root=path.resolve(__dirname,'../../../../../../tmp/platform-development/preview-sync-tests');
afterEach(()=>{closeAllConnections();fs.rmSync(root,{recursive:true,force:true});});
it('refreshes test database and files from production without modifying production',async()=>{
 const id='d'.repeat(32),owner='preview'+id,testRoot=path.join(root,'preview-data');
 const production=path.join(root,'owner','demo'),test=path.join(testRoot,owner,'demo');
 const SQL=await initSqlJs();
 for(const [directory,value] of [[production,'production'],[test,'test']] as const){
  fs.mkdirSync(path.join(directory,'migrations'),{recursive:true});
  fs.writeFileSync(path.join(directory,'meta.json'),JSON.stringify({name:'demo',currentVersion:0,versions:[]}));
  fs.writeFileSync(path.join(directory,'migrations/001_init.sql'),'CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL, created_by TEXT NOT NULL); CREATE TABLE attachments (id INTEGER PRIMARY KEY, record_id INTEGER REFERENCES records(id));');
  const db=new SQL.Database();db.run('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL, created_by TEXT NOT NULL)');db.run('INSERT INTO records VALUES (1, ?, ?)',[value,'real-user']);db.run('CREATE TABLE attachments (id INTEGER PRIMARY KEY, record_id INTEGER REFERENCES records(id))');if(value==='production')db.run('INSERT INTO attachments VALUES (1,999)');fs.writeFileSync(path.join(directory,'app.db'),db.export());db.close();
 }
 for(const directory of [production,test]){
  const resource=path.join(directory,'versions/v0/backend/resources/records');fs.mkdirSync(resource,{recursive:true});
  fs.writeFileSync(path.join(resource,'schema.json'),JSON.stringify({name:'records'}));
  fs.writeFileSync(path.join(resource,'queries.json'),JSON.stringify({queries:{list:{sql:'SELECT * FROM records WHERE created_by=:currentUserId',security:{mode:'custom',systemParams:['currentUserId']}}}}));
 }
 await initContentStorage({dataDir:root,minioEndpoint:'127.0.0.1:1',minioAccessKey:'test',minioSecretKey:'test',minioBucket:'test'});
 await putObject(`owner/demo/0123456789abcdef0123.png`,Buffer.from('production-file'),'image/png');
 const project={id:'project',ownerId:'owner',name:'demo'};
 const store=new DevelopmentPreviews(root,{get:(_id:string,user:string)=>{if(user!=='owner')throw Error('Forbidden');return project;}} as any,{} as any,{cookie:()=>undefined,setCookie:()=>{},authorize:()=>{}});
 const preview:Preview={id,projectId:'project',productionOwner:'owner',owner,app:'demo',dataDir:testRoot,expires:Date.now()+60000,origin:'https://preview.example',ticketExpires:0};
 (store as any).previews.set(id,preview);
 await expect(store.syncData('other',id,'production-to-test')).rejects.toThrow('Forbidden');
 await expect(store.syncData('owner',id,'test-to-production')).rejects.toThrow('仅支持');
 const result=await store.syncData('owner',id,'production-to-test');
 expect(result.warning).toContain("1 条外键关联异常");
 expect(result.safetyBackupId).toBeTruthy();expect(listAppBackups(test)).toHaveLength(1);expect(listAppBackups(production)).toHaveLength(0);
 const read=(dir:string)=>{const db=new SQL.Database(fs.readFileSync(path.join(dir,'app.db')));try{return db.exec('SELECT value FROM records')[0].values[0][0];}finally{db.close();}};
 expect(read(test)).toBe('production');expect(read(production)).toBe('production');
 const copied=new SQL.Database(fs.readFileSync(path.join(test,'app.db')));expect(copied.exec('SELECT created_by FROM records')[0].values[0][0]).toBe('real-user');expect(copied.exec('PRAGMA foreign_key_check')[0].values).toHaveLength(1);copied.close();
 expect((await getObject(`${owner}/demo/0123456789abcdef0123.png`))?.body.toString()).toBe('production-file');
 const invalid=new SQL.Database();invalid.run('CREATE TABLE incompatible(id INTEGER PRIMARY KEY)');fs.writeFileSync(path.join(production,'app.db'),invalid.export());invalid.close();
 const before=fs.readFileSync(path.join(production,'app.db'));
 await expect(store.syncData('owner',id,'production-to-test')).rejects.toThrow();
 expect(read(test)).toBe('production');expect(listAppBackups(test)).toHaveLength(1);
 expect(fs.readFileSync(path.join(production,'app.db'))).toEqual(before);
});
