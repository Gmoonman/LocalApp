import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import type { Readable } from "node:stream";
import { applyPendingMigrations } from "./migrations.cjs";
import { closeConnectionsForPage } from "./app-db.cjs";
import {
  createDataArchive,
  extractAndValidateDataArchive,
  type AppDataArchiveManifest,
  type ArchiveLimits,
} from "./app-data-archive.cjs";
import { AppDataError } from "./app-data-errors.cjs";
import { withAppDataMaintenance } from "./app-data-maintenance.cjs";
import { validateCandidateSchema } from "./app-data-schema.cjs";
import {
  resolveApplicationMigrationsDir,
  VersionMigrationSnapshotError,
} from "./app-version-migrations.cjs";
import {
  deleteObject,
  getObject,
  listAppObjects,
  openObject,
  putObject,
  putObjectFromFile,
  type StoredObjectInfo,
} from "./content-storage.cjs";

export type AppDataIdentity = { owner: string; name: string; version: number };

export type AppDataStorage = {
  listAppObjects(owner: string, appName: string): Promise<StoredObjectInfo[]>;
  getObject(key: string): Promise<{ body: Buffer; contentType?: string } | null>;
  openObject(key: string): Promise<{ body: Readable; contentType?: string } | null>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  putObjectFromFile(key: string, filePath: string, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
};

export type AppBackupSource = "manual" | "automatic";
export type AppBackupFormat = "zip" | "legacy-db";

export type AppBackup = {
  id: string;
  name: string;
  createdAt: string;
  size: number;
  source: AppBackupSource;
  format: AppBackupFormat;
  fileCount: number;
  fileSize: number;
  reason?: string;
};

const defaultStorage: AppDataStorage = { listAppObjects, getObject, openObject, putObject, putObjectFromFile, deleteObject };
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxCompressedBytes: 2 * 1024 * 1024 * 1024,
  maxExpandedBytes: 4 * 1024 * 1024 * 1024,
  maxFileEntries: 10_000,
};

function operationDir(pageDir: string): string {
  return path.join(pageDir, ".data-operations");
}

function backupDir(pageDir: string): string {
  return path.join(pageDir, "backups");
}

function backupDataPath(pageDir: string, id: string, format: AppBackupFormat): string {
  return path.join(backupDir(pageDir), `${id}.${format === "zip" ? "zip" : "db"}`);
}

function backupMetaPath(pageDir: string, id: string): string {
  return path.join(backupDir(pageDir), `${id}.json`);
}

async function currentMigrationsDir(pageDir: string, application: AppDataIdentity): Promise<string> {
  try {
    return await resolveApplicationMigrationsDir(pageDir, application);
  } catch (error) {
    if (error instanceof VersionMigrationSnapshotError) {
      throw new AppDataError(error.code, error.message);
    }
    throw error;
  }
}

export function isAppBackupId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function atomicWrite(filePath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, bytes, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function normalizeBackupName(name: string | undefined, fallback: string): string {
  const normalized = name?.trim() || fallback;
  if (normalized.length > 80) throw new AppDataError("APP_BACKUP_NAME_INVALID", "Backup name must not exceed 80 characters");
  return normalized;
}

export function inferAppDataIdentity(pageDir: string): AppDataIdentity {
  let version = 0;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(pageDir, "meta.json"), "utf8")) as { currentVersion?: unknown };
    if (Number.isInteger(meta.currentVersion) && Number(meta.currentVersion) >= 0) version = Number(meta.currentVersion);
  } catch {
    // Tests and legacy pages can operate without metadata.
  }
  return { owner: path.basename(path.dirname(pageDir)), name: path.basename(pageDir), version };
}

