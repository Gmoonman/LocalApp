import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  extractAppPackage,
  inspectAppPackage,
  type InspectedAppPackage,
  type PackageEntry,
} from "./app-package.cjs";

export const MIGRATION_SNAPSHOT_FILE = "migrations.snapshot.json";

export type VersionMigrationIdentity = {
  version: number;
  appVersion?: string;
  digest?: string;
  packagePath?: string;
};

type MigrationSnapshotFile = {
  path: string;
  size: number;
  sha256: string;
};

type MigrationSnapshot = {
  schemaVersion: 1;
  appVersion: string;
  packageDigest: string;
  files: MigrationSnapshotFile[];
};

export class VersionMigrationSnapshotError extends Error {
  readonly code = "APP_MIGRATIONS_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VersionMigrationSnapshotError";
  }
}

export function materializeVersionMigrationSnapshot(
  extractedDir: string,
  versionDir: string,
  inspected: InspectedAppPackage,
): void {
  const metadataDir = path.join(versionDir, ".localapp");
  const migrationsDir = path.join(metadataDir, "migrations");
  const sourceDir = path.join(extractedDir, "migrations");
  fs.mkdirSync(metadataDir, { recursive: true });
  if (fs.existsSync(sourceDir)) fs.cpSync(sourceDir, migrationsDir, { recursive: true });
  else fs.mkdirSync(migrationsDir, { recursive: true });
  const snapshot = snapshotFor(inspected);
  assertMigrationDirectory(migrationsDir, snapshot.files);
  fs.writeFileSync(path.join(metadataDir, MIGRATION_SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
}

export async function ensureVersionMigrationSnapshot(
  pageDir: string,
  appName: string,
  version: VersionMigrationIdentity,
): Promise<string> {
  const versionDir = path.join(pageDir, "versions", `v${version.version}`);
  const migrationsDir = path.join(versionDir, ".localapp", "migrations");
  if (isVerifiedSnapshot(versionDir, version)) return migrationsDir;

  const inspected = await inspectRetainedVersionPackage(pageDir, appName, version);
  const snapshot = snapshotFor(inspected);
  if (fs.existsSync(migrationsDir)) {
    try {
      assertMigrationDirectory(migrationsDir, snapshot.files);
      durableWriteSnapshot(versionDir, snapshot);
      return migrationsDir;
    } catch {
      // Recover incomplete or corrupt legacy metadata from the retained package.
    }
  }

  const stagingRoot = path.join(pageDir, ".migration-snapshots", crypto.randomUUID());
  const extractedDir = path.join(stagingRoot, "package");
  const metadataDir = path.join(versionDir, ".localapp");
  const temporaryMigrations = path.join(metadataDir, `.migrations.${crypto.randomUUID()}.partial`);
  const previousMigrations = path.join(metadataDir, `.migrations.${crypto.randomUUID()}.previous`);
  let movedPrevious = false;
  let published = false;
  try {
    await extractAppPackage(inspected, extractedDir);
    fs.mkdirSync(metadataDir, { recursive: true });
    assertDirectoryNotSymlink(metadataDir, "Application version metadata directory");
    const extractedMigrations = path.join(extractedDir, "migrations");
    if (fs.existsSync(extractedMigrations)) {
      fs.cpSync(extractedMigrations, temporaryMigrations, { recursive: true, errorOnExist: true });
    } else {
      fs.mkdirSync(temporaryMigrations, { recursive: true, mode: 0o700 });
    }
    assertMigrationDirectory(temporaryMigrations, snapshot.files);
    syncTree(temporaryMigrations);

    if (fs.existsSync(migrationsDir)) {
      assertDirectoryNotSymlink(migrationsDir, "Application migration snapshot directory");
      fs.renameSync(migrationsDir, previousMigrations);
      movedPrevious = true;
    }
    fs.renameSync(temporaryMigrations, migrationsDir);
    published = true;
    syncDirectory(metadataDir);
    durableWriteSnapshot(versionDir, snapshot);
    fs.rmSync(previousMigrations, { recursive: true, force: true });
    return migrationsDir;
  } catch (error) {
    if (published) fs.rmSync(migrationsDir, { recursive: true, force: true });
    if (movedPrevious && fs.existsSync(previousMigrations) && !fs.existsSync(migrationsDir)) {
      fs.renameSync(previousMigrations, migrationsDir);
    }
    throw error instanceof VersionMigrationSnapshotError
      ? error
      : new VersionMigrationSnapshotError(
        `Cannot materialize migrations for application ${appName} version ${version.version}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
  } finally {
    fs.rmSync(temporaryMigrations, { recursive: true, force: true });
    fs.rmSync(previousMigrations, { recursive: true, force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    const stagingParent = path.dirname(stagingRoot);
    if (fs.existsSync(stagingParent) && fs.readdirSync(stagingParent).length === 0) fs.rmdirSync(stagingParent);
  }
}

export async function resolveApplicationMigrationsDir(
  pageDir: string,
  application: { name: string; version: number },
): Promise<string> {
  const { hasMetadata, version } = readVersionIdentity(pageDir, application.name, application.version);
  if (version?.appVersion && version.digest && version.packagePath) {
    return ensureVersionMigrationSnapshot(pageDir, application.name, version);
  }

  const versionScoped = path.join(pageDir, "versions", `v${application.version}`, ".localapp", "migrations");
  if (fs.existsSync(versionScoped)) {
    assertDirectoryNotSymlink(versionScoped, "Application migration directory");
    return versionScoped;
  }
  const legacy = path.join(pageDir, "migrations");
  if (fs.existsSync(legacy) || application.version === 0) {
    if (fs.existsSync(legacy)) assertDirectoryNotSymlink(legacy, "Legacy application migration directory");
    return legacy;
  }
  if (hasMetadata && !version) {
    throw new VersionMigrationSnapshotError(
      `Application ${application.name} metadata does not contain version ${application.version}`,
    );
  }
  throw new VersionMigrationSnapshotError(
    `Application ${application.name} version ${application.version} has no retained migration snapshot`,
  );
}

function readVersionIdentity(
  pageDir: string,
  appName: string,
  localVersion: number,
): { hasMetadata: boolean; version: VersionMigrationIdentity | null } {
  const metaPath = path.join(pageDir, "meta.json");
  if (!fs.existsSync(metaPath)) return { hasMetadata: false, version: null };
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
      name?: unknown;
      versions?: VersionMigrationIdentity[];
    };
    if (meta.name !== appName || !Array.isArray(meta.versions)) {
      throw new VersionMigrationSnapshotError(`Application ${appName} has invalid version metadata`);
    }
    return {
      hasMetadata: true,
      version: meta.versions.find((entry) => entry.version === localVersion) ?? null,
    };
  } catch (error) {
    if (error instanceof VersionMigrationSnapshotError) throw error;
    throw new VersionMigrationSnapshotError(`Cannot read version metadata for application ${appName}`, { cause: error });
  }
}

async function inspectRetainedVersionPackage(
  pageDir: string,
  appName: string,
  version: VersionMigrationIdentity,
): Promise<InspectedAppPackage> {
  if (!Number.isSafeInteger(version.version) || version.version < 1
    || typeof version.appVersion !== "string" || !version.appVersion
    || typeof version.digest !== "string" || !/^[a-f0-9]{64}$/.test(version.digest)
    || typeof version.packagePath !== "string") {
    throw new VersionMigrationSnapshotError(
      `Application ${appName} version ${version.version} has no complete retained package identity`,
    );
  }
  const expectedRelative = `.packages/v${version.version}-${version.digest}.localapp`;
  if (version.packagePath !== expectedRelative) {
    throw new VersionMigrationSnapshotError(`Application ${appName} version ${version.version} has an unsafe retained package path`);
  }
  const packageRoot = path.resolve(pageDir, ".packages");
  const packagePath = path.resolve(pageDir, version.packagePath);
  if (path.dirname(packagePath) !== packageRoot) {
    throw new VersionMigrationSnapshotError(`Application ${appName} version ${version.version} has an unsafe retained package path`);
  }
  assertPathNotSymlink(packageRoot, "Retained package directory");
  assertPathNotSymlink(packagePath, "Retained application package");
  let inspected: InspectedAppPackage;
  try {
    inspected = await inspectAppPackage(packagePath);
  } catch (error) {
    throw new VersionMigrationSnapshotError(
      `Cannot verify retained package for application ${appName} version ${version.version}`,
      { cause: error },
    );
  }
  if (inspected.name !== appName || inspected.version !== version.appVersion || inspected.digest !== version.digest) {
    throw new VersionMigrationSnapshotError(
      `Retained package identity does not match application ${appName} version ${version.version}`,
    );
  }
  return inspected;
}

function snapshotFor(inspected: InspectedAppPackage): MigrationSnapshot {
  return {
    schemaVersion: 1,
    appVersion: inspected.version,
    packageDigest: inspected.digest,
    files: migrationFiles(inspected.entries),
  };
}

function migrationFiles(entries: readonly PackageEntry[]): MigrationSnapshotFile[] {
  return entries
    .filter((entry) => entry.path.startsWith("migrations/"))
    .map((entry) => ({ ...entry, path: entry.path.slice("migrations/".length) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function isVerifiedSnapshot(versionDir: string, version: VersionMigrationIdentity): boolean {
  if (!version.appVersion || !version.digest) return false;
  const metadataDir = path.join(versionDir, ".localapp");
  const markerPath = path.join(metadataDir, MIGRATION_SNAPSHOT_FILE);
  const migrationsDir = path.join(metadataDir, "migrations");
  if (!fs.existsSync(markerPath) || !fs.existsSync(migrationsDir)) return false;
  try {
    assertPathNotSymlink(markerPath, "Application migration snapshot marker");
    assertDirectoryNotSymlink(migrationsDir, "Application migration snapshot directory");
    const snapshot = JSON.parse(fs.readFileSync(markerPath, "utf8")) as MigrationSnapshot;
    if (snapshot.schemaVersion !== 1 || snapshot.appVersion !== version.appVersion || snapshot.packageDigest !== version.digest
      || !Array.isArray(snapshot.files)) return false;
    for (const file of snapshot.files) {
      if (!isSnapshotFile(file)) return false;
    }
    assertMigrationDirectory(migrationsDir, snapshot.files);
    return true;
  } catch {
    return false;
  }
}

function isSnapshotFile(value: unknown): value is MigrationSnapshotFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<MigrationSnapshotFile>;
  return typeof file.path === "string" && isSafeRelativeFile(file.path)
    && Number.isSafeInteger(file.size) && Number(file.size) >= 0
    && typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256);
}

function assertMigrationDirectory(directory: string, expected: readonly MigrationSnapshotFile[]): void {
  assertDirectoryNotSymlink(directory, "Application migration snapshot directory");
  const actual = listFiles(directory);
  if (actual.length !== expected.length) throw new VersionMigrationSnapshotError("Application migration snapshot file list does not match its package");
  for (let index = 0; index < expected.length; index += 1) {
    const expectedFile = expected[index]!;
    const actualPath = actual[index]!;
    if (actualPath !== expectedFile.path) throw new VersionMigrationSnapshotError("Application migration snapshot file list does not match its package");
    const filePath = path.join(directory, ...actualPath.split("/"));
    const stat = fs.statSync(filePath);
    if (stat.size !== expectedFile.size || sha256File(filePath) !== expectedFile.sha256) {
      throw new VersionMigrationSnapshotError(`Application migration snapshot checksum mismatch: ${actualPath}`);
    }
  }
}

function listFiles(directory: string, relative = ""): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, ...relativePath.split("/"));
    if (entry.isSymbolicLink()) throw new VersionMigrationSnapshotError("Symbolic links are not allowed in migration snapshots");
    if (entry.isDirectory()) files.push(...listFiles(directory, relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else throw new VersionMigrationSnapshotError("Unsupported file type in migration snapshot");
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function durableWriteSnapshot(versionDir: string, snapshot: MigrationSnapshot): void {
  const metadataDir = path.join(versionDir, ".localapp");
  fs.mkdirSync(metadataDir, { recursive: true });
  assertDirectoryNotSymlink(metadataDir, "Application version metadata directory");
  const markerPath = path.join(metadataDir, MIGRATION_SNAPSHOT_FILE);
  const temporaryPath = path.join(metadataDir, `.${MIGRATION_SNAPSHOT_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    syncFile(temporaryPath);
    fs.renameSync(temporaryPath, markerPath);
    syncDirectory(metadataDir);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function syncTree(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) syncTree(entryPath);
    else if (entry.isFile()) syncFile(entryPath);
  }
  syncDirectory(directory);
}

function syncFile(filePath: string): void {
  // Windows FlushFileBuffers needs a write-capable handle: a read-only
  // descriptor always fails there, and a platform-readonly file cannot even
  // be opened read-write. Durability fsyncs are best effort, so purely
  // access-related failures are ignored like the directory fsyncs below.
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "r+");
  } catch (error) {
    if (["EPERM", "EACCES", "EROFS", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!["EPERM", "EACCES", "EROFS", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { fs.closeSync(descriptor); }
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (["EINVAL", "EPERM", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertDirectoryNotSymlink(directory: string, label: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new VersionMigrationSnapshotError(`${label} must be a real directory`);
}

function assertPathNotSymlink(filePath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new VersionMigrationSnapshotError(`${label} is unavailable`, { cause: error });
  }
  if (stat.isSymbolicLink()) throw new VersionMigrationSnapshotError(`${label} must not be a symbolic link`);
}

function isSafeRelativeFile(filePath: string): boolean {
  return filePath.length > 0 && !path.posix.isAbsolute(filePath)
    && !filePath.split("/").some((segment) => !segment || segment === "." || segment === "..");
}
