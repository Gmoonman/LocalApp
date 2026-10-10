import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export type PythonEnvironment = { executable: string; directory: string; baseDirectory: string; version: string; revision: string; managed: boolean };
const busy = new Set<string>();
const configPath = (dataDir: string) => path.join(dataDir, "python-environment.json");
export function readPythonEnvironment(dataDir: string): PythonEnvironment | undefined {
 try { const value = JSON.parse(fs.readFileSync(configPath(dataDir), "utf8"));
  if (typeof value.executable !== "string" || !path.isAbsolute(value.executable) || typeof value.directory !== "string" || !path.isAbsolute(value.directory) || typeof value.baseDirectory !== "string" || !path.isAbsolute(value.baseDirectory) || typeof value.revision !== "string") throw new Error("Invalid Python environment config");
  return value;
 } catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function environment(dataDir: string) {
 const temp = path.join(dataDir, "python-environments", ".tmp"); fs.mkdirSync(temp, {recursive:true,mode:0o700});
 return { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot}:{}), TMPDIR:temp, TEMP:temp, TMP:temp, PYTHONNOUSERSITE:"1", PYTHONDONTWRITEBYTECODE:"1", PIP_CONFIG_FILE: process.platform === "win32" ? "nul" : "/dev/null", PIP_DISABLE_PIP_VERSION_CHECK:"1" };
}
async function inspect(dataDir:string,executable:string) {
 if(typeof executable !== "string" || !path.isAbsolute(executable) || executable.includes("\0"))throw new Error("请填写 Python 解释器的绝对路径");
 const {stdout}=await execute(executable,["-I","-c","import sys,json; print(json.dumps({'version':list(sys.version_info[:3]),'prefix':sys.prefix,'base':sys.base_prefix}))"],{timeout:15_000,maxBuffer:32_768,env:environment(dataDir)});
 const value=JSON.parse(stdout);
 if(!Array.isArray(value.version) || value.version[0] !== 3 || value.version[1] < 10)throw new Error("需要 Python 3.10 或更高的 Python 3 版本");
 return value as {version:number[];prefix:string;base:string};
}
function validateDirectory(directory:string,dataDir:string,managed:boolean) {
 const resolved=fs.realpathSync(directory), data=fs.realpathSync(dataDir);
 if(resolved===path.parse(resolved).root || resolved===os.homedir() || data===resolved || data.startsWith(resolved+path.sep))throw new Error("不能把系统、用户或 Server 数据根目录作为 Python 环境");
 if(resolved.startsWith(data+path.sep) && !(managed && resolved.startsWith(path.join(data,"python-environments")+path.sep)))throw new Error("Python 环境不能位于应用或其他 Server 数据目录中");
 return resolved;
}
async function descriptor(dataDir:string,executable:string,managed:boolean):Promise<PythonEnvironment> {
 const value=await inspect(dataDir,executable);
 if(value.prefix===value.base)throw new Error("请选择虚拟环境中的 Python；或使用此解释器创建专用虚拟环境");
 const directory=validateDirectory(value.prefix,dataDir,managed);
 if(!fs.existsSync(path.join(directory,"pyvenv.cfg")))throw new Error("未找到虚拟环境的 pyvenv.cfg");
 const executableDirectory=fs.realpathSync(path.dirname(executable));
 if(executableDirectory !== path.join(directory,process.platform === "win32" ? "Scripts" : "bin"))throw new Error("解释器必须位于所选虚拟环境的 bin 或 Scripts 目录中");
 const baseDirectory=fs.realpathSync(value.base);
 if(baseDirectory===path.parse(baseDirectory).root || baseDirectory===os.homedir() || baseDirectory===fs.realpathSync(dataDir) || fs.realpathSync(dataDir).startsWith(baseDirectory+path.sep))throw new Error("Python 基础安装目录范围过大");
 return {executable:path.resolve(executable),directory,baseDirectory,version:value.version.join("."),revision:randomUUID(),managed};
}
function save(dataDir:string,value:PythonEnvironment) {
 const temporary=configPath(dataDir)+"."+randomUUID();
 fs.writeFileSync(temporary,JSON.stringify(value,null,2)+"\n",{mode:0o600});fs.renameSync(temporary,configPath(dataDir));
}
async function mutate<T>(dataDir:string,action:()=>Promise<T>) {
 if(busy.has(dataDir))throw new Error("Python 环境正在更新，请稍后重试");busy.add(dataDir);
 try{return await action();}finally{busy.delete(dataDir);}
}
export async function selectPythonEnvironment(dataDir:string,executable:string) {
 return mutate(dataDir,async()=>{const managed=typeof executable === "string" && path.resolve(executable).startsWith(path.join(path.resolve(dataDir),"python-environments")+path.sep);const value=await descriptor(dataDir,executable,managed);save(dataDir,value);return value;});
}
const documentPackages=["pypdf","pdfplumber","reportlab","pypdfium2","python-docx","openpyxl","markitdown[pdf,docx,xlsx]"];
async function install(dataDir:string,value:PythonEnvironment) {
 const wheels=path.join(dataDir,"python-environments",".wheels");fs.mkdirSync(wheels,{recursive:true,mode:0o700});
 const options={maxBuffer:2*1024*1024,env:environment(dataDir)};
 try {
 await execute(value.executable,["-m","pip","download","--dest",wheels,"--cache-dir",path.join(dataDir,"python-environments",".pip-cache"),...documentPackages],{...options,timeout:900_000});
 await execute(value.executable,["-m","pip","install","--no-input","--no-index","--find-links",wheels,...documentPackages],{...options,timeout:120_000});
 } catch(error) {
  if((error as {killed?:boolean}).killed)throw new Error("依赖下载或安装超时。当前 Python 配置未改变，请稍后重试，已下载的包会保留。");
  throw error;
 }
}
export async function createPythonEnvironment(dataDir:string,baseExecutable:string,installDocuments:boolean) {
 return mutate(dataDir,async()=>{
  await inspect(dataDir,baseExecutable);
  const directory=path.join(dataDir,"python-environments",randomUUID());
  await execute(baseExecutable,["-I","-m","venv",directory],{timeout:90_000,maxBuffer:128*1024,env:environment(dataDir)});
  const executable=path.join(directory,process.platform==="win32" ? "Scripts/python.exe":"bin/python");
  const value=await descriptor(dataDir,executable,true);
  if(installDocuments)await install(dataDir,value);
  save(dataDir,value);return value;
 });
}
export async function installDocumentPythonDependencies(dataDir:string) {
 return mutate(dataDir,async()=>{
  const current=readPythonEnvironment(dataDir);if(!current)throw new Error("请先选择或创建 Python 虚拟环境");
  const value=await descriptor(dataDir,current.executable,current.managed);await install(dataDir,value);save(dataDir,value);return value;
 });
}
export function pythonReadDirectories(value:PythonEnvironment) {
 return [...new Set([value.directory,value.baseDirectory,path.dirname(path.dirname(fs.realpathSync(value.executable)))])];
}
export function pythonShellEnvironment(value:PythonEnvironment) {
 return {PATH:`${path.dirname(value.executable)}${path.delimiter}${process.env.PATH ?? ""}`,VIRTUAL_ENV:value.directory,PYTHONHOME:"",PYTHONPATH:"",PYTHONNOUSERSITE:"1",PYTHONDONTWRITEBYTECODE:"1"};
}
export function shellQuote(value:string) { return "'"+value.replaceAll("'","'\\''")+"'"; }
