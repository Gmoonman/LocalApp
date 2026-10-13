import { resolveDeepSeekPlugin } from "./deepseek-plugin.mjs";
import { Context } from "@deepseek-ai/cordis";
import AgentUI from "@localapp/dsh-agent-ui";
import AgentRuntime from "@localapp/dsh-agent-runtime";
import AgentSettings from "@localapp/dsh-agent-settings";
import ExecutionEnvironment from "@localapp/dsh-execution-environment";
import ModelSettings from "@localapp/dsh-model-settings";
import Multiuser from "@localapp/dsh-multiuser";
import type Platform from "@localapp/dsh-app-platform";
import type Development from "@localapp/dsh-app-development";

export type PluginCombination = "multiuser" | "platform" | "full";
export interface PluginSuiteOptions {
  /** Reuse the Context already carrying the unique HTTP listener. */
  context?: Context;
  combination?: PluginCombination;
  agentUI?: boolean;
  synchronization?:boolean;
  collaboration?:boolean;
  deviceServices?:boolean;
  documents?: false | { root?: string };
  multiuser: NonNullable<ConstructorParameters<typeof Multiuser>[1]>;
  platform?: ConstructorParameters<typeof Platform>[1];
  development?: ConstructorParameters<typeof Development>[1];
}

/** One Cordis context owns every contribution and its shutdown. */
export async function createPluginSuite(options: PluginSuiteOptions): Promise<Context> {
  const combination = options.combination ?? "full";
  if (!["multiuser", "platform", "full"].includes(combination)) {
    throw new Error(`Unknown LocalApp plugin combination: ${combination}`);
  }
  if (combination !== "multiuser" && !options.platform) {
    throw new Error("Application platform configuration is required");
  }
  if (combination === "full" && !options.development) {
    throw new Error("Application development configuration is required");
  }
  const context = options.context ?? new Context();
  try {
    await context.plugin(resolveDeepSeekPlugin(ExecutionEnvironment), {documents:options.documents!==false,root:(options.documents || undefined)?.root ?? process.env.LOCALAPP_PUBLIC_SKILLS_ROOT,systemEnvironment:options.multiuser.systemEnvironment});
    await context.plugin(resolveDeepSeekPlugin(AgentSettings));
    await context.plugin(resolveDeepSeekPlugin(AgentRuntime), {capacity:options.multiuser.capacity});
    await context.plugin(resolveDeepSeekPlugin(ModelSettings));
    await context.plugin(resolveDeepSeekPlugin(Multiuser), options.multiuser);
    if (options.agentUI !== false) await context.plugin(resolveDeepSeekPlugin(AgentUI));
    if (combination !== "multiuser") {
      const { default: Platform } = await import("@localapp/dsh-app-platform");
      await context.plugin(resolveDeepSeekPlugin(Platform), options.platform!);
      if(options.synchronization!==false)await context.plugin(resolveDeepSeekPlugin((await import("@localapp/dsh-app-sync")).default));
      if(options.collaboration!==false)await context.plugin(resolveDeepSeekPlugin((await import("@localapp/dsh-collaboration")).default));
      if(options.deviceServices!==false)await context.plugin(resolveDeepSeekPlugin((await import("@localapp/dsh-device-services")).default));

    }
    if (combination === "full") {
      const { default: Development } = await import("@localapp/dsh-app-development");
      await context.plugin(resolveDeepSeekPlugin(Development), options.development!);
    }
    return context;
  } catch (error) {
    await context.fiber.dispose();
    throw error;
  }
}
