import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs, { Database as SqlJsDatabase } from "sql.js";

type MigrationFile = {
  index: number;
  filename: string;
  sql: string;
  checksum: string;
};

export type MigrationValidationResult = {
  valid: boolean;
  errors: string[];
};

export type ApplyPendingMigrationsOptions = {
  dbPath: string;
  migrationsDir: string;
  beforeApply?: (pending: string[]) => void;
};

export type ApplyPendingMigrationsResult = {
  applied: string[];
  skipped: string[];
};

export class MigrationApplyError extends Error {
  constructor(
    public readonly filename: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Migration ${filename} failed: ${message}`, options);
    this.name = "MigrationApplyError";
  }
}

let SqlJs: initSqlJs.SqlJsStatic | null = null;

async function getSqlJs(): Promise<initSqlJs.SqlJsStatic> {
  if (!SqlJs) {
    SqlJs = await initSqlJs();
  }
  return SqlJs;
}

function checksum(sql: string): string {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

function parseMigrationIndex(filename: string): number | null {
  const match = filename.match(/^(\d{3})_[^/\\]+\.sql$/);
  if (!match) return null;
  const index = Number(match[1]);
  return index >= 1 ? index : null;
}

export function validateMigrationFilenames(filenames: string[]): MigrationValidationResult {
  const errors: string[] = [];
  const seen = new Map<number, string>();

  for (const filename of filenames) {
    const index = parseMigrationIndex(filename);
    if (index === null) {
      errors.push(`Invalid migration filename: ${filename}`);
      continue;
    }

    const existing = seen.get(index);
    if (existing) {
      errors.push(`Duplicate migration number ${String(index).padStart(3, "0")}: ${existing}, ${filename}`);
    } else {
      seen.set(index, filename);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function ensureAppliedMigrationsTable(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS _localapp_applied_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const legacyTable = db.exec(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_localapp_migrations'",
  )[0]?.values[0];
  if (legacyTable) {
    db.run(`
      INSERT OR IGNORE INTO _localapp_applied_migrations(filename, checksum, applied_at)
      SELECT filename, checksum, CAST(applied_at AS TEXT)
      FROM _localapp_migrations
    `);
  }
}

function getAppliedChecksums(db: SqlJsDatabase): Map<string, string> {
  ensureAppliedMigrationsTable(db);
  const rows = db.exec(
    "SELECT filename, checksum FROM _localapp_applied_migrations",
  )[0]?.values ?? [];
  return new Map(rows.map(([filename, existingChecksum]) => [
    String(filename),
    String(existingChecksum),
  ]));
}

function readMigrationFiles(migrationsDir: string): MigrationFile[] {
  if (!fs.existsSync(migrationsDir)) return [];

  const filenames = fs
    .readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith(".sql"));
  const validation = validateMigrationFilenames(filenames);
  if (!validation.valid) {
    throw new Error(validation.errors.join("\n"));
  }

  return filenames
    .map((filename) => ({
      index: parseMigrationIndex(filename)!,
      filename,
    }))
    .sort((a, b) => a.index - b.index)
    .map(({ index, filename }) => {
      const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
      return { index, filename, sql, checksum: checksum(sql) };
    });
}

export function getPendingMigrations(
  migrationsDir: string,
  db: SqlJsDatabase,
): MigrationFile[] {
  const appliedChecksums = getAppliedChecksums(db);
  const pending: MigrationFile[] = [];

  for (const migration of readMigrationFiles(migrationsDir)) {
    const existingChecksum = appliedChecksums.get(migration.filename);
    if (!existingChecksum) {
      pending.push(migration);
      continue;
    }
    if (existingChecksum !== migration.checksum) {
      throw new Error(`Migration ${migration.filename} was modified after being applied`);
    }
  }

  return pending;
}

function assertSafeMigrationSql(filename: string, sql: string): void {
  if (/\b(?:ATTACH|DETACH)\s+DATABASE\b/i.test(sql)) {
    throw new Error(`Migration ${filename} contains ATTACH/DETACH which breaks transaction`);
  }
  if (/\bPRAGMA\s+journal_mode\b/i.test(sql)) {
    throw new Error(`Migration ${filename} contains PRAGMA journal_mode which breaks transaction`);
  }
}

export function applyMigration(
  db: SqlJsDatabase,
  filename: string,
  sql: string,
): void {
  ensureAppliedMigrationsTable(db);
  assertSafeMigrationSql(filename, sql);

  const migrationChecksum = checksum(sql);
  const existingChecksum = getAppliedChecksums(db).get(filename);
  if (existingChecksum) {
    if (existingChecksum !== migrationChecksum) {
      throw new Error(`Migration ${filename} was modified after being applied`);
    }
    return;
  }

  db.run("BEGIN");
  try {
    db.run(sql);
    db.run(
      "INSERT INTO _localapp_applied_migrations (filename, checksum, applied_at) VALUES (?, ?, ?)",
      [filename, migrationChecksum, new Date().toISOString()],
    );
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

export async function applyPendingMigrations(
  options: ApplyPendingMigrationsOptions,
): Promise<ApplyPendingMigrationsResult> {
  const SQL = await getSqlJs();
  const db = fs.existsSync(options.dbPath)
    ? new SQL.Database(fs.readFileSync(options.dbPath))
    : new SQL.Database();

  const applied: string[] = [];

  try {
    const pendingMigrations = getPendingMigrations(options.migrationsDir, db);
    if (pendingMigrations.length > 0) {
      options.beforeApply?.(pendingMigrations.map((migration) => migration.filename));
    }
    for (const migration of pendingMigrations) {
      try {
        applyMigration(db, migration.filename, migration.sql);
      } catch (error) {
        throw new MigrationApplyError(
          migration.filename,
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
      applied.push(migration.filename);
    }

    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    fs.writeFileSync(options.dbPath, Buffer.from(db.export()));
    return { applied, skipped: [] };
  } finally {
    db.close();
  }
}
