import { DOCUMENT_SKILLS_ROOT } from "@localapp/dsh-document-tools/catalog";
import type {} from "@deepseek-ai/dsh-bash-sandbox";
import type {} from "@deepseek-ai/dsh-user-questions";
import type {} from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-plan-mode";
import { mountHarnessCapabilities as mount } from "@localapp/dsh-agent-runtime/harness-capabilities";
export { mountApplicationFileSystem } from "@localapp/dsh-agent-runtime/harness-capabilities";
export async function mountHarnessCapabilities(...args: Parameters<typeof mount>) {
  const [ctx, root, capabilities, mcpServers, skills, python, development] = args;
  return mount(ctx, root, capabilities, mcpServers, skills, python, {
    ...development,
    publicSkillsRoot: development?.publicSkillsRoot ?? process.env.LOCALAPP_PUBLIC_SKILLS_ROOT ?? DOCUMENT_SKILLS_ROOT,
  });
}
