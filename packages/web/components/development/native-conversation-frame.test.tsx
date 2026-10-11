import React from "react";
import {render,screen,fireEvent} from "@testing-library/react";
import {expect,it,vi} from "vitest";
import {NativeConversationFrame} from "./native-conversation-frame";
const binding=vi.hoisted(()=>({attach:vi.fn(),dispose:vi.fn()}));
vi.mock("@localapp/sdk-agent/native-frame-bridge",()=>({attachNativeFrame:(...args:unknown[])=>{binding.attach(...args);return binding.dispose;}}));
it("keeps developer sources outside the user tool bridge",()=>{
 binding.attach.mockClear();
 const view=render(<NativeConversationFrame identity="developer" projectId="project-one" providerId="model-one"/>);
 expect(screen.getByTitle("原生应用开发对话")).toHaveAttribute("src","/api/development/projects/project-one/native/model-one/");expect(binding.attach).not.toHaveBeenCalled();view.unmount();
});
it("restores history after native readiness and synchronizes trusted selection changes",()=>{
 const onSelection=vi.fn();
 const view=render(<NativeConversationFrame identity="developer" projectId="project-one" providerId="model-one" sessionId="history-one" onSelection={onSelection}/>);
 const frame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
 const post=vi.spyOn(frame.contentWindow!,"postMessage");
 const announce=(sessionId:string,origin=window.location.origin,source:Window=frame.contentWindow!)=>window.dispatchEvent(new MessageEvent("message",{origin,source,data:{type:"localapp:native-selection",state:{sessionId,title:"需求会话",running:false}}}));
 announce("wrong","https://foreign.invalid");announce("wrong",window.location.origin,window);expect(onSelection).not.toHaveBeenCalled();
 announce("current-one");expect(post).toHaveBeenCalledWith({type:"localapp:native-select",sessionId:"history-one"},window.location.origin);expect(onSelection).not.toHaveBeenCalled();
 announce("history-one");expect(onSelection).toHaveBeenCalledWith({sessionId:"history-one",title:"需求会话",running:false});
 view.rerender(<NativeConversationFrame identity="developer" projectId="project-one" providerId="model-one" sessionId="history-two" newSession={1} onSelection={onSelection}/>);
 expect(post).toHaveBeenCalledWith({type:"localapp:native-select",sessionId:"history-two"},window.location.origin);
 expect(post).toHaveBeenCalledWith({type:"localapp:native-new-session"},window.location.origin);
 fireEvent.load(frame);expect(post).toHaveBeenCalledWith({type:"localapp:native-selection-request"},window.location.origin);
 view.unmount();announce("history-three");expect(onSelection).toHaveBeenCalledTimes(1);
});
it("binds user frames to the application and disposes the bridge on provider changes",()=>{
 binding.attach.mockClear();binding.dispose.mockClear();const agent={} as any;
 const view=render(<NativeConversationFrame identity="user" applicationId="owner/app" providerId="model-one" agent={agent}/>);
 expect(binding.attach).toHaveBeenCalledWith(screen.getByTitle("原生应用用户对话"),agent);
 const source=screen.getByTitle("原生应用用户对话").getAttribute("src")!;const encoded=source.split("/native/")[1].split("/")[0];
 expect(JSON.parse(atob(encoded.replace(/-/g,"+").replace(/_/g,"/")))).toEqual({appId:"owner/app",providerId:"model-one"});
 view.rerender(<NativeConversationFrame identity="user" applicationId="owner/app" providerId="model-two" agent={agent}/>);
 expect(binding.dispose).toHaveBeenCalledOnce();view.unmount();expect(binding.dispose).toHaveBeenCalledTimes(2);
});

it("correlates native composer results and rejects pending work on unload",async()=>{
 const onComposerReady=vi.fn();
 const view=render(<NativeConversationFrame identity="developer" projectId="one" providerId="model" onComposerReady={onComposerReady}/>);
 const frame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
 const port=onComposerReady.mock.calls.at(-1)![0];
 await expect(port.request("cancel")).rejects.toThrow("尚未就绪");
 window.dispatchEvent(new MessageEvent("message",{source:frame.contentWindow,origin:window.location.origin,data:{type:"localapp:native-selection",state:{sessionId:"one",title:"需求",running:false}}}));
 const post=vi.spyOn(frame.contentWindow!,"postMessage");
 const result=port.request("submit","修改应用");
 const request=post.mock.calls.at(-1)![0];
 window.dispatchEvent(new MessageEvent("message",{source:frame.contentWindow,origin:"https://foreign.invalid",data:{type:"localapp:native-composer-result",requestId:request.requestId}}));
 window.dispatchEvent(new MessageEvent("message",{source:frame.contentWindow,origin:window.location.origin,data:{type:"localapp:native-composer-result",requestId:request.requestId}}));
 await expect(result).resolves.toBeUndefined();
 const cancelled=port.request("cancel");const refusal=expect(cancelled).rejects.toThrow("已关闭");view.unmount();await refusal;
 expect(onComposerReady).toHaveBeenLastCalledWith(null);
});

it("creates a blank native conversation before submitting its first draft",async()=>{
 const ready=vi.fn();const view=render(<NativeConversationFrame identity="developer" projectId="one" providerId="model" onComposerReady={ready}/>);
 const frame=screen.getByTitle("原生应用开发对话") as HTMLIFrameElement;
 const announce=(state:any)=>window.dispatchEvent(new MessageEvent("message",{source:frame.contentWindow,origin:window.location.origin,data:{type:"localapp:native-selection",state}}));
 announce(null);const post=vi.spyOn(frame.contentWindow!,"postMessage");
 const result=ready.mock.calls.at(-1)![0].request("submit","创建日历");
 expect(post).toHaveBeenCalledWith({type:"localapp:native-new-session"},window.location.origin);
 announce({sessionId:"created-one",title:"新会话",running:false});
 await Promise.resolve();
 const request=post.mock.calls.at(-1)![0];expect(request).toMatchObject({type:"localapp:native-composer",sessionId:"created-one",prompt:"创建日历"});
 window.dispatchEvent(new MessageEvent("message",{source:frame.contentWindow,origin:window.location.origin,data:{type:"localapp:native-composer-result",requestId:request.requestId}}));
 await expect(result).resolves.toBeUndefined();view.unmount();
});
