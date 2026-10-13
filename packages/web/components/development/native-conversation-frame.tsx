"use client";
import {currentApplicationContext,registerPageContextClient,runIsolatedPreviewCheck} from "./page-context";
import { useCallback, useEffect } from "react";
import type { HarnessAgent } from "@localapp/sdk-agent/harness-client";
import { attachNativeFrame } from "@localapp/sdk-agent/native-frame-bridge";
import { NativeConversationFrame as PlatformFrame, type NavigationProps } from "@localapp/dsh-agent-ui/ui/native-conversation-frame";
export type { NativeSelection, NativeCatalogEntry } from "@localapp/dsh-agent-ui/ui/native-conversation-frame";
export function NativeConversationFrame(props: NavigationProps & (
  | {identity: "user"; applicationId: string; providerId: string; agent: HarnessAgent}
  | {identity: "developer"; projectId: string; providerId: string})) {
  const projectId=props.identity==="developer"?props.projectId:undefined;
  useEffect(()=>{
    if(!projectId)return;
    const controller=new AbortController(),clientId=crypto.randomUUID();
    const unregister=registerPageContextClient(projectId,clientId);
    let busy=false;
    const poll=async()=>{
      if(busy||controller.signal.aborted||document.visibilityState!=="visible")return;
      busy=true;
      try{
        const base=`/api/development/projects/${encodeURIComponent(projectId)}/page-context`;
        const response=await fetch(`${base}/requests?clientId=${clientId}`,{signal:controller.signal});
        if(!response.ok)return;
        const body=await response.json();
        for(const request of body.data??[]){
          let context:unknown;
          try{context=request.command?.verification ? await runIsolatedPreviewCheck(request.command.verification) : await currentApplicationContext();}catch(error){context={error:error instanceof Error?error.message:String(error)};}
          await fetch(`${base}/results`,{method:"POST",headers:{"Content-Type":"application/json"},signal:controller.signal,body:JSON.stringify({clientId,requestId:request.id,context})});
        }
      }catch{}finally{busy=false;}
    };
    void poll();const timer=setInterval(()=>void poll(),1000);
    return()=>{controller.abort();clearInterval(timer);unregister();};
  },[projectId]);
  const agent = props.identity === "user" ? props.agent : undefined;
  const bind = useCallback((frame: HTMLIFrameElement) => attachNativeFrame(frame, agent!), [agent]);
  const prepare = useCallback(async (sessionId: string) => { if (agent) await agent.connectNativeSession(sessionId); }, [agent]);
  const src = props.identity === "developer"
    ? `/api/development/projects/${encodeURIComponent(props.projectId)}/native/${encodeURIComponent(props.providerId)}/?localappCompact=1`
    : `/api/agent/native/${btoa(JSON.stringify({appId: props.applicationId, providerId: props.providerId})).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}/?localappBridge=1&localappCompact=1`;
  return <PlatformFrame {...props} src={src} title={props.identity === "developer" ? "原生应用开发对话" : "原生应用用户对话"} bind={agent ? bind : undefined} prepare={agent ? prepare : undefined} />;
}
