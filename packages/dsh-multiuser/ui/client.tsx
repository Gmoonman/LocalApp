import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { apply as provideSettings } from "../src/client.mjs";
import { createAgentCapabilitySettings } from "./agent-capability-settings";
import { Button } from "./shadcn/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./shadcn/card";
import { Switch } from "./shadcn/switch";
import { Badge } from "./shadcn/badge";
import { Input } from "./shadcn/input";
import { Label } from "./shadcn/label";
import { Skeleton } from "./shadcn/skeleton";
import { readNativeApplicationScope } from "../src/native-settings-ui.mjs";
import { NativeSystemEnvironment } from "./native-system-environment";
import { NativeModelSettings } from "./native-model-settings";
import styles from "./native-settings.css";
const AgentSettings = createAgentCapabilitySettings({Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Switch, Badge, Input, Label, Skeleton});
export const inject = ["slots"];
export function apply(ctx: Context) {
  provideSettings(ctx);
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.localappSettings = ""; style.textContent = styles;
    document.head.append(style);
    return () => style.remove();
  });
  const Panel = ({appId}: {appId: string}) => <div className="localapp-native-settings"><AgentSettings appId={appId} /></div>;
  ctx.provide("localappCapabilitySettingsUI", {Panel});
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: "localapp-model-settings", label: () => "模型与 MCP", order: 30,
  }, NativeModelSettings));
  ctx.effect(() => {
    const controller = new AbortController();
    let unregister: (() => void) | undefined;
    void fetch("/api/me", {credentials: "include", signal: controller.signal}).then(async response => {
      const body = await response.json();
      if (!response.ok || !body.success || body.data?.role !== "admin" || controller.signal.aborted) return;
      unregister = ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "localapp-python-environment", label: () => "Python 环境", order: 60,
      }, NativeSystemEnvironment));
    }).catch(() => { /* No administrator entry unless the Server confirms the role. */ });
    return () => { controller.abort(); unregister?.(); };
  });
  // Application and developer scopes are contributed by their owning plugins.
  if (readNativeApplicationScope(window.location.pathname) !== "platform") return;
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: "localapp-capabilities", label: () => "Agent 能力", order: 40,
  }, () => <Panel appId="platform" />));
}
