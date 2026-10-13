import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {DevelopmentError, type ProjectStore} from "./projects.cjs";
export interface VerificationStep {action:"scroll"|"click"|"assert";selector:string;y?:number;x?:number;text?:string;visible?:boolean;position?:string;minY?:number;maxY?:number}
export function validateVerificationSteps(value:unknown):VerificationStep[] {
 if(!Array.isArray(value)||value.length>20)throw new DevelopmentError("验收步骤最多 20 项");
 return value.map(step=>{
  if(!step||!["scroll","click","assert"].includes(step.action)||typeof step.selector!=="string"||!step.selector.trim()||step.selector.length>240)throw new DevelopmentError("验收步骤无效");
  for(const key of ["x","y","minY","maxY"])if(step[key]!==undefined&&(!Number.isFinite(step[key])||Math.abs(step[key])>10000))throw new DevelopmentError("滚动距离无效");
  if(step.text!==undefined&&(typeof step.text!=="string"||step.text.length>500))throw new DevelopmentError("验收文字过长");
  if(step.visible!==undefined&&typeof step.visible!=="boolean")throw new DevelopmentError("可见性检查无效");
  if(step.position!==undefined&&!['static','relative','absolute','fixed','sticky'].includes(step.position))throw new DevelopmentError("定位检查无效");
  if(step.action==='assert'&&step.visible===undefined&&step.text===undefined&&step.position===undefined&&step.minY===undefined&&step.maxY===undefined)throw new DevelopmentError("检查步骤必须包含预期结果");
  return {action:step.action,selector:step.selector,...Object.fromEntries(['x','y','text','visible','position','minY','maxY'].filter(key=>step[key]!==undefined).map(key=>[key,step[key]]))} as VerificationStep;
 });
}
export class VerificationStore {
 private active=new Set<string>();
 constructor(private projects:ProjectStore){}
 begin(id:string,user:string,build:{id:string;sourceVersion:string},steps:VerificationStep[],status="running"){
  const directory=this.directory(id,user);fs.mkdirSync(directory,{recursive:true,mode:0o700});const record={id:randomUUID(),buildId:build.id,sourceVersion:build.sourceVersion,createdAt:new Date().toISOString(),steps,status,result:{},screenshot:false};
  this.active.add(record.id);fs.writeFileSync(path.join(directory,record.id+".json"),JSON.stringify(record),{mode:0o600});return record;
 }
 private directory(id:string,user:string){this.projects.get(id,user);return path.join(this.projects.directory,id,"verification");}
 save(id:string,user:string,build:{id:string;sourceVersion:string},steps:VerificationStep[],result:any,existingId?:string){
  const directory=this.directory(id,user);fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const runId=existingId??randomUUID();
  if(!/^[a-f0-9-]{36}$/.test(runId))throw new DevelopmentError("验收标识无效");
  this.active.delete(runId);
  const image=result?.image;let screenshot=false;
  const bytes=typeof image==='string'?Buffer.from(image.split(',')[1]??'','base64'):Buffer.alloc(0);
  if(typeof image==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)&&image.length<=8*1024*1024&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){fs.writeFileSync(path.join(directory,runId+'.png'),Buffer.from(image.split(',')[1],'base64'),{mode:0o600});screenshot=true;}
  const {image:_,...data}=result??{error:'验收没有返回结果'};
  if(Buffer.byteLength(JSON.stringify(data))>220*1024)throw new DevelopmentError('验收记录过大');
  const record={id:runId,buildId:build.id,sourceVersion:build.sourceVersion,createdAt:new Date().toISOString(),steps,status:data.error||data.status==='failed'?'failed':data.status==='passed'&&steps.some(step=>step.action==='assert')&&Array.isArray(data.results)&&data.results.length===steps.length&&data.results.every((step:any)=>step.status==='passed')?'passed':'observed',result:data,screenshot};
  fs.writeFileSync(path.join(directory,runId+'.json'),JSON.stringify(record),{mode:0o600});
  const rows=this.list(id,user);for(const old of rows.slice(20)){for(const extension of ['.json','.png'])fs.rmSync(path.join(directory,old.id+extension),{force:true});}
  return record;
 }
 list(id:string,user:string){const directory=this.directory(id,user);if(!fs.existsSync(directory))return [];return fs.readdirSync(directory).filter(name=>/^[a-f0-9-]+\.json$/.test(name)).map(name=>(()=>{const file=path.join(directory,name),record=JSON.parse(fs.readFileSync(file,'utf8'));if(['running','queued'].includes(record.status)&&!this.active.has(record.id)){record.status='failed';record.result={error:'Server 重启，验收已中断，请重新执行'};fs.writeFileSync(file,JSON.stringify(record),{mode:0o600});}return record;})()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 screenshot(id:string,user:string,run:string){if(!/^[a-f0-9-]{36}$/.test(run))throw new DevelopmentError('验收不存在',404);const file=path.join(this.directory(id,user),run+'.png');if(!fs.existsSync(file))throw new DevelopmentError('截图不存在',404);return fs.readFileSync(file);}
}
