import type { Database } from "sql.js";

/** Preserve existing workspaces and tasks while adding missing execution schema. */
export function initializeExecutionSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id, created_at DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      executable TEXT NOT NULL,
      args_json TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      requested_by TEXT NOT NULL,
      output_path TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      process_identity TEXT,
      exit_code INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requested_by, created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id, created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  const taskColumns = db.exec("PRAGMA table_info(tasks)")[0]?.values.map((row) => String(row[1])) ?? [];
  if (!taskColumns.includes("process_identity")) db.run("ALTER TABLE tasks ADD COLUMN process_identity TEXT");

}
