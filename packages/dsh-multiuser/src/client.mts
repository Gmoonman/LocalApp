import type { Context } from "@deepseek-ai/cordis";
import { requestModelSettings } from "./model-settings-client.mjs";
import { requestCapabilitySettings } from "./capability-settings-client.mjs";
export function apply(ctx: Context): void {
  ctx.provide("localappModelSettingsClient", { requestModelSettings, requestCapabilitySettings });
}
declare module "@deepseek-ai/cordis" {
  interface Context { localappModelSettingsClient: { requestModelSettings: typeof requestModelSettings; requestCapabilitySettings: typeof requestCapabilitySettings } }
}
