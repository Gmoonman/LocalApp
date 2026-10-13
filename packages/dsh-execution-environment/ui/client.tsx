import type {Context} from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import {NativeSystemEnvironment} from "./native-system-environment";
export const inject=["slots"];
export function apply(ctx:Context){ctx.effect(()=>{
 const controller=new AbortController();let remove:(()=>void)|undefined;
 void fetch("/api/me",{credentials:"include",signal:controller.signal}).then(async response=>{
  const body=await response.json();if(!response.ok||!body.success||body.data?.role!=="admin"||controller.signal.aborted)return;
  remove=ctx.slots.inject("settings.section",()=>ctx.slots.register({name:"settings.section",id:"localapp-python-environment",label:()=>"Python 环境",order:60},NativeSystemEnvironment));
 }).catch(()=>{});
 return ()=>{controller.abort();remove?.();};
});}
