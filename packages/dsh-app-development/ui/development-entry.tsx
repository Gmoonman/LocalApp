"use client";
import {useEffect,useState} from "react";
import {Button} from "@localapp/ui/button";
import {ChoiceSelect} from "@localapp/ui/choice-select";
type Project={id:string;name:string};
type Provider={id:string;name:string;model:string};
async function read(url:string){
  const response=await fetch(url,{credentials:"include"});
  const result=await response.json();
  if(!response.ok || !result.success)throw new Error(result.error || "加载失败");
  return result.data;
}
/** The compatibility URL hosts upstream dsh rather than another chat renderer. */
export function NativeDevelopmentEntry(){
  const [projects,setProjects]=useState<Project[]>([]);
  const [providers,setProviders]=useState<Provider[]>([]);
  const [project,setProject]=useState("");
  const [provider,setProvider]=useState("");
  const [error,setError]=useState("");
  const [ready,setReady]=useState(false);
  useEffect(()=>{
    let active=true;
    void Promise.all([read("/api/development/projects"),read("/api/agent/settings")]).then(([projects,settings])=>{
      if(!active)return;
      setProjects(projects);setProviders(settings.providers);
      const requested=new URLSearchParams(window.location.search).get("projectId");
      setProject(projects.find((p:Project)=>p.id===requested)?.id || projects[0]?.id || "");
      setProvider(settings.defaultProviderId || settings.providers[0]?.id || "");setReady(true);
    }).catch(cause=>{if(active)setError(cause.message);});
    return()=>{active=false;};
  },[]);
  return <section className="flex h-[calc(100dvh-2rem)] min-h-96 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <ChoiceSelect label="开发应用" value={project} options={projects.map(p=>({value:p.id,label:p.name}))} onValueChange={setProject}/>
      <ChoiceSelect label="开发模型" value={provider} options={providers.map(p=>({value:p.id,label:`${p.name} · ${p.model}`}))} onValueChange={setProvider}/>
      <Button asChild variant="outline"><a href="/my/apps">创建应用</a></Button>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {ready && !project && <p>还没有应用源码项目，请先创建应用或同步已有源码。</p>}
    {ready && !provider && <p>请先在<Button asChild variant="link"><a href="/my/models">模型与 Agent</a></Button>配置模型。</p>}
    {project && provider && <iframe key={`${project}:${provider}`} title="原生应用开发工作区" className="min-h-0 flex-1 w-full rounded-lg border"
      src={`/api/development/projects/${encodeURIComponent(project)}/native/${encodeURIComponent(provider)}/`}/>}
  </section>;
}
