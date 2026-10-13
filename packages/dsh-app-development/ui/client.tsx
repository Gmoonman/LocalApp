import type { Context } from "@deepseek-ai/cordis";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { Code2 } from "lucide-react";
import { NativeProjectPanel } from "./native-project-panel";
import { SystemDevelopmentEnvironment } from "./development-environment";
import type {} from "@localapp/dsh-agent-settings/native-settings-ui";
import { apply as provideDevelopment } from "../src/client.mjs";
import { createDevelopmentSettingsForm } from "./development-agent-settings";
import { Button } from "@localapp/ui/button";
import { Textarea } from "@localapp/ui/textarea";
import { Label } from "@localapp/ui/label";
import { Switch } from "@localapp/ui/switch";
import styles from "./native-settings.css";
const Form = createDevelopmentSettingsForm({Button, Textarea, Label, Switch});
export const inject = ["slots", "layout", "localappCapabilitySettingsUI"];
export function apply(ctx: Context) {
  provideDevelopment(ctx);
  const match = /^\/api\/development\/projects\/([^/]+)\/native\//.exec(window.location.pathname);
  if (!match) return;
  const projectId = decodeURIComponent(match[1]);
  const panelId = "localapp-development" as MainPanelId;
  ctx.slots.inject("main", () => ctx.slots.register({name:"main",key:panelId},
    () => <NativeProjectPanel projectId={projectId} onConversation={()=>ctx.layout.selectPanel(null)} />));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name:"sidebar.panellist",id:panelId,label:()=>"应用开发",order:30,
  }, ({size})=><Code2 size={size} />));
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.localappDevelopmentSettings = ""; style.textContent = styles;
    document.head.append(style); return () => style.remove();
  });
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: "localapp-development-capabilities", label: () => "开发 Agent 能力", order: 40,
  }, () => <div className="localapp-native-settings">
    <p className="text-sm text-muted-foreground">仅影响你在此应用中的开发 Agent。保存会停止当前开发任务，之后的对话使用新设置。</p>
    <Form projectId={projectId} />
  </div>));
  ctx.effect(() => {
    const controller = new AbortController();
    let unregister: (()=>void) | undefined;
    void fetch("/api/me",{credentials:"include",signal:controller.signal})
      .then(response=>response.ok ? response.json() : null)
      .then(result=>{
        if(controller.signal.aborted || !result?.success || result.data?.role !== "admin") return;
        unregister=ctx.slots.inject("settings.section",()=>ctx.slots.register({
          name:"settings.section",id:"localapp-development-environment",label:()=>"应用开发环境",order:70,
        },()=> <div className="localapp-native-settings"><SystemDevelopmentEnvironment/></div>));
      }).catch(()=>{});
    return ()=>{controller.abort();unregister?.();};
  });
}
