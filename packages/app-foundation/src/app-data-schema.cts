import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { applyPendingMigrations } from "./migrations.cjs";
import { AppDataError } from "./app-data-errors.cjs";

type SqlJsDatabase = initSqlJs.Database;
type SchemaItem = Record<string, unknown>;
type TableDescription = {
  columns: SchemaItem[];
  indexes: SchemaItem[];
  foreignKeys: SchemaItem[];
};

function rows(db: SqlJsDatabase, sql: string): Array<Record<string, unknown>> {
  const statement = db.prepare(sql);
  const values: Array<Record<string, unknown>> = [];
  try {
    while (statement.step()) values.push(statement.getAsObject());
    return values;
  } finally {
    statement.free();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function schemaDescription(db: SqlJsDatabase): Record<string, unknown> {
  const tables = rows(db, "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_localapp_migrations', '_localapp_applied_migrations') ORDER BY name");
  const indexDefinitions = new Map(rows(db, "SELECT name, sql FROM sqlite_master WHERE type = 'index'").map((index) => [String(index.name), index.sql]));
  const description: Record<string, unknown> = {};
  for (const table of tables) {
    const name = String(table.name);
    const columns = rows(db, `PRAGMA table_info(${quoteIdentifier(name)})`).map((column) => ({
      name: String(column.name),
      type: String(column.type ?? "").toUpperCase(),
      notnull: Number(column.notnull),
      defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
      primaryKey: Number(column.pk),
    }));
    const indexes = rows(db, `PRAGMA index_list(${quoteIdentifier(name)})`)
      .filter((index) => String(index.origin) !== "pk")
      .map((index) => ({
        name: String(index.name),
        unique: Number(index.unique),
        partial: Number(index.partial),
        columns: rows(db, `PRAGMA index_info(${quoteIdentifier(String(index.name))})`).map((column) => String(column.name)),
        predicate: Number(index.partial)
          ? String(indexDefinitions.get(String(index.name)) ?? "").match(/\bWHERE\b([\s\S]*)$/i)?.[1]?.trim().replace(/\s+/g, " ") ?? null
          : null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const foreignKeys = rows(db, `PRAGMA foreign_key_list(${quoteIdentifier(name)})`)
      .map((foreignKey) => ({
        table: String(foreignKey.table),
        from: String(foreignKey.from),
        to: String(foreignKey.to),
        onUpdate: String(foreignKey.on_update),
        onDelete: String(foreignKey.on_delete),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    description[name] = { columns, indexes, foreignKeys };
  }
  return description;
}

async function openDatabase(dbPath: string): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();
  try {
    return new SQL.Database(fs.readFileSync(dbPath));
  } catch (caught) {
    throw new AppDataError("APP_DATABASE_INVALID", `Cannot open SQLite database: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

export async function readForeignKeyViolations(dbPath:string):Promise<string[]> {
  const db=await openDatabase(dbPath);
  try{return rows(db,"PRAGMA foreign_key_check").map(row=>JSON.stringify(row)).sort();}finally{db.close();}
}
function assertDatabaseIntegrity(db: SqlJsDatabase, allowedForeignKeyViolations:readonly string[] = []): void {
  const integrity = rows(db, "PRAGMA integrity_check");
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new AppDataError("APP_DATABASE_INVALID", "SQLite integrity check failed");
  }
  const foreignKeys = rows(db, "PRAGMA foreign_key_check");
  if (foreignKeys.some(row=>!allowedForeignKeyViolations.includes(JSON.stringify(row)))) {
    throw new AppDataError("APP_DATABASE_FOREIGN_KEY_INVALID", "SQLite foreign key check failed");
  }
}

function containsStructure(actual: SchemaItem[], expected: SchemaItem): boolean {
  return actual.some((item) => JSON.stringify(item) === JSON.stringify(expected));
}

function assertRequiredSchema(candidate: Record<string, unknown>, reference: Record<string, unknown>): void {
  for (const [tableName, expected] of Object.entries(reference)) {
    const actual = candidate[tableName] as TableDescription | undefined;
    const required = expected as TableDescription;
    const compatible = actual
      && required.columns.every((column) => containsStructure(actual.columns, column))
      && required.indexes.every((index) => containsStructure(actual.indexes, index))
      && required.foreignKeys.every((foreignKey) => containsStructure(actual.foreignKeys, foreignKey));
    if (!compatible) {
      throw new AppDataError("APP_DATABASE_SCHEMA_INCOMPATIBLE", `Database structure is incompatible at table ${tableName}`);
    }
  }
}

export async function computeSchemaFingerprint(dbPath: string): Promise<string> {
  const db = await openDatabase(dbPath);
  try {
    const description = schemaDescription(db);
    return crypto.createHash("sha256").update(JSON.stringify(description)).digest("hex");
  } finally {
    db.close();
  }
}

export async function validateCandidateSchema(input: {
  candidatePath: string;
  migrationsDir: string;
  archiveVersion?: number;
  currentVersion?: number;
  allowedForeignKeyViolations?:readonly string[];
}): Promise<{ schemaFingerprint: string }> {
  const referencePath = path.join(path.dirname(input.candidatePath), `.schema-reference-${crypto.randomUUID()}.db`);
  try {
    await applyPendingMigrations({ dbPath: referencePath, migrationsDir: input.migrationsDir });
    const candidate = await openDatabase(input.candidatePath);
    const reference = await openDatabase(referencePath);
    try {
      assertDatabaseIntegrity(candidate,input.allowedForeignKeyViolations);
      assertRequiredSchema(schemaDescription(candidate), schemaDescription(reference));
      return {
        schemaFingerprint: crypto.createHash("sha256").update(JSON.stringify(schemaDescription(candidate))).digest("hex"),
      };
    } finally {
      candidate.close();
      reference.close();
    }
  } finally {
    fs.rmSync(referencePath, { force: true });
  }
}
