import type { ComponentType } from "react";
export type { Context } from "@deepseek-ai/cordis";
export type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
export type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
export interface NativeCapabilitySettingsUI {
  Panel: ComponentType<{appId: string}>;
}
/** UI selection only; the Server checks access to the requested application. */
export function readNativeApplicationScope(pathname: string): string | undefined {
  const match = /^\/api\/agent\/native\/([^/]+)\//.exec(pathname);
  if (!match) return;
  try {
    const scope = JSON.parse(atob(match[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof scope?.appId === "string" && scope.appId ? scope.appId : undefined;
  } catch { return; }
}
declare module "@deepseek-ai/cordis" {
  interface Context { localappCapabilitySettingsUI: NativeCapabilitySettingsUI }
}
