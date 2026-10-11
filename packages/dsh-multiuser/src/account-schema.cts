import type { AccountDatabase } from "./accounts.cjs";

/** Initialize account tables and upgrade existing rows without replacing them. */
export function initializeAccountSchema(db: AccountDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      creator_id TEXT NOT NULL,
      system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, user_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at)");

  // Add role column if missing (migrate existing databases)
  {
    const cols = db.prepare("PRAGMA table_info(users)");
    const colNames: string[] = [];
    while (cols.step()) {
      const row = cols.getAsObject() as { name: string };
      colNames.push(row.name);
    }
    cols.free();
    if (!colNames.includes("role")) {
      db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    }
    if (!colNames.includes("display_name")) {
      db.run("ALTER TABLE users ADD COLUMN display_name TEXT");
    }
    if (!colNames.includes("avatar_url")) {
      db.run("ALTER TABLE users ADD COLUMN avatar_url TEXT");
    }
    if (!colNames.includes("bio")) {
      db.run("ALTER TABLE users ADD COLUMN bio TEXT");
    }
    if (!colNames.includes("must_change_password")) {
      db.run("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
    }
    if (!colNames.includes("auth_version")) {
      db.run("ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0");
    }
    if (!colNames.includes("auth_generation")) {
      db.run("ALTER TABLE users ADD COLUMN auth_generation TEXT");
    }
    db.run("UPDATE users SET auth_generation = lower(hex(randomblob(16))) WHERE auth_generation IS NULL OR auth_generation = ''");
  }
}
