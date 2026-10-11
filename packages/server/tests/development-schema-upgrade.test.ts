import { expect, it } from "vitest";
import initSqlJs from "sql.js";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceStore } from "@localapp/dsh-app-development/workspace-store";
import { TaskStore } from "@localapp/dsh-app-development/task-store";

it("loads legacy tasks without process identity and preserves records after persistence and reload", async () => {
  const SQL = await initSqlJs();
  let db = new SQL.Database();
  let saved = new Uint8Array();
  try {
    db.run(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO workspaces VALUES ('workspace-old', 'owner-old', 'Existing workspace', '2026-01-01', '2026-01-02');
      CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, executable TEXT NOT NULL, args_json TEXT NOT NULL, timeout_ms INTEGER NOT NULL, requested_by TEXT NOT NULL, output_path TEXT NOT NULL, status TEXT NOT NULL, pid INTEGER, exit_code INTEGER, error TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL);
      INSERT INTO tasks VALUES ('task-old', 'workspace-old', 'build', 'node', '["build.js"]', 30000, 'owner-old', 'logs/task-old.log', 'completed', NULL, 0, NULL, '2026-01-01', '2026-01-01', '2026-01-02', '2026-01-02');`);
    const persistence = { database: () => db, flush: () => { saved = db.export(); } };
    const store = new TaskStore(persistence);
    expect(store.get("task-old")).toMatchObject({ workspaceId: "workspace-old", executable: "node", args: ["build.js"], status: "completed", exitCode: 0, processIdentity: null });
    expect(db.exec("SELECT * FROM workspaces")[0].values).toEqual([["workspace-old", "owner-old", "Existing workspace", "2026-01-01", "2026-01-02"]]);
    const originalTask = store.get("task-old");
    db.close(); db = new SQL.Database(saved);
    const reloaded = new TaskStore(persistence);
    expect(reloaded.get("task-old")).toEqual(originalTask);
    reloaded.create({ id: "task-new", workspaceId: "workspace-old", kind: "build", executable: "node", args: [], timeoutMs: 1000, requestedBy: "owner-old", outputPath: "logs/new.log", processIdentity: "new-process" });
    expect(reloaded.get("task-new")?.processIdentity).toBe("new-process");
    expect(reloaded.get("task-old")?.status).toBe("completed");
  } finally { db.close(); }
});

it("creates standalone workspaces and tasks in an empty database without account or platform tables", async () => {
  const parent = path.resolve(__dirname, "../../../tmp/standalone-development-schema");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "workspace-"));
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    const persistence = { database: () => db, flush: () => {} };
    const workspaces = new WorkspaceStore({ workspaceDir: root }, persistence);
    const workspace = await workspaces.create({ ownerId: "standalone-owner", name: "Standalone workspace" });
    expect(workspaces.list("standalone-owner")).toEqual([workspace]);
    expect(workspaces.list("different-owner")).toEqual([]);
    const tasks = new TaskStore(persistence);
    const task = tasks.create({ workspaceId: workspace.id, kind: "build", executable: "node", args: ["build.js"], timeoutMs: 1000, requestedBy: "standalone-owner", outputPath: "task.log" });
    expect(tasks.get(task.id)?.workspaceId).toBe(workspace.id);
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0].values.flat().sort();
    expect(tables).toEqual(["tasks", "workspaces"]);
  } finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
});
