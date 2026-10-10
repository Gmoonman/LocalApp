import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import ClientModules from "@deepseek-ai/dsh-client-modules";

/** Native UI packages; application-specific controls are contributed separately. */
export const NATIVE_CLIENT_PACKAGES = [
  "@deepseek-ai/dsh-client-modules",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-session",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-chat",
  "@deepseek-ai/dsh-client-ui-trajectory",
] as const;

/** Load upstream host entries so its registry serves the original client bundles. */
export async function mountNativeClientModules(ctx: Context) {
  if (!ctx.get("loader")) await ctx.plugin(Loader, { baseUrl: import.meta.url });
  for (const name of NATIVE_CLIENT_PACKAGES) {
    if (name === "@deepseek-ai/dsh-client-modules") continue;
    await ctx.loader.create({ name });
  }
  await ctx.loader.await();
  await ctx.plugin(ClientModules);
  return ctx.clientModules;
}