async function createArchiveAt(input: {
  pageDir: string;
  application: AppDataIdentity;
  sourceApplication?: Pick<AppDataIdentity, "owner" | "name">;
  outputPath: string;
  limits: ArchiveLimits;
  storage: AppDataStorage;
}) {
  closeConnectionsForPage(input.pageDir);
  const sourceDatabasePath = path.join(input.pageDir, "app.db");
  if (!fs.existsSync(sourceDatabasePath)) throw new AppDataError("APP_DATABASE_NOT_FOUND", "Application database does not exist");
  const sourceApplication = input.sourceApplication ?? input.application;
  const objects = await input.storage.listAppObjects(sourceApplication.owner, sourceApplication.name);
  const crossOwner = sourceApplication.owner !== input.application.owner || sourceApplication.name !== input.application.name;
  const databasePath = crossOwner
    ? path.join(operationDir(input.pageDir), `export-database-${crypto.randomUUID()}.db`)
    : sourceDatabasePath;
  try {
    if (crossOwner) {
      fs.copyFileSync(sourceDatabasePath, databasePath);
      await rebaseDatabaseReferences(databasePath, {
        sourceApplication,
        targetApplication: input.application,
        objectMappings: objects.map((object) => ({
          source: object.key,
          target: rebaseObjectKey(object.key, sourceApplication, input.application),
        })),
        identityColumns: declaredIdentityColumns(input.pageDir, input.application.version),
      });
    }
    return await createDataArchive({
      outputPath: input.outputPath,
      databasePath,
      application: input.application,
      sourceApplication,
      objects,
      openObject: input.storage.openObject,
      limits: input.limits,
    });
  } finally {
    if (crossOwner) fs.rmSync(databasePath, { force: true });
  }
}

function rebaseObjectKey(
  key: string,
  source: Pick<AppDataIdentity, "owner" | "name">,
  target: Pick<AppDataIdentity, "owner" | "name">,
): string {
  const appPrefix = `${source.owner}/${source.name}/`;
  const issuePrefix = `issues/${source.owner}/${source.name}/`;
  if (key.startsWith(appPrefix)) return `${target.owner}/${target.name}/${key.slice(appPrefix.length)}`;
  if (key.startsWith(issuePrefix)) return `issues/${target.owner}/${target.name}/${key.slice(issuePrefix.length)}`;
  throw new AppDataError("APP_ARCHIVE_OBJECT_KEY_INVALID", `Object key is outside the application namespace: ${key}`);
}

function declaredIdentityColumns(pageDir: string, version: number): Array<{ table: string; column: string }> {
  const resourcesDir = path.join(pageDir, "versions", `v${version}`, "backend", "resources");
  if (!fs.existsSync(resourcesDir)) return [];
  const result = new Map<string, { table: string; column: string }>();
  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const resourceDir = path.join(resourcesDir, entry.name);
    const schemaPath = path.join(resourceDir, "schema.json");
    try {
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
        name?: unknown;
        business?: { ownerField?: unknown };
      };
      if (typeof schema.name !== "string") throw new Error("resource name is missing");
      const ownerField = typeof schema.business?.ownerField === "string" ? schema.business.ownerField : undefined;
      if (ownerField) result.set(`${schema.name}\0${ownerField}`, { table: schema.name, column: ownerField });
      for (const contractName of ["queries.json", "mutations.json"] as const) {
        const contractPath = path.join(resourceDir, contractName);
        if (!fs.existsSync(contractPath)) continue;
        const contract = JSON.parse(fs.readFileSync(contractPath, "utf8")) as Record<string, unknown>;
        const definitions = contract[contractName === "queries.json" ? "queries" : "mutations"];
        if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) continue;
        for (const definition of Object.values(definitions)) {
          if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
          const record = definition as Record<string, unknown>;
          const security = record.security && typeof record.security === "object" && !Array.isArray(record.security)
            ? record.security as Record<string, unknown>
            : {};
          const config = security.config && typeof security.config === "object" && !Array.isArray(security.config)
            ? security.config as Record<string, unknown>
            : {};
          if (security.mode === "generated" && typeof config.identityField === "string") {
            result.set(`${schema.name}\0${config.identityField}`, { table: schema.name, column: config.identityField });
          }
          const systemParams = Array.isArray(security.systemParams) ? security.systemParams : [];
          const dependsOnCurrentUser = systemParams.includes("currentUserId")
            || (typeof record.sql === "string" && record.sql.includes(":currentUserId"));
          if (security.mode === "custom" && dependsOnCurrentUser && !ownerField) {
            throw new AppDataError(
              "APP_DATA_IDENTITY_CONTRACT_REQUIRED",
              `Resource ${schema.name} must declare business.ownerField before cross-owner data synchronization`,
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof AppDataError) throw error;
      throw new AppDataError("APP_DATA_IDENTITY_CONTRACT_INVALID", `Cannot read identity contract for resource ${entry.name}`);
    }
  }
  return [...result.values()];
}

