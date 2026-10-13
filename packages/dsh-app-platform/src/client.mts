import { createElement } from "react";
import { readNativeApplicationScope } from "@localapp/dsh-agent-settings/native-settings-ui";
import type { Context } from "@deepseek-ai/cordis";
import { installNativeApplicationBridge } from "./native-application-bridge.js";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type {} from "@deepseek-ai/dsh-api-workspace-controller/client";

export const inject = ["slots", "localappCapabilitySettingsUI"];
export function apply(ctx: Context): void {
  const appId = readNativeApplicationScope(window.location.pathname);
  if (appId && appId !== "platform") {
      const scope = appId;
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "localapp-application-capabilities", label: () => "应用 Agent 能力", order: 40,
      }, () => createElement(ctx.localappCapabilitySettingsUI.Panel, {appId: scope})));
  }
  ctx.effect(() => installNativeApplicationBridge());

}
