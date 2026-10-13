import {it,expect,afterEach} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
const {VerificationStore,validateVerificationSteps}=createRequire(__filename)('../../../../../dsh-app-development/dist/verification.cjs');
const root=path.resolve(__dirname,'../../../../../../tmp/platform-development/verification-tests');
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
it('rejects arbitrary browser scripts, excessive steps and checks without expectations',()=>{
 expect(()=>validateVerificationSteps([{action:'evaluate',selector:'h1',code:'fetch(secret)'}])).toThrow();
 expect(()=>validateVerificationSteps(Array.from({length:21},()=>({action:'click',selector:'button'})))).toThrow();
 expect(()=>validateVerificationSteps([{action:'scroll',selector:'.items',y:Infinity}])).toThrow();
 expect(()=>validateVerificationSteps([{action:'assert',selector:'h1'}])).toThrow();
 expect(validateVerificationSteps([{action:'assert',selector:'h1',visible:true}])).toEqual([{action:'assert',selector:'h1',visible:true}]);
});
it('binds results and screenshots to the project owner and caps retained runs',()=>{
 const store=new VerificationStore({directory:root,get:(id:string,user:string)=>{if(id!=='project'||user!=='owner')throw Error('Forbidden');return {id};}});
 const record=store.save('project','owner',{id:'build',sourceVersion:'source'},[],{status:'observed',image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvGQAAAAASUVORK5CYII='});
 expect(record).toMatchObject({buildId:'build',sourceVersion:'source',status:'observed',screenshot:true});
 expect(record.result).not.toHaveProperty('image');expect(store.screenshot('project','owner',record.id).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
 expect(()=>store.list('project','other')).toThrow('Forbidden');expect(()=>store.screenshot('project','other',record.id)).toThrow('Forbidden');expect(()=>store.screenshot('project','owner','../../secret')).toThrow();
 for(let i=0;i<21;i++)store.save('project','owner',{id:'build',sourceVersion:'source'},[],{error:'not connected'});
 expect(store.list('project','owner')).toHaveLength(20);
});
it('persists active runs and turns interrupted runs into explicit failures after restart',()=>{
 const project={directory:root,get:()=>({id:'project'})};
 const store=new VerificationStore(project),run=store.begin('project','owner',{id:'build',sourceVersion:'source'},[]);
 expect(store.list('project','owner')[0].status).toBe('running');
 const restarted=new VerificationStore(project);expect(restarted.list('project','owner')[0]).toMatchObject({id:run.id,status:'failed',result:{error:expect.stringContaining('重启')}});
});
