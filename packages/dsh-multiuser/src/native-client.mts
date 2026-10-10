import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import type {} from "@deepseek-ai/dsh-client-modules";

/** Native UI packages; application-specific controls are contributed separately. */
export const NATIVE_CLIENT_PACKAGES = [
  "@deepseek-ai/dsh-api-gateway",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-api-workspace-controller",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-file-upload",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-modules",
  "@deepseek-ai/dsh-client-resources",
  "@deepseek-ai/dsh-client-shortcuts",
  "@deepseek-ai/dsh-client-ui-chat",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-input-trigger",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-session",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-sidebar",
  "@deepseek-ai/dsh-client-ui-sidebar-right",
  "@deepseek-ai/dsh-client-ui-theme",
  "@deepseek-ai/dsh-client-ui-trajectory",
  "@deepseek-ai/dsh-client-ui-workspace",
  "@deepseek-ai/dsh-typert-registry"
] as const;

/** Load upstream host entries so its registry serves the original client bundles. */
export async function mountNativeClientModules(ctx: Context) {
  if (ctx.get("agents")) throw new Error("Client assets require a separate Context from Agent execution");
  if (!ctx.get("loader")) await ctx.plugin(Loader, { baseUrl: import.meta.url });
  for (const name of NATIVE_CLIENT_PACKAGES) {
    await ctx.loader.create({ name });
  }
  await ctx.loader.await();
  if (!ctx.get("clientModules")) throw new Error("Native client module registry failed to load");
  return ctx.clientModules;
}
