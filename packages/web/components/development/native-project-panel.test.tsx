import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeProjectPanel } from "../../../dsh-app-development/ui/native-project-panel";
afterEach(()=>vi.unstubAllGlobals());
it("opens the native project workspace without loading legacy conversations and confirms release",async()=>{
  const request=vi.fn(async(url:string,init?:RequestInit)=>{
    const data=url==="/api/development/projects"?[{id:"p",name:"native-app"}]
      :url==="/api/agent/settings"?{providers:[{id:"m",name:"model",model:"test"}],defaultProviderId:"m"}
      :url.endsWith("/files")?["main.ts"]
      :url.endsWith("/versions")?[{id:"v",message:"initial"}]
      :url.endsWith("/builds")?[{id:"b",status:"succeeded",purpose:"release"}]
      :url.endsWith("/release-target")?{version:1}
      :url.endsWith("/releases")?{url:"/owner/native-app/"}:[];
    return new Response(JSON.stringify({success:true,data}));
  });
  vi.stubGlobal("fetch",request);
  const onConversation=vi.fn();
  const view=render(<NativeProjectPanel projectId="p" onConversation={onConversation}/>);
  await screen.findByText("native-app");
  await waitFor(()=>expect(screen.getByRole("button",{name:"上线"})).not.toBeDisabled());
  expect(request.mock.calls.some(([url])=>url.includes("/agent/sessions"))).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"上线"}));
  await screen.findByRole("dialog",{name:"确认操作"});
  expect(request.mock.calls.some(([url])=>url.endsWith("/releases"))).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"取消"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"上线"})).not.toBeDisabled());
  expect(request.mock.calls.some(([url])=>url.endsWith("/releases"))).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"返回开发对话"}));
  expect(onConversation).toHaveBeenCalledOnce();
  view.unmount();
});
