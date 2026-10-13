import { DOCUMENT_SKILLS_ROOT } from "@localapp/dsh-document-tools/catalog";
import { DeepSeekHarness as PluginHarness } from "@localapp/dsh-agent-runtime/harness";
export { browserMessages, type HarnessInput } from "@localapp/dsh-agent-runtime/harness";
export class DeepSeekHarness extends PluginHarness {
  constructor(config: ConstructorParameters<typeof PluginHarness>[0]) {
    super({ ...config, publicSkillsRoot: config.publicSkillsRoot ?? process.env.LOCALAPP_PUBLIC_SKILLS_ROOT ?? DOCUMENT_SKILLS_ROOT });
  }
}
