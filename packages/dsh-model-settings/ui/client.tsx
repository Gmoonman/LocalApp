import { useEffect, useRef } from 'react';
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
export const inject=['slots','remote'];
export function apply(ctx:Context){
 // This settings-only page has no selected conversation.
 const absent={key:undefined,hooks:{},keyedHooks:{},props:{}};
 const source={getSnapshot:()=>absent,subscribe:()=>()=>{}};
 ctx.slots.installScope('session',{current:source,bindingSource:()=>source});

 const changed=()=>window.parent.postMessage({type:'localapp-model-settings-updated'},window.location.origin);
 ctx.remote.$on('settings/document-updated',changed);
 ctx.remote.$on('credentials/reference-updated',changed);
 const Panel=({renderSlot}:any)=>{
  const element=useRef<HTMLElement>(null);
  useEffect(()=>{
   const root=element.current;if(!root)return;
   const resize=()=>window.parent.postMessage({type:'localapp-model-settings-resize',height:root.getBoundingClientRect().height},window.location.origin);
   const observer=new ResizeObserver(resize);observer.observe(root);resize();
   return()=>observer.disconnect();
  },[]);
  return <main ref={element} style={{padding:'0 0 16px',boxSizing:'border-box',background:'var(--background-primary,white)'}}>{renderSlot('settings.section',{close:()=>{}},{only:'models'})}</main>;
 };
 ctx.slots.register({name:'root',id:'localapp-model-settings',children:{'settings.section':{kind:'list',scope:'root'},'settings.onboarding':{kind:'list',scope:'root'}}},Panel);
}
