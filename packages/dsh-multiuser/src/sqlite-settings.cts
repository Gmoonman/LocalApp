import type { GroupDatabase } from "./groups.cjs";
import type { SettingsPersistence } from "./settings.cjs";

export function createSqliteSettingsPersistence(host: { database(): GroupDatabase; flush(): void }): SettingsPersistence {
  host.database().run("CREATE TABLE IF NOT EXISTS agent_user_settings (user_id TEXT PRIMARY KEY, value TEXT NOT NULL)", []);
  host.flush();
  return {
    users() {
      const stmt = host.database().prepare("SELECT user_id FROM agent_user_settings");
      try { const ids: string[] = []; while (stmt.step()) ids.push(String(stmt.getAsObject().user_id)); return ids; }
      finally { stmt.free(); }
    },
    read(userId) {
      const stmt = host.database().prepare("SELECT value FROM agent_user_settings WHERE user_id = ?");
      try { stmt.bind([userId]); return stmt.step() ? String(stmt.getAsObject().value) : undefined; }
      finally { stmt.free(); }
    },
    write(userId, value) {
      host.database().run("INSERT INTO agent_user_settings(user_id, value) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET value = excluded.value", [userId, value]);
      host.flush();
    },
  };
}
