import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
export interface LegacyProvider {id:string;name:string;protocol:string;baseUrl:string;model:string;apiKey:string;dshRoute?:string;dshProfile?:Record<string,any>}
export interface ModelDocument {revision:number;providers:Record<string,Record<string,any>>;credentials:Record<string,string>;defaultProviderId:string;catalog?:Record<string,Array<{id:string;name?:string;inputModalities?:readonly string[]}>>}
/** User-scoped encrypted persistence; dsh owns provider schema and editing. */
export class UserModelStore {
 private key:Buffer;
 private directory:string;
 constructor(dataDir:string,private seed:(user:string)=>{providers:LegacyProvider[];defaultProviderId:string}){
  this.directory=path.join(dataDir,'model-settings');fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
  const file=path.join(this.directory,'.key');try{fs.writeFileSync(file,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}this.key=fs.readFileSync(file);
 }
 private file(user:string){if(!user)throw new Error('Missing authenticated user');return path.join(this.directory,createHash('sha256').update(user).digest('hex')+'.json');}
 read(user:string):ModelDocument{
  const file=this.file(user);if(!fs.existsSync(file)){
   const legacy=this.seed(user),value:ModelDocument={revision:0,providers:{},credentials:{},defaultProviderId:legacy.defaultProviderId};
   for(const p of legacy.providers){const ref=this.keyRef(p.id);value.providers[p.id]={displayName:p.name,api:p.protocol,baseURL:p.baseUrl,apiKeyEnv:ref,models:[{id:p.model}]};if(p.apiKey)value.credentials[ref]=p.apiKey;}
   this.save(user,value);return value;
  }
  const [iv,tag,data]=fs.readFileSync(file,'utf8').split('.').map(x=>Buffer.from(x,'base64'));const decipher=createDecipheriv('aes-256-gcm',this.key,iv);decipher.setAAD(Buffer.from(user));decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(data),decipher.final()]).toString());
 }
 save(user:string,value:ModelDocument){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(user));const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);const file=this.file(user),temporary=file+'.new';fs.writeFileSync(temporary,[iv,cipher.getAuthTag(),bytes].map(x=>x.toString('base64')).join('.'),{mode:0o600});fs.renameSync(temporary,file);}
 keyRef(id:string){return 'LOCALAPP_'+createHash('sha256').update(id).digest('hex').slice(0,16).toUpperCase()+'_API_KEY';}
 providers(user:string):LegacyProvider[]{
  const doc=this.read(user);
  return Object.entries(doc.providers).flatMap(([route,p])=>{
   const models=p.models??doc.catalog?.[route]??[];
   return models.map((model:any,index:number)=>({id:index===0?route:route.slice(0,40)+'-'+createHash('sha256').update(model.id).digest('hex').slice(0,16),name:p.displayName||route,protocol:p.api||'openai-completions',baseUrl:p.baseURL||'',model:model.id,apiKey:doc.credentials[p.apiKeyEnv]||'',dshRoute:route,dshProfile:p}));
  });
 }
 updateLegacy(user:string,providers:LegacyProvider[],defaultProviderId:string){
  const doc=this.read(user),current=this.providers(user);
  const next:ModelDocument={...doc,providers:{},defaultProviderId};
  const keys=new Map<string,string>();
  for(const p of providers){
   const before=current.find(c=>c.id===p.id),route=before?.dshRoute??p.id;
   const old=doc.providers[route],ref=old?.apiKeyEnv||this.keyRef(route);
   const profile=next.providers[route]??structuredClone(old??{apiKeyEnv:ref});
   if(!before || p.name!==before.name)profile.displayName=p.name;
   if(!before || p.protocol!==before.protocol)profile.api=p.protocol;
   if(!before || p.baseUrl!==before.baseUrl)profile.baseURL=p.baseUrl;
   if(!before || p.model!==before.model)profile.models=profile.models?.map((m:any)=>m.id===before?.model?{...m,id:p.model}:m)??[{id:p.model}];
   next.providers[route]=profile;
   if(p.apiKey!==before?.apiKey){const previous=keys.get(ref);if(previous!==undefined&&previous!==p.apiKey)throw new Error('Conflicting credentials for the same provider');keys.set(ref,p.apiKey);}
  }
  for(const [ref,value] of keys)next.credentials[ref]=value;
  if(JSON.stringify(doc.providers)===JSON.stringify(next.providers)&&doc.defaultProviderId===defaultProviderId&&keys.size===0)return;
  next.revision++;this.save(user,next);
 }
}
