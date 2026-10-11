import { DOCUMENT_SKILLS_ROOT } from "@localapp/dsh-document-tools/catalog";
import { preparePublicSkills as prepare } from "@localapp/dsh-multiuser/public-skills";
export { PUBLIC_AGENT_SKILLS } from "@localapp/dsh-multiuser/public-skills";
export function preparePublicSkills(workspace: string, selected: string[]) {
  return prepare(workspace, selected, process.env.LOCALAPP_PUBLIC_SKILLS_ROOT ?? DOCUMENT_SKILLS_ROOT);
}
