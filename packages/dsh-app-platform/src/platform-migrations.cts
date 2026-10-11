import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { validateMigrationFilenames } from "./migrations.cjs";
import { readPageMeta, writePageMeta } from "./page-storage.cjs";

const PLATFORM_TABLES = new Set(["users", "groups", "roles"]);

type PlatformMigrationFile = {
  filename: string;
  sql: string;
  checksum: string;
};

export type ApplyPlatformMigrationsOptions = {
  dataDir: string;
  migrationsDir: string;
  logger?: Pick<Console, "warn">;
};

let SqlJs: initSqlJs.SqlJsStatic | null = null;

async function getSqlJs(): Promise<initSqlJs.SqlJsStatic> {
  if (!SqlJs) {
    SqlJs = await initSqlJs();
  }
  return SqlJs;
}

export async function applyPlatformMigrationsToAllApps(options: ApplyPlatformMigrationsOptions): Promise<void> {
  const migrationsDir = options.migrationsDir;
  const migrations = readPlatformMigrationFiles(migrationsDir);
  if (migrations.length === 0 || !fs.existsSync(options.dataDir)) return;

  for (const { userId, pageName, pageDir } of listAppDirs(options.dataDir)) {
    try {
      await applyPlatformMigrationsToApp(path.join(pageDir, "app.db"), migrations);
    } catch (error) {
      options.logger?.warn(`Failed to apply platform migration to ${userId}/${pageName}: ${(error as Error).message}`);
      const meta = readPageMeta(options.dataDir, userId, pageName);
      if (meta) {
        meta.status = "needs-migration-repair";
        writePageMeta(options.dataDir, userId, pageName, meta);
      }
    }
  }
}

function readPlatformMigrationFiles(migrationsDir: string): PlatformMigrationFile[] {
  if (!fs.existsSync(migrationsDir)) return [];

  const filenames = fs.readdirSync(migrationsDir).filter((filename) => filename.endsWith(".sql"));
  const validation = validateMigrationFilenames(filenames);
  if (!validation.valid) {
    throw new Error(validation.errors.join("\n"));
  }

  return filenames.sort().map((filename) => {
    const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
    return {
      filename,
      sql,
      checksum: crypto.createHash("sha256").update(sql).digest("hex"),
    };
  });
}

async function applyPlatformMigrationsToApp(dbPath: string, migrations: PlatformMigrationFile[]): Promise<void> {
  if (!fs.existsSync(dbPath)) return;

  const SQL = await getSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const applied: string[] = [];

  try {
    ensureAppliedPlatformMigrationsTable(db);
    const appliedChecksums = getAppliedChecksums(db);

    for (const migration of migrations) {
      assertPlatformOnlySql(migration.filename, migration.sql);
      const existingChecksum = appliedChecksums.get(migration.filename);
      if (existingChecksum === migration.checksum) continue;
      if (existingChecksum) {
        throw new Error(`Platform migration ${migration.filename} was modified after being applied`);
      }

      db.run("BEGIN");
      try {
        db.run(migration.sql);
        db.run(
          "INSERT INTO _localapp_applied_platform_migrations (filename, checksum, applied_at) VALUES (?, ?, ?)",
          [migration.filename, migration.checksum, new Date().toISOString()],
        );
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
      applied.push(migration.filename);
    }

    if (applied.length > 0) {
      fs.writeFileSync(dbPath, Buffer.from(db.export()));
    }
  } finally {
    db.close();
  }
}

function ensureAppliedPlatformMigrationsTable(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS _localapp_applied_platform_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function getAppliedChecksums(db: SqlJsDatabase): Map<string, string> {
  const rows = db.exec(
    "SELECT filename, checksum FROM _localapp_applied_platform_migrations",
  )[0]?.values ?? [];
  return new Map(rows.map(([filename, existingChecksum]) => [
    String(filename),
    String(existingChecksum),
  ]));
}

function listAppDirs(dataDir: string): Array<{ userId: string; pageName: string; pageDir: string }> {
  const apps: Array<{ userId: string; pageName: string; pageDir: string }> = [];
  for (const userEntry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) continue;
    const userDir = path.join(dataDir, userEntry.name);
    for (const pageEntry of fs.readdirSync(userDir, { withFileTypes: true })) {
      if (!pageEntry.isDirectory()) continue;
      const pageDir = path.join(userDir, pageEntry.name);
      if (fs.existsSync(path.join(pageDir, "meta.json"))) {
        apps.push({ userId: userEntry.name, pageName: pageEntry.name, pageDir });
      }
    }
  }
  return apps;
}

function assertPlatformOnlySql(filename: string, sql: string): void {
  const normalized = sql.replace(/--.*$/gm, " ");
  const tablePatterns = [
    /\bALTER\s+TABLE\s+["`[]?([\w-]+)/gi,
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([\w-]+)/gi,
    /\bINSERT\s+INTO\s+["`[]?([\w-]+)/gi,
    /\bUPDATE\s+["`[]?([\w-]+)/gi,
    /\bDELETE\s+FROM\s+["`[]?([\w-]+)/gi,
    /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`[]?([\w-]+)/gi,
  ];

  for (const pattern of tablePatterns) {
    for (const match of normalized.matchAll(pattern)) {
      const table = String(match[1]).replace(/["`\]]/g, "");
      if (!PLATFORM_TABLES.has(table)) {
        throw new Error(`Platform migration ${filename} may only modify platform tables`);
      }
    }
  }
}
