import { readPythonEnvironment, type PythonEnvironment } from "./python-environment.cjs";
import type { AgentEnvironment } from "./agent-environment.cjs";
export interface EnvironmentHarness { initialize(): Promise<void>; checkEnvironment(): Promise<AgentEnvironment>; close(): Promise<void> }
export interface SystemEnvironmentHost { createHarness(dataDir: string, python: PythonEnvironment | undefined): Promise<EnvironmentHarness> }
export class SystemEnvironment {
  private generation = 0;
  private draining?: Promise<void>;
  private readonly checks = new Map<string, {at:number;pending:boolean;report:Promise<AgentEnvironment>}>();
constructor(private readonly host: SystemEnvironmentHost) {}
async check(dataDir: string): Promise<AgentEnvironment> {
 if (this.draining) throw new Error("Environment checks are stopping");
 const generation = this.generation;
 const pythonEnvironment=readPythonEnvironment(dataDir);
 const key=dataDir+":"+(pythonEnvironment?.revision ?? "default");
 const previous=this.checks.get(key);
 if(previous && (previous.pending || Date.now()-previous.at < 15_000))return previous.report;
 const report=(async()=>{
  const harness = await this.host.createHarness(dataDir, pythonEnvironment);
  try{
   await harness.initialize();
   const report=await harness.checkEnvironment();
   return { ...report, checks: report.checks.filter(check => check.id !== "terminal").map(check => check.id === "runner" ? { ...check, name: "系统命令执行", detail: check.status === "ready" ? "LocalApp 执行器可运行文档处理命令。" : "LocalApp 执行器不可用，请检查 Server 执行支持。" } : check) };
  }finally{await harness.close();}
 })();
 this.checks.set(key,{at:Date.now(),pending:true,report});
 try{const result=await report;if (generation === this.generation) this.checks.set(key,{at:Date.now(),pending:false,report});return result;}catch(error){if (generation === this.generation) this.checks.delete(key);throw error;}
}

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    const pending = [...this.checks.values()].filter(entry => entry.pending).map(entry => entry.report);
    this.generation++;
    this.checks.clear();
    this.draining = Promise.allSettled(pending).then(() => {}).finally(() => { this.draining = undefined; });
    return this.draining;
  }

}
