import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionInput } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { nativeAttachmentList } from "./native-attachment-intake.js";
export function installNativeAttachmentObserver(sessions: Pick<ISessions,"list"|"scope">,
  resolve: (context: NonNullable<ReturnType<ISessions["scope"]>>) => {input: SessionInput; conversation: unknown}) {
  if(window.parent===window)return()=>{};
  let disposed=false;
  let current:unknown;
  let unsubscribeInput:(()=>void)|undefined;
  let previous="";
  const update=()=>{
    const row=Object.values(sessions.list.getSnapshot().byId).find(row=>(row.retainedBy.mainView??0)>0);
    const scope=row?sessions.scope(row.id):undefined;
    if(scope===current)return;
    unsubscribeInput?.();unsubscribeInput=undefined;current=scope;previous="";
    const publish=(attachments: ReturnType<typeof nativeAttachmentList>)=>{
      const data={type:"localapp:native-attachments",sessionId:row?.id??null,attachments};
      const serialized=JSON.stringify(data);if(serialized===previous)return;previous=serialized;
      window.parent.postMessage(data,window.location.origin);
    };
    if(!scope){publish([]);return;}
    const {input,conversation}=resolve(scope);
    const refresh=()=>queueMicrotask(()=>{if(!disposed&&current===scope)publish(nativeAttachmentList(input,conversation));});
    unsubscribeInput=input.state.subscribe(refresh);refresh();
  };
  const unsubscribe=sessions.list.subscribe(update);update();
  return()=>{disposed=true;unsubscribe();unsubscribeInput?.();};
}
