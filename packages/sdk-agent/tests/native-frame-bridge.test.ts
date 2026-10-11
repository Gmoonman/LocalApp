import {afterEach,expect,it,vi} from "vitest";
import {attachNativeFrame} from "../src/native-frame-bridge.js";
import {installNativeApplicationBridge} from "../../dsh-app-platform/src/native-application-bridge.js";
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();document.body.innerHTML="";});
it("only admits preparation requests from its own same-origin frame",async()=>{
 const frame=document.createElement("iframe");document.body.append(frame);
 const connectNativeSession=vi.fn(async()=>({sessionId:"session-one",url:"/native/"}));
 const dispose=attachNativeFrame(frame,{connectNativeSession} as any);
 const data={type:"localapp:native-prepare",id:"request-one",sessionId:"session-one"};
 window.dispatchEvent(new MessageEvent("message",{origin:"https://foreign.invalid",source:frame.contentWindow,data}));
 window.dispatchEvent(new MessageEvent("message",{origin:window.location.origin,source:window,data}));
 expect(connectNativeSession).not.toHaveBeenCalled();
 window.dispatchEvent(new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data}));
 await vi.waitFor(()=>expect(connectNativeSession).toHaveBeenCalledWith("session-one"));
 dispose();window.dispatchEvent(new MessageEvent("message",{origin:window.location.origin,source:frame.contentWindow,data}));
 expect(connectNativeSession).toHaveBeenCalledTimes(1);
});
it("waits for the trusted host before sending a native prompt",async()=>{
 const postMessage=vi.fn();const parent={postMessage};let listener!:(event:any)=>void;
 const original=vi.fn(async()=>new Response("ok"));
 const nativeWindow={parent,location:{origin:"http://localhost",href:"http://localhost/native/?localappBridge=1",search:"?localappBridge=1"},fetch:original,addEventListener:(_name:string,callback:any)=>{listener=callback;},removeEventListener:vi.fn()};
 vi.stubGlobal("window",nativeWindow);vi.stubGlobal("document",{baseURI:"http://localhost/native/"});
 const dispose=installNativeApplicationBridge();
 const request=nativeWindow.fetch("http://localhost/native/api/session/prompt",{method:"POST",body:JSON.stringify({payload:{args:{request:{sessionId:"session-one"}}}})});
 expect(original).not.toHaveBeenCalled();const sent=postMessage.mock.calls[0][0];
 listener({source:{},origin:"http://localhost",data:{type:"localapp:native-prepared",id:sent.id,ok:true}});expect(original).not.toHaveBeenCalled();
 listener({source:parent,origin:"http://localhost",data:{type:"localapp:native-prepared",id:sent.id,ok:true}});
 await request;expect(original).toHaveBeenCalledOnce();dispose();expect(nativeWindow.fetch).toBe(original);
});
