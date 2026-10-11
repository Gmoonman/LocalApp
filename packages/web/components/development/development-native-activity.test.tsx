import React from "react";
import {fireEvent,render,screen,waitFor} from "@testing-library/react";
import {expect,it,vi,afterEach} from "vitest";
import {DevelopmentPage} from "./development-page";
vi.mock("./app-development-dock",()=>({AppDevelopmentDock:(p:any)=><div>
 <output aria-label="构建状态">{p.build?.id??"none"}</output><output aria-label="源码文件">{p.files.join(",")}</output>
 <output aria-label="文件内容">{p.text}</output><button onClick={()=>p.actions.open("original.ts")}>打开源码</button>
 <button onClick={()=>p.actions.nativeActivity("native-one",true)}>开始原生执行</button>
 <button onClick={()=>p.actions.nativeActivity("native-one",false)}>结束原生执行</button>
</div>}));
afterEach(()=>vi.unstubAllGlobals());
it("invalidates old artifacts and previews changed source after a native turn without a legacy run",async()=>{
 let version="v1";let changed=false;
 const fetcher=vi.fn(async(url:string,options:any={})=>{
  let data:any=[];
  if(url==="/api/agent/settings")data={providers:[{id:"model",name:"模型",model:"test"}],defaultProviderId:"model"};
  else if(url.endsWith("/source"))data={id:"p",name:"app"};
  else if(url.endsWith("/files"))data=changed?["original.ts","changed.ts"]:["original.ts"];
  else if(url.includes("/file?"))data={path:"original.ts",content:changed?"updated source":"original source"};
  else if(url.endsWith("/versions"))data=[{id:version,message:"源码版本"}];
  else if(url.endsWith("/builds"))data=options.method==="POST"?{id:"native-preview",status:"queued",purpose:"preview"}:changed?[]:[{id:"old-build",status:"succeeded",purpose:"release"}];
  else if(url.includes("/builds/"))data={id:"native-preview",status:"queued",purpose:"preview"};
  return new Response(JSON.stringify({success:true,data}));
 });vi.stubGlobal("fetch",fetcher);
 render(<DevelopmentPage application={{owner:"owner",name:"app"}}/>);
 await waitFor(()=>expect(screen.getByLabelText("构建状态")).toHaveTextContent("old-build"));
 fireEvent.click(screen.getByText("打开源码"));await waitFor(()=>expect(screen.getByLabelText("文件内容")).toHaveTextContent("original source"));
 fireEvent.click(screen.getByText("开始原生执行"));expect(screen.getByLabelText("构建状态")).toHaveTextContent("none");
 changed=true;version="v2";fireEvent.click(screen.getByText("结束原生执行"));
 await waitFor(()=>expect(screen.getByLabelText("构建状态")).toHaveTextContent("native-preview"));
 expect(screen.getByLabelText("源码文件")).toHaveTextContent("changed.ts");
 expect(screen.getByLabelText("文件内容")).toHaveTextContent("updated source");
 expect(fetcher.mock.calls.some(([url])=>url.endsWith("/agent/run"))).toBe(false);
 expect(fetcher.mock.calls.find(([url,options])=>url.endsWith("/builds")&&options?.method==="POST")?.[1].body).toBe(JSON.stringify({purpose:"preview"}));
});
