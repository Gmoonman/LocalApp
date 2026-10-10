import { AgentSettingsStore as PluginSettingsStore } from "@localapp/dsh-multiuser/settings";
import { PUBLIC_AGENT_SKILLS } from "./public-agent-skills.js";
import { getDb, flushMetaDb } from "./meta-sqlite.js";
export * from "@localapp/dsh-multiuser/settings";

/** SQLite adapter for existing Server data; settings validation and encryption belong to the plugin. */
export class AgentSettingsStore extends PluginSettingsStore {
  constructor(dataDir: string) {
    getDb().run("CREATE TABLE IF NOT EXISTS agent_user_settings (user_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    flushMetaDb();
    super(dataDir, {
      users() {
        const stmt = getDb().prepare("SELECT user_id FROM agent_user_settings");
        try { const ids: string[] = []; while (stmt.step()) ids.push(String(stmt.getAsObject().user_id)); return ids; }
        finally { stmt.free(); }
      },
      read(userId) {
        const stmt = getDb().prepare("SELECT value FROM agent_user_settings WHERE user_id = ?");
        try { stmt.bind([userId]); return stmt.step() ? String(stmt.getAsObject().value) : undefined; }
        finally { stmt.free(); }
      },
      write(userId, value) {
        getDb().run("INSERT INTO agent_user_settings(user_id, value) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET value = excluded.value", [userId, value]);
        flushMetaDb();
      },
    }, PUBLIC_AGENT_SKILLS.map(skill => skill.id));
  }
}
