import path from "node:path";
import { SystemEnvironment } from "@localapp/dsh-multiuser/system-environment";
import { PUBLIC_AGENT_SKILLS } from "./public-agent-skills.js";
export const systemEnvironment = new SystemEnvironment({ async createHarness(dataDir, pythonEnvironment) {
  const { DeepSeekHarness } = await import("./deepseek-harness.mjs");
  return new DeepSeekHarness({ llmApiKey: "", llmBaseUrl: "http://127.0.0.1:9", llmModel: "environment-check", root: path.join(dataDir, "agent", "system-environment"), capabilities: ["files", "terminal", "skills"], skills: PUBLIC_AGENT_SKILLS.map(skill => skill.id), pythonEnvironment });
} });
export const systemAgentEnvironment = systemEnvironment.check.bind(systemEnvironment);

export { publicSkillAvailability } from "@localapp/dsh-multiuser/public-skills";
