import type { Context } from "@deepseek-ai/cordis";
import { request, nativeRequest } from "./creation-client.mjs";
import { NativeDevelopmentContext } from "./native-development-context.mjs";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";

export const inject = ["slots"];

/** Application creation transport; native dsh owns session execution and events. */
export function apply(ctx: Context): void {
  ctx.provide("localappDevelopmentClient", { request, nativeRequest });
  const match = /^\/api\/development\/projects\/([^/]+)\/native\//.exec(window.location.pathname);
  if (!match) return;
  const projectId = decodeURIComponent(match[1]);
  ctx.slots.inject("shell.bottom", () => ctx.slots.register({
    name: "shell.bottom", inject: () => ({ projectId }),
  }, NativeDevelopmentContext));
}
declare module "@deepseek-ai/cordis" {
  interface Context { localappDevelopmentClient: { request: typeof request; nativeRequest: typeof nativeRequest } }
}