async function createManagedBackupUnlocked(input: {
  pageDir: string;
  application: AppDataIdentity;
  limits: ArchiveLimits;
  storage: AppDataStorage;
  name?: string;
  source: AppBackupSource;
  reason?: string;
}): Promise<AppBackup> {
  const id = crypto.randomUUID();
  const outputPath = backupDataPath(input.pageDir, id, "zip");
  const created = await createArchiveAt({ ...input, outputPath });
  const backup: AppBackup = {
    id,
    name: normalizeBackupName(input.name, input.source === "manual" ? "Manual backup" : `Safety backup before ${input.reason ?? "data operation"}`),
    createdAt: new Date().toISOString(),
    size: created.archiveSize,
    source: input.source,
    format: "zip",
    fileCount: created.manifest.files.length,
    fileSize: created.manifest.files.reduce((total, file) => total + file.size, 0),
    ...(input.reason ? { reason: input.reason } : {}),
  };
  try {
    atomicWrite(backupMetaPath(input.pageDir, id), Buffer.from(`${JSON.stringify(backup, null, 2)}\n`));
  } catch (caught) {
    fs.rmSync(outputPath, { force: true });
    throw caught;
  }
  return backup;
}

function readBackupMetadata(pageDir: string, id: string): AppBackup | null {
  if (!isAppBackupId(id)) return null;
  const metaPath = backupMetaPath(pageDir, id);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const stored = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Partial<AppBackup>;
    if (stored.id !== id || typeof stored.name !== "string" || typeof stored.createdAt !== "string" || (stored.source !== "manual" && stored.source !== "automatic")) return null;
    const format: AppBackupFormat = fs.existsSync(backupDataPath(pageDir, id, "zip")) ? "zip" : "legacy-db";
    const dataPath = backupDataPath(pageDir, id, format);
    if (!fs.existsSync(dataPath)) return null;
    return {
      id,
      name: stored.name,
      createdAt: stored.createdAt,
      size: fs.statSync(dataPath).size,
      source: stored.source,
      format,
      fileCount: format === "zip" && Number.isInteger(stored.fileCount) ? Number(stored.fileCount) : 0,
      fileSize: format === "zip" && Number.isFinite(stored.fileSize) ? Number(stored.fileSize) : 0,
      ...(typeof stored.reason === "string" ? { reason: stored.reason } : {}),
    };
  } catch {
    return null;
  }
}

