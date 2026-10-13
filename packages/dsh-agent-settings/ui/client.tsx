import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { apply as provideSettings } from "../src/client.mjs";
import { createAgentCapabilitySettings } from "./agent-capability-settings";
import { Button } from "@localapp/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@localapp/ui/card";
import { Switch } from "@localapp/ui/switch";
import { Badge } from "@localapp/ui/badge";
import { Input } from "@localapp/ui/input";
import { Label } from "@localapp/ui/label";
import { Skeleton } from "@localapp/ui/skeleton";
import { readNativeApplicationScope } from "../src/native-settings-ui.mjs";

import { NativeModelSettings } from "./native-model-settings";
import styles from "@localapp/ui/native-settings.css";
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
  // Application and developer scopes are contributed by their owning plugins.
  if (readNativeApplicationScope(window.location.pathname) !== "platform") return;
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: "localapp-capabilities", label: () => "Agent 能力", order: 40,
  }, () => <Panel appId="platform" />));
}
