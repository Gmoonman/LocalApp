import { AgentSettingsStore as PluginSettingsStore, createSqliteSettingsPersistence } from "@localapp/dsh-multiuser/settings";
import { PUBLIC_AGENT_SKILLS } from "./public-agent-skills.js";
import { getDb, flushMetaDb } from "./meta-sqlite.js";
export * from "@localapp/dsh-multiuser/settings";
export function createAgentSettingsOptions(dataDir: string) {
  return [dataDir, createSqliteSettingsPersistence({ database: getDb, flush: flushMetaDb }),
    PUBLIC_AGENT_SKILLS.map(skill => skill.id)] as const;
}

/** Existing Server connection; schema, encryption and persistence belong to the plugin. */
export class AgentSettingsStore extends PluginSettingsStore {
  constructor(dataDir: string) {
    super(...createAgentSettingsOptions(dataDir));
  }
}