export function listAppBackups(pageDir: string): AppBackup[] {
  const directory = backupDir(pageDir);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => readBackupMetadata(pageDir, filename.slice(0, -5)))
    .filter((backup): backup is AppBackup => backup !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function swapDatabaseFile(pageDir: string, candidatePath: string): void {
  closeConnectionsForPage(pageDir);
  fs.mkdirSync(pageDir, { recursive: true });
  const targetPath = path.join(pageDir, "app.db");
  const token = crypto.randomUUID();
  const stagedPath = path.join(pageDir, `.app.db.${token}.candidate`);
  const previousPath = path.join(pageDir, `.app.db.${token}.previous`);
  try {
    fs.copyFileSync(candidatePath, stagedPath);
    if (fs.existsSync(targetPath)) fs.renameSync(targetPath, previousPath);
    fs.renameSync(stagedPath, targetPath);
    fs.rmSync(previousPath, { force: true });
  } catch (caught) {
    fs.rmSync(targetPath, { force: true });
    if (fs.existsSync(previousPath)) fs.renameSync(previousPath, targetPath);
    throw caught;
  } finally {
    fs.rmSync(stagedPath, { force: true });
    if (fs.existsSync(previousPath) && !fs.existsSync(targetPath)) fs.renameSync(previousPath, targetPath);
    else fs.rmSync(previousPath, { force: true });
  }
}

async function applyPreparedData(input: {
  pageDir: string;
  application: AppDataIdentity;
  databasePath: string;
  files: Array<{ path: string; objectKey: string; contentType?: string }>;
  storage: AppDataStorage;
}): Promise<void> {
  const current = await input.storage.listAppObjects(input.application.owner, input.application.name);
  const desiredKeys = new Set(input.files.map((file) => file.objectKey));
  for (const file of input.files) {
    await input.storage.putObjectFromFile(file.objectKey, file.path, file.contentType ?? "application/octet-stream");
  }
  swapDatabaseFile(input.pageDir, input.databasePath);
  for (const object of current) {
    if (!desiredKeys.has(object.key)) await input.storage.deleteObject(object.key);
  }
}

async function prepareArchive(input: {
  pageDir: string;
  application: AppDataIdentity;
  archivePath: string;
  stagingDir: string;
  limits: ArchiveLimits;
}) {
  const prepared = await extractAndValidateDataArchive({
    archivePath: input.archivePath,
    stagingDir: input.stagingDir,
    expectedApplication: { owner: input.application.owner, name: input.application.name },
    limits: input.limits,
  });
  await rebaseCandidateDatabase(prepared.databasePath, prepared.manifest, declaredIdentityColumns(input.pageDir, input.application.version));
  await validateCandidateSchema({
    candidatePath: prepared.databasePath,
    migrationsDir: await currentMigrationsDir(input.pageDir, input.application),
  });
  return prepared;
}

async function rebaseCandidateDatabase(
  databasePath: string,
  manifest: AppDataArchiveManifest,
  identityColumns: Array<{ table: string; column: string }>,
): Promise<void> {
  const source = manifest.sourceApplication ?? manifest.application;
  const target = manifest.application;
  if (source.owner === target.owner && source.name === target.name && identityColumns.length === 0) return;
  await rebaseDatabaseReferences(databasePath, {
    sourceApplication: source,
    targetApplication: target,
    objectMappings: manifest.files.flatMap((file) => file.sourceObjectKey
      ? [{ source: file.sourceObjectKey, target: file.objectKey }]
      : []),
    identityColumns,
  });
}

async function rebaseDatabaseReferences(
  databasePath: string,
  input: {
    sourceApplication: { owner: string; name: string };
    targetApplication: { owner: string; name: string };
    objectMappings: Array<{ source: string; target: string }>;
    identityColumns: Array<{ table: string; column: string }>;
  },
): Promise<void> {
  const replacements = new Map<string, string>();
  for (const mapping of input.objectMappings) {
    replacements.set(mapping.source, mapping.target);
    const sourcePrefix = `${input.sourceApplication.owner}/${input.sourceApplication.name}/`;
    const targetPrefix = `${input.targetApplication.owner}/${input.targetApplication.name}/`;
    if (mapping.source.startsWith(sourcePrefix) && mapping.target.startsWith(targetPrefix)) {
      replacements.set(
        `/serve/${sourcePrefix}api/content/${mapping.source.slice(sourcePrefix.length)}`,
        `/serve/${targetPrefix}api/content/${mapping.target.slice(targetPrefix.length)}`,
      );
    }
  }
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(databasePath));
  try {
    const result = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    const tables = (result[0]?.values ?? []).map((row) => String(row[0]));
    db.run("BEGIN IMMEDIATE");
    try {
      for (const table of tables) {
        const columns = db.exec(`PRAGMA table_info(${quoteSqlIdentifier(table)})`)[0]?.values ?? [];
        for (const column of columns) {
          const name = String(column[1]);
          const declaredType = String(column[2]).toUpperCase();
          if (declaredType.length > 0 && !declaredType.includes("TEXT") && !declaredType.includes("CHAR") && !declaredType.includes("CLOB")) continue;
          const tableId = quoteSqlIdentifier(table);
          const columnId = quoteSqlIdentifier(name);
          const values = db.exec(`SELECT DISTINCT ${columnId} FROM ${tableId} WHERE typeof(${columnId}) = 'text'`)[0]?.values ?? [];
          for (const row of values) {
            const current = String(row[0]);
            const next = rebaseTextValue(current, replacements);
            if (next !== current) db.run(`UPDATE ${tableId} SET ${columnId} = ? WHERE ${columnId} = ?`, [next, current]);
          }
        }
      }
      for (const identity of input.identityColumns) {
        const tableId = quoteSqlIdentifier(identity.table);
        const columnId = quoteSqlIdentifier(identity.column);
        db.run(`UPDATE ${tableId} SET ${columnId} = ? WHERE ${columnId} IS NOT NULL`, [input.targetApplication.owner]);
      }
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
    fs.writeFileSync(databasePath, Buffer.from(db.export()), { mode: 0o600 });
  } finally {
    db.close();
  }
}

function rebaseTextValue(value: string, replacements: ReadonlyMap<string, string>): string {
  const exact = replacements.get(value);
  if (exact !== undefined) return exact;
  const candidate = value.trimStart();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return value;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    const rebased = rebaseJsonValue(parsed, replacements);
    return rebased.changed ? JSON.stringify(rebased.value) : value;
  } catch {
    return value;
  }
}

