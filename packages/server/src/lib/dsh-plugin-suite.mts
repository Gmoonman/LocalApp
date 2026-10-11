import { resolveDeepSeekPlugin } from "./deepseek-plugin.mjs";
import { Context } from "@deepseek-ai/cordis";
import AgentUI from "@localapp/dsh-agent-ui";
import Multiuser from "@localapp/dsh-multiuser";
import type Platform from "@localapp/dsh-app-platform";
import type Development from "@localapp/dsh-app-development";

export type PluginCombination = "multiuser" | "platform" | "full";
export interface PluginSuiteOptions {
  /** Reuse the Context already carrying the unique HTTP listener. */
  context?: Context;
  combination?: PluginCombination;
  agentUI?: boolean;
  documents?: false | { root?: string };
  multiuser: ConstructorParameters<typeof Multiuser>[1];
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
    if (options.documents !== false) {
      const { default: DocumentTools } = await import("@localapp/dsh-document-tools");
      await context.plugin(resolveDeepSeekPlugin(DocumentTools), { root: options.documents?.root ?? process.env.LOCALAPP_PUBLIC_SKILLS_ROOT });
    }
    await context.plugin(resolveDeepSeekPlugin(Multiuser), options.multiuser);
    if (options.agentUI !== false) await context.plugin(resolveDeepSeekPlugin(AgentUI));
    if (combination !== "multiuser") {
      const { default: Platform } = await import("@localapp/dsh-app-platform");
      await context.plugin(resolveDeepSeekPlugin(Platform), options.platform!);
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
