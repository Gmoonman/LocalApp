import React from "react";
import {render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {NativeDevelopmentEntry} from "@localapp/dsh-app-development/ui/development-entry";
afterEach(()=>vi.unstubAllGlobals());
it("hosts upstream dsh with the user's provider without opening a second execution stream",async()=>{
  const fetcher=vi.fn(async(url:string)=>new Response(JSON.stringify({success:true,data:url==="/api/development/projects"?[{id:"project-a",name:"Example"}]:{providers:[{id:"my-provider",name:"Personal model",model:"test"}],defaultProviderId:"my-provider"}})));
  vi.stubGlobal("fetch",fetcher);
  const view=render(<NativeDevelopmentEntry/>);
  const frame=await screen.findByTitle("原生应用开发工作区");
  expect(frame).toHaveAttribute("src","/api/development/projects/project-a/native/my-provider/");
  expect(fetcher.mock.calls.map(([url])=>url)).toEqual(["/api/development/projects","/api/agent/settings"]);
  expect(screen.getByRole("link",{name:"创建应用"})).toHaveAttribute("href","/my/apps");
  view.unmount();
});
it("shows model setup when there is no personal provider",async()=>{
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>new Response(JSON.stringify({success:true,data:url==="/api/development/projects"?[{id:"p",name:"App"}]:{providers:[],defaultProviderId:""}}))));
  const view=render(<NativeDevelopmentEntry/>);
  await screen.findByRole("link",{name:"模型与 Agent"});
  expect(screen.queryByTitle("原生应用开发工作区")).toBeNull();
  view.unmount();
});