function rebaseJsonValue(value: unknown, replacements: ReadonlyMap<string, string>): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const next = replacements.get(value);
    return next === undefined ? { value, changed: false } : { value: next, changed: true };
  }
  if (Array.isArray(value)) {
    const children = value.map((entry) => rebaseJsonValue(entry, replacements));
    return { value: children.map((entry) => entry.value), changed: children.some((entry) => entry.changed) };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const entries = Object.entries(value).map(([key, entry]) => {
      const child = rebaseJsonValue(entry, replacements);
      changed ||= child.changed;
      return [key, child.value];
    });
    return { value: Object.fromEntries(entries), changed };
  }
  return { value, changed: false };
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function createAppDataExport(input: {
  pageDir: string;
  application: AppDataIdentity;
  archiveApplication?: AppDataIdentity;
  limits?: ArchiveLimits;
  storage?: AppDataStorage;
}): Promise<{ archivePath: string; cleanup: () => void }> {
  const limits = input.limits ?? DEFAULT_ARCHIVE_LIMITS;
  const storage = input.storage ?? defaultStorage;
  return withAppDataMaintenance(input.pageDir, async () => {
    fs.mkdirSync(operationDir(input.pageDir), { recursive: true });
    const archivePath = path.join(operationDir(input.pageDir), `export-${crypto.randomUUID()}.zip`);
    try {
      await createArchiveAt({
        pageDir: input.pageDir,
        application: input.archiveApplication ?? input.application,
        sourceApplication: input.application,
        limits,
        storage,
        outputPath: archivePath,
      });
      return { archivePath, cleanup: () => fs.rmSync(archivePath, { force: true }) };
    } catch (caught) {
      fs.rmSync(archivePath, { force: true });
      throw caught;
    }
  });
}

export async function createAppBackup(
  pageDir: string,
  input: { name?: string; source: AppBackupSource; reason?: string; application?: AppDataIdentity; limits?: ArchiveLimits; storage?: AppDataStorage },
): Promise<AppBackup> {
  const application = input.application ?? inferAppDataIdentity(pageDir);
  const limits = input.limits ?? DEFAULT_ARCHIVE_LIMITS;
  const storage = input.storage ?? defaultStorage;
  return withAppDataMaintenance(pageDir, () => createManagedBackupUnlocked({ pageDir, application, limits, storage, ...input }));
}

export async function importAppData(input: {
  pageDir: string;
  application: AppDataIdentity;
  archivePath: string;
  reason: string;
  safetyBackupId?: string;
  limits?: ArchiveLimits;
  storage?: AppDataStorage;
}): Promise<{ databaseSize: number; fileCount: number; fileSize: number; safetyBackupId: string }> {
  const limits = input.limits ?? DEFAULT_ARCHIVE_LIMITS;
  const storage = input.storage ?? defaultStorage;
  return withAppDataMaintenance(input.pageDir, async () => {
    const token = crypto.randomUUID();
    const stagingDir = path.join(operationDir(input.pageDir), `candidate-${token}`);
    const rollbackDir = path.join(operationDir(input.pageDir), `rollback-${token}`);
    try {
      const prepared = await prepareArchive({ ...input, limits, stagingDir });
      const safety = input.safetyBackupId
        ? readBackupMetadata(input.pageDir, input.safetyBackupId)
        : await createManagedBackupUnlocked({
            pageDir: input.pageDir,
            application: input.application,
            limits,
            storage,
            source: "automatic",
            reason: input.reason,
          });
      if (!safety) throw new AppDataError("APP_BACKUP_NOT_FOUND", "Safety backup not found");
      try {
        await applyPreparedData({ ...input, ...prepared, storage });
      } catch (caught) {
        try {
          const rollback = await prepareArchive({
            pageDir: input.pageDir,
            application: input.application,
            archivePath: backupDataPath(input.pageDir, safety.id, "zip"),
            stagingDir: rollbackDir,
            limits,
          });
          await applyPreparedData({ ...input, ...rollback, storage });
        } catch (rollbackError) {
          throw new AppDataError("APP_DATA_ROLLBACK_FAILED", `Data replacement failed and rollback could not complete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
        throw caught;
      }
      return {
        databaseSize: fs.statSync(path.join(input.pageDir, "app.db")).size,
        fileCount: prepared.manifest.files.length,
        fileSize: prepared.manifest.files.reduce((total, file) => total + file.size, 0),
        safetyBackupId: safety.id,
      };
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.rmSync(rollbackDir, { recursive: true, force: true });
    }
  });
}

export function getAppBackupPath(pageDir: string, id: string): string {
  const backup = readBackupMetadata(pageDir, id);
  if (!backup) throw new AppDataError("APP_BACKUP_NOT_FOUND", "Backup not found");
  return backupDataPath(pageDir, id, backup.format);
}

export function getAppBackup(pageDir: string, id: string): AppBackup {
  const backup = readBackupMetadata(pageDir, id);
  if (!backup) throw new AppDataError("APP_BACKUP_NOT_FOUND", "Backup not found");
  return backup;
}

export async function deleteAppBackup(pageDir: string, id: string): Promise<void> {
  await withAppDataMaintenance(pageDir, async () => {
    const backup = getAppBackup(pageDir, id);
    fs.rmSync(backupDataPath(pageDir, id, backup.format), { force: true });
    fs.rmSync(backupMetaPath(pageDir, id), { force: true });
  });
}

export async function restoreAppBackup(
  pageDir: string,
  id: string,
  options: { application?: AppDataIdentity; limits?: ArchiveLimits; storage?: AppDataStorage } = {},
): Promise<void> {
  const backup = getAppBackup(pageDir, id);
  const application = options.application ?? inferAppDataIdentity(pageDir);
  if (backup.format === "zip") {
    await importAppData({ pageDir, application, archivePath: getAppBackupPath(pageDir, id), reason: `restore:${id}`, limits: options.limits, storage: options.storage });
    return;
  }
  await replaceAppDatabase(pageDir, fs.readFileSync(getAppBackupPath(pageDir, id)), `restore:${id}`, { ...options, application });
}

export async function restoreAppBackupExact(
  pageDir: string,
  id: string,
  options: { application: AppDataIdentity; limits?: ArchiveLimits; storage?: AppDataStorage },
): Promise<void> {
  const backup = getAppBackup(pageDir, id);
  const limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS;
  const storage = options.storage ?? defaultStorage;
  await withAppDataMaintenance(pageDir, async () => {
    if (backup.format === "legacy-db") {
      const bytes = fs.readFileSync(getAppBackupPath(pageDir, id));
      await validateSqlite(bytes);
      const candidatePath = path.join(operationDir(pageDir), `exact-restore-${crypto.randomUUID()}.db`);
      try {
        fs.writeFileSync(candidatePath, bytes, { mode: 0o600 });
        swapDatabaseFile(pageDir, candidatePath);
      } finally {
        fs.rmSync(candidatePath, { force: true });
      }
      return;
    }
    const stagingDir = path.join(operationDir(pageDir), `exact-restore-${crypto.randomUUID()}`);
    try {
      const prepared = await extractAndValidateDataArchive({
        archivePath: getAppBackupPath(pageDir, id),
        stagingDir,
        expectedApplication: { owner: options.application.owner, name: options.application.name },
        limits,
      });
      await applyPreparedData({ pageDir, application: options.application, ...prepared, storage });
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });
}

async function validateSqlite(bytes: Buffer): Promise<void> {
  if (bytes.subarray(0, 16).toString("binary") !== "SQLite format 3\u0000") throw new AppDataError("APP_DATABASE_INVALID", "File is not a SQLite database");
  const SQL = await initSqlJs();
  try {
    const db = new SQL.Database(bytes);
    const result = db.exec("PRAGMA integrity_check");
    db.close();
    if (result[0]?.values[0]?.[0] !== "ok") throw new AppDataError("APP_DATABASE_INVALID", "SQLite integrity check failed");
  } catch (caught) {
    if (caught instanceof AppDataError) throw caught;
    throw new AppDataError("APP_DATABASE_INVALID", `Cannot open SQLite database: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

export async function replaceAppDatabase(
  pageDir: string,
  candidate: Buffer,
  reason: string,
  options: { application?: AppDataIdentity; limits?: ArchiveLimits; storage?: AppDataStorage } = {},
): Promise<void> {
  await validateSqlite(candidate);
  const application = options.application ?? inferAppDataIdentity(pageDir);
  const limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS;
  const storage = options.storage ?? defaultStorage;
  await withAppDataMaintenance(pageDir, async () => {
    await createManagedBackupUnlocked({ pageDir, application, limits, storage, source: "automatic", reason });
    const candidatePath = path.join(operationDir(pageDir), `legacy-${crypto.randomUUID()}.db`);
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    try {
      fs.writeFileSync(candidatePath, candidate, { mode: 0o600 });
      swapDatabaseFile(pageDir, candidatePath);
    } finally {
      fs.rmSync(candidatePath, { force: true });
    }
  });
}

export async function resetApplicationData(input: {
  pageDir: string;
  application: AppDataIdentity;
  limits?: ArchiveLimits;
  storage?: AppDataStorage;
}): Promise<{ safetyBackupId: string }> {
  const limits = input.limits ?? DEFAULT_ARCHIVE_LIMITS;
  const storage = input.storage ?? defaultStorage;
  return withAppDataMaintenance(input.pageDir, async () => {
    const migrationsDir = await currentMigrationsDir(input.pageDir, input.application);
    const safety = await createManagedBackupUnlocked({ ...input, limits, storage, source: "automatic", reason: "factory-reset" });
    const candidatePath = path.join(operationDir(input.pageDir), `factory-reset-${crypto.randomUUID()}.db`);
    const rollbackDir = path.join(operationDir(input.pageDir), `factory-reset-rollback-${crypto.randomUUID()}`);
    try {
      await applyPendingMigrations({
        dbPath: candidatePath,
        migrationsDir,
      });
      await applyPreparedData({ pageDir: input.pageDir, application: input.application, databasePath: candidatePath, files: [], storage });
      return { safetyBackupId: safety.id };
    } catch (caught) {
      try {
        const rollback = await prepareArchive({
          pageDir: input.pageDir,
          application: input.application,
          archivePath: backupDataPath(input.pageDir, safety.id, "zip"),
          stagingDir: rollbackDir,
          limits,
        });
        await applyPreparedData({ ...input, ...rollback, storage });
      } catch (rollbackError) {
        throw new AppDataError("APP_DATA_ROLLBACK_FAILED", `Factory reset failed and rollback could not complete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      throw caught;
    } finally {
      fs.rmSync(candidatePath, { force: true });
      fs.rmSync(rollbackDir, { recursive: true, force: true });
    }
  });
}

export async function validateAppDatabase(bytes: Buffer): Promise<void> {
  await validateSqlite(bytes);
}
