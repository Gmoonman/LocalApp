import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyPendingMigrations } from "./migrations.cjs";
import { execRawSql, getConnection } from "./app-db.cjs";
import { loadActionManifest, validateActionManifest } from "./backend-actions.cjs";
import { loadBackendContract, validateBackendContract } from "./backend-contract.cjs";
import { parseIssueTemplatesConfig, type IssueTemplateConfig } from "./issue-templates.cjs";
import { PLATFORM_CAPABILITIES } from "./platform-capabilities.cjs";
import { closeConnectionsForPage } from "./app-db.cjs";
import { withAppDataMaintenance } from "./app-data-maintenance.cjs";
import {
  AppPackageValidationError,
  extractAppPackage,
  inspectAppPackage,
  type InspectedAppPackage,
} from "./app-package.cjs";
import {
  materializeManifest,
  mergeManifests,
  PlatformManifestValidationError,
  commitSourceManifestAndMeta,
  recoverSourceManifestAndMeta,
  readManifestState,
} from "./app-manifest.cjs";
import { CURRENT_PLATFORM_VERSION } from "./platform-version.cjs";
import { countFiles, getDirectorySize, removeDirRecursive } from "./file-utils.cjs";
import {
  ensureVersionMigrationSnapshot,
  materializeVersionMigrationSnapshot,
  VersionMigrationSnapshotError,
} from "./app-version-migrations.cjs";
import {
  getPageDir,
  getPageMetaPath,
  readPageMeta,
  writePageMeta,
  type PageMeta,
  type PageVersionMeta,
} from "./page-storage.cjs";
import type { BusinessMetadata, CollaborationConfig, RouteAccess } from "./models.cjs";

const MAX_RETAINED_VERSIONS = 10;
const INSTALL_TRANSACTION_FILE = ".app-install-transaction.json";
const CRDT_MIN_PLATFORM_VERSION: [number, number, number] = [1, 3, 0];

interface AppInstallTransaction {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  appName: string;
  state: "prepared" | "rolling-back" | "committed" | "recovery-required";
  issue?: string;
  jobDir: string;
  database: { existed: boolean; backupPath: string | null; backupDigest: string | null };
  previous: { meta: PageMeta | null; sourceManifest: Record<string, unknown> | null };
  next: {
    localVersion: number;
    appVersion: string;
    digest: string;
    versionPath: string;
    packagePath: string;
  };
}

export interface InstallAppPackageInput {
  dataDir: string;
  ownerId: string;
  packagePath: string;
  uploaderDisplayName?: string;
  requireExisting?: boolean;
  preserveTargetAccess?: boolean;
  expectedLocalVersion?: number;
}

export interface InstallOutcome {
  name: string;
  ownerId: string;
  localVersion: number;
  appVersion: string;
  digest: string;
  created: boolean;
  upgraded: boolean;
  idempotent: boolean;
}

export interface ActivationOutcome {
  name: string;
  ownerId: string;
  localVersion: number;
  appVersion: string;
  digest: string;
}

export class AppInstallError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppInstallError";
  }
}

export async function installAppPackage(input: InstallAppPackageInput): Promise<InstallOutcome> {
  let inspected: InspectedAppPackage;
  try {
    inspected = await inspectAppPackage(input.packagePath);
  } catch (error) {
    if (error instanceof AppPackageValidationError) {
      throw new AppInstallError(error.code, error.message, 400, error.path, { cause: error });
    }
    throw error;
  }
  assertPlatformCompatible(inspected.metadata.platformVersion);
  const pageDir = getPageDir(input.dataDir, input.ownerId, inspected.name);
  return withAppDataMaintenance(pageDir, async () => {
    if (input.expectedLocalVersion !== undefined && (readPageMeta(input.dataDir, input.ownerId, inspected.name)?.currentVersion ?? 0) !== input.expectedLocalVersion) {
      throw new AppInstallError("VERSION_CONFLICT", "正式应用版本已改变，请重新检查", 409);
    }
    return installInspectedPackage(input, inspected, pageDir);
  });
}

export async function reconcileAppInstallTransactions(dataDir: string): Promise<number> {
  let recovered = 0;
  if (!fs.existsSync(dataDir)) return recovered;
  for (const owner of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!owner.isDirectory() || owner.name.startsWith(".")) continue;
    const ownerDir = path.join(dataDir, owner.name);
    for (const app of fs.readdirSync(ownerDir, { withFileTypes: true })) {
      if (!app.isDirectory()) continue;
      const pageDir = path.join(ownerDir, app.name);
      if (!fs.existsSync(path.join(pageDir, INSTALL_TRANSACTION_FILE))) continue;
      await reconcileInstallTransaction(dataDir, pageDir);
      recovered += 1;
    }
  }
  return recovered;
}

export async function verifyInstalledAppVersion(input: {
  dataDir: string; ownerId: string; appName: string; appVersion: string; digest: string;
}): Promise<PageVersionMeta> {
  const meta = readRawPageMeta(input.dataDir, input.ownerId, input.appName);
  const version = meta?.versions.find((entry) => entry.appVersion === input.appVersion && entry.digest === input.digest);
  if (!meta || meta.currentVersion !== version?.version || !version.packagePath) {
    throw new Error("Installed application metadata does not identify the active synchronized version");
  }
  const pageDir = getPageDir(input.dataDir, input.ownerId, input.appName);
  assertVersionHealthy(path.join(pageDir, "versions", `v${version.version}`));
  const inspected = await inspectAppPackage(resolvePageRelative(pageDir, version.packagePath));
  if (inspected.name !== input.appName || inspected.version !== input.appVersion || inspected.digest !== input.digest) {
    throw new Error("Installed portable package does not match the active synchronized version");
  }
  await verifyAppliedMigrations(pageDir, inspected);
  return version;
}

export async function activateAppVersion(input: {
  dataDir: string;
  ownerId: string;
  name: string;
  localVersion: number;
}): Promise<ActivationOutcome> {
  const pageDir = getPageDir(input.dataDir, input.ownerId, input.name);
  return withAppDataMaintenance(pageDir, async () => {
    const meta = requiredMeta(input.dataDir, input.ownerId, input.name);
    return activateVersionLocked(input.dataDir, pageDir, meta, input.localVersion, true);
  });
}

export async function rollbackAppVersion(input: {
  dataDir: string;
  ownerId: string;
  name: string;
}): Promise<ActivationOutcome> {
  const pageDir = getPageDir(input.dataDir, input.ownerId, input.name);
  return withAppDataMaintenance(pageDir, async () => {
    const meta = requiredMeta(input.dataDir, input.ownerId, input.name);
    const target = meta.previousVersion
      ?? [...meta.versions].filter((entry) => entry.version < meta.currentVersion).sort((left, right) => right.version - left.version)[0]?.version;
    if (!target || target === meta.currentVersion) {
      throw new AppInstallError("APP_ROLLBACK_UNAVAILABLE", "No previous application version is available", 409);
    }
    return activateVersionLocked(input.dataDir, pageDir, meta, target, false);
  });
}

async function installInspectedPackage(
  input: InstallAppPackageInput,
  inspected: InspectedAppPackage,
  pageDir: string,
): Promise<InstallOutcome> {
  const existing = readPageMeta(input.dataDir, input.ownerId, inspected.name);
  if (!existing && input.requireExisting) {
    throw new AppInstallError("APP_NOT_FOUND", "Page not found", 404);
  }
  if (existing?.status === "needs-migration-repair") {
    throw new AppInstallError("APP_MIGRATION_REPAIR_REQUIRED", "App is marked needs-migration-repair. Repair platform migrations before installing.", 409);
  }
  if (existing) await backfillRetainedVersionMigrationSnapshots(pageDir, existing);
  const knownIdentity = existing?.packageIdentities?.[inspected.version];
  const matchingVersion = existing?.versions.find((entry) => entry.appVersion === inspected.version);
  const knownDigest = matchingVersion?.digest ?? knownIdentity?.digest;
  if (knownDigest && knownDigest !== inspected.digest) {
    throw new AppInstallError(
      "APP_VERSION_DIGEST_CONFLICT",
      `Application version ${inspected.version} already exists with another digest`,
      409,
    );
  }
  if (knownDigest === inspected.digest && matchingVersion
    && fs.existsSync(path.join(pageDir, "versions", `v${matchingVersion.version}`))) {
    const retained = await retainExactPackage(pageDir, matchingVersion.version, inspected);
    if (matchingVersion.packagePath !== retained.relativePath) {
      const updated = JSON.parse(JSON.stringify(existing)) as PageMeta;
      const version = updated.versions.find((entry) => entry.version === matchingVersion.version)!;
      version.packagePath = retained.relativePath;
      try {
        commitSourceManifestAndMeta(
          pageDir,
          getPageMetaPath(input.dataDir, input.ownerId, inspected.name),
          readManifestState(pageDir, updated).sourceManifest,
          updated,
        );
      } catch (error) {
        if (retained.created) removeRetainedPackage(pageDir, retained.relativePath);
        throw error;
      }
    }
    return {
      name: inspected.name,
      ownerId: input.ownerId,
      localVersion: matchingVersion.version,
      appVersion: inspected.version,
      digest: inspected.digest,
      created: false,
      upgraded: false,
      idempotent: true,
    };
  }

  const jobDir = path.join(input.dataDir, ".staging", "apps", crypto.randomUUID());
  const sourceManifest = ownerIndependentManifest(inspected.manifest);
  if (input.preserveTargetAccess) sourceManifest.pageAccess = existing?.pageAccess ?? { level: "owner" };
  const extractedDir = path.join(jobDir, "package");
  const stagedVersionDir = path.join(jobDir, "version");
  fs.mkdirSync(jobDir, { recursive: true });
  const pageExisted = fs.existsSync(pageDir);
  const dbPath = path.join(pageDir, "app.db");
  const dbBackupPath = path.join(jobDir, "app.db.before-install");
  const dbExisted = fs.existsSync(dbPath);
  const previousManifestPath = path.join(pageDir, "manifest.json");
  const previousManifest = fs.existsSync(previousManifestPath) ? fs.readFileSync(previousManifestPath) : null;
  let finalVersionDir: string | undefined;
  let retainedPackage: { relativePath: string; created: boolean } | undefined;
  let transaction: AppInstallTransaction | undefined;
  let commitCompleted = false;
  try {
    const previousSourceManifest = previousManifest
      ? JSON.parse(previousManifest.toString("utf8")) as Record<string, unknown>
      : null;
    await extractAppPackage(inspected, extractedDir);
    materializeStagedVersion(extractedDir, stagedVersionDir, sourceManifest, inspected);
    const parsed = validateStagedApplication(stagedVersionDir, sourceManifest, inspected.metadata.platformVersion);
    const baseMeta = existing ?? createEmptyMeta(inspected.name, input.ownerId);
    const platformManifest = readManifestState(pageDir, baseMeta).platformManifest;
    const effectiveManifest = mergeManifests(sourceManifest, platformManifest);
    let updatedMeta: PageMeta;
    try {
      updatedMeta = materializeManifest(baseMeta, effectiveManifest);
    } catch (error) {
      if (error instanceof PlatformManifestValidationError) {
        throw new AppInstallError("APP_MANIFEST_INVALID", error.message, 400, error.field, { cause: error });
      }
      throw error;
    }
    applyManifestMetadata(updatedMeta, parsed);

    const newVersion = Math.max(0, ...baseMeta.versions.map((entry) => entry.version), baseMeta.currentVersion) + 1;
    finalVersionDir = path.join(pageDir, "versions", `v${newVersion}`);
    if (fs.existsSync(finalVersionDir)) {
      throw new AppInstallError("APP_VERSION_STORAGE_CONFLICT", `Version directory already exists: v${newVersion}`, 409);
    }
    const packageRelativePath = `.packages/v${newVersion}-${inspected.digest}.localapp`;
    const now = new Date().toISOString();
    const versionEntry: PageVersionMeta = {
      version: newVersion,
      appVersion: inspected.version,
      digest: inspected.digest,
      packagePath: packageRelativePath,
      createdAt: now,
      fileCount: countFiles(stagedVersionDir),
      totalSize: getDirectorySize(stagedVersionDir),
      uploaderId: input.ownerId,
      ...(input.uploaderDisplayName ? { uploaderDisplayName: input.uploaderDisplayName } : {}),
      ...(parsed.issueTemplates ? { issues: { templates: parsed.issueTemplates } } : {}),
      manifest: sourceManifest,
    };
    updatedMeta.currentVersion = newVersion;
    updatedMeta.currentAppVersion = inspected.version;
    updatedMeta.previousVersion = baseMeta.currentVersion > 0 ? baseMeta.currentVersion : undefined;
    updatedMeta.updatedAt = now;
    updatedMeta.versions = [...baseMeta.versions, versionEntry];
    updatedMeta.packageIdentities = {
      ...(baseMeta.packageIdentities ?? {}),
      [inspected.version]: { digest: inspected.digest, version: newVersion },
    };
    const allVersions = updatedMeta.versions;
    updatedMeta.versions = retainedVersions(updatedMeta);

    fs.mkdirSync(pageDir, { recursive: true });
    closeConnectionsForPage(pageDir);
    if (dbExisted) {
      fs.copyFileSync(dbPath, dbBackupPath);
      syncFile(dbBackupPath);
      syncDirectory(jobDir);
    }
    transaction = {
      schemaVersion: 1,
      id: path.basename(jobDir),
      ownerId: input.ownerId,
      appName: inspected.name,
      state: "prepared",
      jobDir: path.relative(input.dataDir, jobDir),
      database: {
        existed: dbExisted,
        backupPath: dbExisted ? path.relative(input.dataDir, dbBackupPath) : null,
        backupDigest: dbExisted ? sha256FileSync(dbBackupPath) : null,
      },
      previous: { meta: existing ? cloneJson(existing) : null, sourceManifest: previousSourceManifest },
      next: {
        localVersion: newVersion,
        appVersion: inspected.version,
        digest: inspected.digest,
        versionPath: path.relative(pageDir, finalVersionDir),
        packagePath: packageRelativePath,
      },
    };
    writeInstallTransaction(pageDir, transaction);
    await validateMigrationHistory(pageDir, inspected);
    const migrationsDir = path.join(extractedDir, "migrations");
    if (fs.existsSync(migrationsDir) && fs.readdirSync(migrationsDir).some((entry) => entry.endsWith(".sql"))) {
      try {
        await applyPendingMigrations({
          dbPath,
          migrationsDir,
          beforeApply: () => rotateAppDbBackups(pageDir),
        });
      } catch (error) {
        const filename = isMigrationError(error) ? error.filename : undefined;
        throw new AppInstallError(
          "APP_MIGRATION_APPLY_FAILED",
          error instanceof Error ? error.message : String(error),
          400,
          filename,
          { cause: error },
        );
      } finally {
        closeConnectionsForPage(pageDir);
      }
    }

    fs.mkdirSync(path.dirname(finalVersionDir), { recursive: true });
    fs.renameSync(stagedVersionDir, finalVersionDir);
    syncDirectory(path.dirname(finalVersionDir));
    assertVersionHealthy(finalVersionDir);
    retainedPackage = await retainExactPackage(pageDir, newVersion, inspected);
    if (retainedPackage.relativePath !== packageRelativePath) {
      throw new AppInstallError("APP_PACKAGE_STORAGE_CONFLICT", "Retained package path does not match installation transaction", 500);
    }
    commitSourceManifestAndMeta(
      pageDir,
      getPageMetaPath(input.dataDir, input.ownerId, inspected.name),
      sourceManifest,
      updatedMeta,
    );
    commitCompleted = true;
    transaction.state = "committed";
    try {
      writeInstallTransaction(pageDir, transaction);
    } catch {
      // The committed manifest and metadata are authoritative. The original
      // prepared journal remains safe to replay if this marker cannot publish.
    }
    cleanupCommittedInstallTransaction(pageDir, transaction);
    transaction = undefined;
    try {
      cleanupOldVersions(pageDir, allVersions, updatedMeta.versions);
    } catch {
      // Metadata is already durable and references only retained directories.
      // A later maintenance pass can reclaim an obsolete directory safely.
    }
    return {
      name: inspected.name,
      ownerId: input.ownerId,
      localVersion: newVersion,
      appVersion: inspected.version,
      digest: inspected.digest,
      created: !existing,
      upgraded: Boolean(existing?.currentVersion),
      idempotent: false,
    };
  } catch (error) {
    if (commitCompleted) {
      // Manifest and metadata are already durably committed. Never restore the
      // previous database or version merely because post-commit cleanup failed.
      transaction = undefined;
    } else if (transaction && fs.existsSync(path.join(pageDir, INSTALL_TRANSACTION_FILE))) {
      const activeTransaction = transaction;
      try {
        activeTransaction.state = "rolling-back";
        writeInstallTransaction(pageDir, activeTransaction);
        await rollbackInstallTransaction(input.dataDir, pageDir, activeTransaction);
        transaction = undefined;
      } catch (recoveryError) {
        markRecoveryRequired(pageDir, activeTransaction, recoveryError);
        throw new AppInstallError(
          "APP_INSTALL_RECOVERY_REQUIRED",
          "Application installation failed and automatic rollback could not be proven safe",
          503,
          undefined,
          { cause: recoveryError },
        );
      }
    } else {
      closeConnectionsForPage(pageDir);
      restoreDatabase(dbPath, dbBackupPath, dbExisted);
      if (finalVersionDir) removeDirRecursive(finalVersionDir);
      if (retainedPackage?.created) removeRetainedPackage(pageDir, retainedPackage.relativePath);
      if (existing) {
        if (previousManifest) fs.writeFileSync(previousManifestPath, previousManifest);
        else fs.rmSync(previousManifestPath, { force: true });
        writePageMeta(input.dataDir, input.ownerId, inspected.name, existing);
      } else if (!pageExisted) {
        removeDirRecursive(pageDir);
      }
    }
    throw error;
  } finally {
    if (!transaction && !fs.existsSync(path.join(pageDir, INSTALL_TRANSACTION_FILE))) removeDirRecursive(jobDir);
  }
}

async function reconcileInstallTransaction(dataDir: string, pageDir: string): Promise<void> {
  const transactionPath = path.join(pageDir, INSTALL_TRANSACTION_FILE);
  let transaction: AppInstallTransaction;
  try {
    transaction = JSON.parse(fs.readFileSync(transactionPath, "utf8")) as AppInstallTransaction;
    validateInstallTransaction(dataDir, pageDir, transaction);
  } catch (error) {
    throw new AppInstallError(
      "APP_INSTALL_RECOVERY_REQUIRED",
      `Cannot safely read application installation transaction at ${transactionPath}`,
      503,
      transactionPath,
      { cause: error },
    );
  }
  if (transaction.state === "recovery-required") {
    throw new AppInstallError(
      "APP_INSTALL_RECOVERY_REQUIRED",
      transaction.issue ?? "Application installation requires operator recovery",
      503,
      transactionPath,
    );
  }

  try {
    recoverSourceManifestAndMeta(pageDir, getPageMetaPath(dataDir, transaction.ownerId, transaction.appName));
    const visibleMeta = readRawPageMeta(dataDir, transaction.ownerId, transaction.appName);
    if (transaction.state === "committed" && !isNextInstallMeta(visibleMeta, transaction)) {
      throw new Error("Committed installation transaction does not identify the activated version");
    }
    if (transaction.state !== "committed" && (transaction.state === "rolling-back" || sameJson(visibleMeta, transaction.previous.meta))) {
      if (transaction.state !== "rolling-back") {
        transaction.state = "rolling-back";
        writeInstallTransaction(pageDir, transaction);
      }
      await rollbackInstallTransaction(dataDir, pageDir, transaction);
      return;
    }
    if (isNextInstallMeta(visibleMeta, transaction)) {
      await verifyCompletedInstall(pageDir, transaction);
      cleanupCommittedInstallTransaction(pageDir, transaction);
      if (!fs.existsSync(path.join(pageDir, INSTALL_TRANSACTION_FILE))) {
        removeDirRecursive(resolveTransactionJobDir(dataDir, transaction));
      }
      return;
    }
    throw new Error("Visible application metadata matches neither the previous nor activated version");
  } catch (error) {
    markRecoveryRequired(pageDir, transaction, error);
    throw new AppInstallError(
      "APP_INSTALL_RECOVERY_REQUIRED",
      `Application ${transaction.ownerId}/${transaction.appName} requires recovery before Server can start`,
      503,
      transactionPath,
      { cause: error },
    );
  }
}

async function rollbackInstallTransaction(dataDir: string, pageDir: string, transaction: AppInstallTransaction): Promise<void> {
  const dbPath = path.join(pageDir, "app.db");
  closeConnectionsForPage(pageDir);
  if (transaction.database.existed) {
    const backupPath = resolveTransactionBackup(dataDir, transaction);
    if (!backupPath || !fs.existsSync(backupPath)) throw new Error("Application database backup is missing");
    if (sha256FileSync(backupPath) !== transaction.database.backupDigest) throw new Error("Application database backup digest mismatch");
    durableCopyFile(backupPath, dbPath);
    if (sha256FileSync(dbPath) !== transaction.database.backupDigest) throw new Error("Restored application database digest mismatch");
  } else {
    fs.rmSync(dbPath, { force: true });
    syncDirectory(pageDir);
  }

  removeDirRecursive(resolvePageRelative(pageDir, transaction.next.versionPath));
  removeRetainedPackage(pageDir, transaction.next.packagePath);
  fs.rmSync(path.join(pageDir, ".app-state-transaction.json"), { force: true });
  const sourcePath = path.join(pageDir, "manifest.json");
  const metaPath = getPageMetaPath(dataDir, transaction.ownerId, transaction.appName);
  if (transaction.previous.sourceManifest) durableWriteJson(sourcePath, transaction.previous.sourceManifest);
  else fs.rmSync(sourcePath, { force: true });
  if (transaction.previous.meta) durableWriteJson(metaPath, transaction.previous.meta as unknown as Record<string, unknown>);
  else fs.rmSync(metaPath, { force: true });
  syncDirectory(pageDir);

  if (!sameJson(readRawPageMeta(dataDir, transaction.ownerId, transaction.appName), transaction.previous.meta)) {
    throw new Error("Previous application metadata could not be restored exactly");
  }
  removeInstallTransaction(pageDir);
  removeDirRecursive(resolveTransactionJobDir(dataDir, transaction));
}

async function verifyCompletedInstall(pageDir: string, transaction: AppInstallTransaction): Promise<void> {
  const versionDir = resolvePageRelative(pageDir, transaction.next.versionPath);
  assertVersionHealthy(versionDir);
  const packagePath = resolvePageRelative(pageDir, transaction.next.packagePath);
  const inspected = await inspectAppPackage(packagePath);
  if (inspected.digest !== transaction.next.digest || inspected.version !== transaction.next.appVersion
    || inspected.name !== transaction.appName) {
    throw new Error("Activated package does not match installation transaction");
  }
  await verifyAppliedMigrations(pageDir, inspected);
}

async function verifyAppliedMigrations(pageDir: string, inspected: InspectedAppPackage): Promise<void> {
  const migrations = inspected.entries.filter((entry) => entry.path.startsWith("migrations/") && entry.path.endsWith(".sql"));
  if (migrations.length === 0) return;
  const dbPath = path.join(pageDir, "app.db");
  if (!fs.existsSync(dbPath)) throw new Error("Activated application database is missing");
  await getConnection(dbPath);
  try {
    const table = execRawSql(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_localapp_applied_migrations'");
    if ((table.rows ?? []).length === 0) throw new Error("Activated application migration history is missing");
    const applied = new Map((execRawSql(dbPath, "SELECT filename, checksum FROM _localapp_applied_migrations").rows ?? [])
      .map((row) => [String(row.filename), String(row.checksum)]));
    for (const migration of migrations) {
      if (applied.get(path.posix.basename(migration.path)) !== migration.sha256) {
        throw new Error(`Activated migration is not verified: ${migration.path}`);
      }
    }
  } finally { closeConnectionsForPage(pageDir); }
}

function writeInstallTransaction(pageDir: string, transaction: AppInstallTransaction): void {
  durableWriteJson(path.join(pageDir, INSTALL_TRANSACTION_FILE), transaction as unknown as Record<string, unknown>);
}

function removeInstallTransaction(pageDir: string): void {
  fs.rmSync(path.join(pageDir, INSTALL_TRANSACTION_FILE), { force: true });
  syncDirectory(pageDir);
}

function cleanupCommittedInstallTransaction(pageDir: string, transaction: AppInstallTransaction): void {
  try {
    removeInstallTransaction(pageDir);
  } catch {
    // Unlinking can succeed while the parent-directory fsync fails. Recreate a
    // committed marker so a restart can verify the visible deployment and
    // retry cleanup; this must never enter the rollback path.
    transaction.state = "committed";
    try { writeInstallTransaction(pageDir, transaction); } catch { /* retry on the next maintenance pass */ }
  }
}

function markRecoveryRequired(pageDir: string, transaction: AppInstallTransaction, error: unknown): void {
  transaction.state = "recovery-required";
  transaction.issue = error instanceof Error ? error.message : String(error);
  try { writeInstallTransaction(pageDir, transaction); } catch { /* preserve the original durable journal if publication fails */ }
}

function validateInstallTransaction(dataDir: string, pageDir: string, transaction: AppInstallTransaction): void {
  if (transaction.schemaVersion !== 1 || !transaction.id || !transaction.ownerId || !transaction.appName) {
    throw new Error("Invalid application installation transaction metadata");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transaction.id)) {
    throw new Error("Invalid application installation transaction ID");
  }
  if (!["prepared", "rolling-back", "committed", "recovery-required"].includes(transaction.state)) throw new Error("Invalid recovery state");
  const expectedPageDir = path.resolve(getPageDir(dataDir, transaction.ownerId, transaction.appName));
  if (expectedPageDir !== path.resolve(pageDir)
    || transaction.ownerId !== path.basename(path.dirname(pageDir))
    || transaction.appName !== path.basename(pageDir)) {
    throw new Error("Installation transaction identity mismatch");
  }
  if (!Number.isSafeInteger(transaction.next?.localVersion) || transaction.next.localVersion < 1
    || typeof transaction.next.appVersion !== "string" || !transaction.next.appVersion
    || !/^[a-f0-9]{64}$/.test(transaction.next.digest)) {
    throw new Error("Invalid next application version identity");
  }
  const expectedVersionPath = path.join("versions", `v${transaction.next.localVersion}`);
  const expectedPackagePath = path.posix.join(".packages", `v${transaction.next.localVersion}-${transaction.next.digest}.localapp`);
  if (transaction.next.versionPath !== expectedVersionPath) throw new Error("Invalid installer version path identity");
  if (transaction.next.packagePath !== expectedPackagePath) throw new Error("Invalid installer package path identity");
  resolveTransactionJobDir(dataDir, transaction);
  resolvePageRelative(pageDir, transaction.next.versionPath);
  resolvePageRelative(pageDir, transaction.next.packagePath);
  if (transaction.database.existed) {
    if (!/^[a-f0-9]{64}$/.test(transaction.database.backupDigest ?? "")) throw new Error("Invalid installer database backup digest");
    resolveTransactionBackup(dataDir, transaction);
  } else if (transaction.database.backupPath !== null || transaction.database.backupDigest !== null) {
    throw new Error("Unexpected installer database backup identity");
  }
}

function resolveTransactionJobDir(dataDir: string, transaction: AppInstallTransaction): string {
  const root = path.resolve(dataDir, ".staging", "apps");
  const expectedRelative = path.join(".staging", "apps", transaction.id);
  if (transaction.jobDir !== expectedRelative) throw new Error("Unsafe installer staging path");
  const resolved = path.resolve(dataDir, transaction.jobDir);
  if (path.dirname(resolved) !== root || path.basename(resolved) !== transaction.id) throw new Error("Unsafe installer staging path");
  assertNoSymlinkComponents(path.resolve(dataDir), transaction.jobDir);
  return resolved;
}

function resolveTransactionBackup(dataDir: string, transaction: AppInstallTransaction): string | null {
  if (!transaction.database.backupPath) return null;
  const jobDir = resolveTransactionJobDir(dataDir, transaction);
  const expected = path.relative(dataDir, path.join(jobDir, "app.db.before-install"));
  if (transaction.database.backupPath !== expected) throw new Error("Unsafe installer database backup path");
  const resolved = path.resolve(dataDir, transaction.database.backupPath);
  if (path.dirname(resolved) !== jobDir || path.basename(resolved) !== "app.db.before-install") {
    throw new Error("Unsafe installer database backup path");
  }
  assertNoSymlinkComponents(path.resolve(dataDir), transaction.database.backupPath);
  return resolved;
}

function resolvePageRelative(pageDir: string, relativePath: string): string {
  const resolved = path.resolve(pageDir, relativePath);
  if (!resolved.startsWith(`${path.resolve(pageDir)}${path.sep}`)) throw new Error("Unsafe application transaction path");
  assertNoSymlinkComponents(path.resolve(pageDir), relativePath);
  return resolved;
}

function assertNoSymlinkComponents(baseDir: string, relativePath: string): void {
  const normalized = path.normalize(relativePath);
  if (path.isAbsolute(relativePath) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Unsafe non-canonical application transaction path");
  }
  let current = baseDir;
  for (const segment of normalized.split(path.sep)) {
    if (!segment || segment === ".") throw new Error("Unsafe non-canonical application transaction path");
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Symbolic links are not allowed in application transaction paths");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function isNextInstallMeta(meta: PageMeta | null, transaction: AppInstallTransaction): boolean {
  if (!meta) return false;
  const version = meta.versions.find((entry) => entry.version === transaction.next.localVersion);
  return meta.userId === transaction.ownerId && meta.name === transaction.appName
    && meta.currentVersion === transaction.next.localVersion
    && meta.currentAppVersion === transaction.next.appVersion
    && version?.digest === transaction.next.digest
    && version.packagePath === transaction.next.packagePath;
}

function readRawPageMeta(dataDir: string, ownerId: string, appName: string): PageMeta | null {
  const metaPath = getPageMetaPath(dataDir, ownerId, appName);
  return fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) as PageMeta : null;
}

function durableWriteJson(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    syncFile(tempPath);
    fs.renameSync(tempPath, filePath);
    syncDirectory(path.dirname(filePath));
  } finally { fs.rmSync(tempPath, { force: true }); }
}

function durableCopyFile(source: string, target: string): void {
  const tempPath = `${target}.${process.pid}.${crypto.randomUUID()}.restore`;
  try {
    fs.copyFileSync(source, tempPath);
    syncFile(tempPath);
    fs.renameSync(tempPath, target);
    syncDirectory(path.dirname(target));
  } finally { fs.rmSync(tempPath, { force: true }); }
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

function sha256FileSync(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function activateVersionLocked(
  dataDir: string,
  pageDir: string,
  meta: PageMeta,
  localVersion: number,
  recordPrevious: boolean,
): Promise<ActivationOutcome> {
  const target = meta.versions.find((entry) => entry.version === localVersion);
  if (!target || !target.appVersion || !target.digest) {
    throw new AppInstallError("APP_VERSION_NOT_FOUND", `Application version ${localVersion} was not found`, 404);
  }
  const versionDir = path.join(pageDir, "versions", `v${localVersion}`);
  assertVersionHealthy(versionDir);
  if (target.packagePath) {
    await ensureVersionMigrationSnapshot(pageDir, meta.name, target).catch((error) => {
      throw asInstallMigrationError(error, meta.name, localVersion);
    });
  }
  const sourceManifest = target.manifest ?? readManifestState(pageDir, meta).sourceManifest;
  const effectiveManifest = mergeManifests(sourceManifest, readManifestState(pageDir, meta).platformManifest);
  const updated = materializeManifest(meta, effectiveManifest);
  updated.currentVersion = localVersion;
  updated.currentAppVersion = target.appVersion;
  updated.previousVersion = recordPrevious && meta.currentVersion !== localVersion ? meta.currentVersion : undefined;
  updated.updatedAt = new Date().toISOString();
  commitSourceManifestAndMeta(
    pageDir,
    getPageMetaPath(dataDir, meta.userId, meta.name),
    sourceManifest,
    updated,
  );
  return {
    name: meta.name,
    ownerId: meta.userId,
    localVersion,
    appVersion: target.appVersion,
    digest: target.digest,
  };
}

function materializeStagedVersion(
  extractedDir: string,
  stagedVersionDir: string,
  manifest: Record<string, unknown>,
  inspected: InspectedAppPackage,
): void {
  const distDir = path.join(extractedDir, "dist");
  assertVersionHealthy(distDir);
  fs.mkdirSync(stagedVersionDir, { recursive: true });
  fs.cpSync(distDir, stagedVersionDir, { recursive: true });
  const backend = parseBackendConfig(manifest);
  if (backend) {
    const root = backend.root ?? "backend";
    const source = path.join(extractedDir, root);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(stagedVersionDir, root), { recursive: true });
  }
  materializeVersionMigrationSnapshot(extractedDir, stagedVersionDir, inspected);
  assertVersionHealthy(stagedVersionDir);
}

async function backfillRetainedVersionMigrationSnapshots(pageDir: string, meta: PageMeta): Promise<void> {
  for (const version of meta.versions) {
    if (!version.appVersion || !version.digest || !version.packagePath) continue;
    try {
      await ensureVersionMigrationSnapshot(pageDir, meta.name, version);
    } catch (error) {
      throw asInstallMigrationError(error, meta.name, version.version);
    }
  }
}

function asInstallMigrationError(error: unknown, appName: string, localVersion: number): AppInstallError {
  if (error instanceof AppInstallError) return error;
  const message = error instanceof VersionMigrationSnapshotError
    ? error.message
    : `Cannot prepare migrations for application ${appName} version ${localVersion}: ${error instanceof Error ? error.message : String(error)}`;
  return new AppInstallError("APP_MIGRATIONS_UNAVAILABLE", message, 409, undefined, { cause: error });
}

function validateStagedApplication(
  stagedVersionDir: string,
  manifest: Record<string, unknown>,
  platformVersion: string,
): {
  backend?: { root?: string; include?: string[] };
  business?: Record<string, BusinessMetadata & { routeAccess?: RouteAccess }>;
  collaboration?: CollaborationConfig;
  issueTemplates?: IssueTemplateConfig[];
} {
  assertPlatformCompatible(platformVersion);
  const backend = parseBackendConfig(manifest);
  const collaboration = parseCollaborationConfig(manifest);
  const business = parseBusinessConfig(manifest);
  const issueTemplates = parseIssueTemplatesConfig(manifest);
  const mutations: Record<string, unknown> = {};
  if (backend) {
    try {
      const contract = loadBackendContract(stagedVersionDir, backend);
      validateBackendContract(contract, { requireSecurity: requiresBackendSecurity(platformVersion) });
      const actionManifest = loadActionManifest(stagedVersionDir, backend);
      if (actionManifest) validateActionManifest(actionManifest, contract);
      Object.assign(mutations, contract.mutations);
    } catch (error) {
      throw new AppInstallError("APP_BACKEND_INVALID", error instanceof Error ? error.message : String(error), 400, undefined, { cause: error });
    }
  }
  const collaborationError = validateCollaborationMutations(collaboration, mutations);
  if (collaborationError) throw new AppInstallError("APP_BACKEND_INVALID", collaborationError, 400);
  return { backend, business, collaboration, issueTemplates };
}

function applyManifestMetadata(
  meta: PageMeta,
  parsed: ReturnType<typeof validateStagedApplication>,
): void {
  if (parsed.backend) meta.backend = parsed.backend;
  else delete meta.backend;
  if (parsed.business) meta.business = parsed.business;
  else delete meta.business;
  if (parsed.collaboration) meta.collaboration = parsed.collaboration;
  else delete meta.collaboration;
  if (parsed.issueTemplates) meta.issues = { templates: parsed.issueTemplates };
  else delete meta.issues;
}

async function validateMigrationHistory(pageDir: string, inspected: InspectedAppPackage): Promise<void> {
  const dbPath = path.join(pageDir, "app.db");
  if (!fs.existsSync(dbPath)) return;
  await getConnection(dbPath);
  const table = execRawSql(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_localapp_applied_migrations'");
  if ((table.rows ?? []).length === 0) return;
  const packageChecksums = new Map(inspected.entries
    .filter((entry) => entry.path.startsWith("migrations/"))
    .map((entry) => [path.posix.basename(entry.path), entry.sha256]));
  const applied = execRawSql(dbPath, "SELECT filename, checksum FROM _localapp_applied_migrations ORDER BY filename");
  for (const row of applied.rows ?? []) {
    const filename = String(row.filename);
    const checksum = String(row.checksum);
    const packaged = packageChecksums.get(filename);
    if (!packaged) {
      throw new AppInstallError(
        "APP_MIGRATION_CONFLICT",
        `Migration ${filename} has already been applied in production but is missing from this package. Restore the migration file instead of deleting it.`,
        409,
        filename,
      );
    }
    if (packaged !== checksum) {
      throw new AppInstallError(
        "APP_MIGRATION_CONFLICT",
        `Migration ${filename} has already been applied in production with a different checksum. Restore the original file or create a new migration.`,
        409,
        filename,
      );
    }
  }
}

function restoreDatabase(dbPath: string, backupPath: string, existed: boolean): void {
  closeConnectionsForPage(path.dirname(dbPath));
  if (existed && fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, dbPath);
  } else if (!existed) {
    fs.rmSync(dbPath, { force: true });
  }
}

function rotateAppDbBackups(pageDir: string): void {
  const appDb = path.join(pageDir, "app.db");
  if (!fs.existsSync(appDb)) return;
  const backupV1 = path.join(pageDir, "app.db.backup.v1");
  const backupV2 = path.join(pageDir, "app.db.backup.v2");
  if (fs.existsSync(backupV2)) fs.rmSync(backupV2, { force: true });
  if (fs.existsSync(backupV1)) fs.renameSync(backupV1, backupV2);
  fs.copyFileSync(appDb, backupV1);
}

function retainedVersions(meta: PageMeta): PageVersionMeta[] {
  if (meta.versions.length <= MAX_RETAINED_VERSIONS) return meta.versions;
  const protectedVersions = new Set(
    [meta.currentVersion, meta.previousVersion].filter((version): version is number => Boolean(version)),
  );
  return meta.versions
    .filter((entry) => protectedVersions.has(entry.version))
    .concat(meta.versions
      .filter((entry) => !protectedVersions.has(entry.version))
      .slice(-(MAX_RETAINED_VERSIONS - protectedVersions.size)))
    .sort((left, right) => left.version - right.version);
}

function cleanupOldVersions(
  pageDir: string,
  allVersions: readonly PageVersionMeta[],
  retained: readonly PageVersionMeta[],
): void {
  const retainedNumbers = new Set(retained.map((entry) => entry.version));
  for (const entry of allVersions) {
    if (!retainedNumbers.has(entry.version)) removeDirRecursive(path.join(pageDir, "versions", `v${entry.version}`));
  }
  const retainedPackages = new Set(retained.map((entry) => entry.packagePath).filter((value): value is string => Boolean(value)));
  const packageDir = path.join(pageDir, ".packages");
  if (!fs.existsSync(packageDir)) return;
  for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
    const relativePath = `.packages/${entry.name}`;
    if (entry.isFile() && !retainedPackages.has(relativePath)) fs.rmSync(path.join(packageDir, entry.name), { force: true });
  }
  syncDirectory(packageDir);
}

async function retainExactPackage(
  pageDir: string,
  localVersion: number,
  inspected: InspectedAppPackage,
): Promise<{ relativePath: string; created: boolean }> {
  const relativePath = `.packages/v${localVersion}-${inspected.digest}.localapp`;
  const finalPath = path.join(pageDir, relativePath);
  if (fs.existsSync(finalPath)) {
    const retained = await inspectAppPackage(finalPath);
    if (retained.digest !== inspected.digest) throw new AppInstallError("APP_PACKAGE_STORAGE_CONFLICT", "Retained package digest mismatch", 409);
    return { relativePath, created: false };
  }
  const directory = path.dirname(finalPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  syncDirectory(pageDir);
  const tempPath = path.join(directory, `.${path.basename(finalPath)}.${process.pid}.${crypto.randomUUID()}.partial`);
  try {
    await fs.promises.copyFile(inspected.packagePath, tempPath, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(tempPath, 0o600);
    const copied = await inspectAppPackage(tempPath);
    if (copied.digest !== inspected.digest) throw new AppInstallError("APP_PACKAGE_STORAGE_CORRUPT", "Retained package digest mismatch", 500);
    // syncFile owns the Windows rule that FlushFileBuffers needs a
    // write-capable handle: a read-only handle fails with EPERM there, which
    // aborted every install that had to retain its package.
    syncFile(tempPath);
    fs.renameSync(tempPath, finalPath);
    syncDirectory(directory);
    syncDirectory(pageDir);
    return { relativePath, created: true };
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function removeRetainedPackage(pageDir: string, relativePath: string): void {
  const packagePath = path.resolve(pageDir, relativePath);
  const packageRoot = path.resolve(pageDir, ".packages");
  if (path.dirname(packagePath) !== packageRoot) return;
  fs.rmSync(packagePath, { force: true });
  if (fs.existsSync(packageRoot)) syncDirectory(packageRoot);
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EINVAL", "EPERM", "EISDIR"].includes(code ?? "")) return;
    throw error;
  }
}

function assertVersionHealthy(versionDir: string): void {
  const indexPath = path.join(versionDir, "index.html");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(indexPath);
  } catch {
    throw new AppInstallError("APP_HEALTH_CHECK_FAILED", "Staged application is missing index.html", 400, "dist/index.html");
  }
  if (!stat.isFile()) throw new AppInstallError("APP_HEALTH_CHECK_FAILED", "Staged application index.html is not a file", 400, "dist/index.html");
}

function requiredMeta(dataDir: string, ownerId: string, name: string): PageMeta {
  const meta = readPageMeta(dataDir, ownerId, name);
  if (!meta) throw new AppInstallError("APP_NOT_FOUND", "Application not found", 404);
  return meta;
}

function createEmptyMeta(name: string, userId: string): PageMeta {
  const now = new Date().toISOString();
  return {
    name,
    userId,
    description: "",
    currentVersion: 0,
    createdAt: now,
    updatedAt: now,
    versions: [],
    metadata: {},
  };
}

function ownerIndependentManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const source = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  delete source.owner;
  delete source.ownerId;
  delete source.userId;
  return source;
}

function parseBusinessConfig(manifest: Record<string, unknown>): Record<string, BusinessMetadata & { routeAccess?: RouteAccess }> | undefined {
  return isRecord(manifest.business)
    ? manifest.business as Record<string, BusinessMetadata & { routeAccess?: RouteAccess }>
    : undefined;
}

function parseBackendConfig(manifest: Record<string, unknown>): { root?: string; include?: string[] } | undefined {
  if (!isRecord(manifest.backend)) return undefined;
  const root = typeof manifest.backend.root === "string" ? manifest.backend.root : undefined;
  const include = Array.isArray(manifest.backend.include)
    ? manifest.backend.include.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return { root, include };
}

function parseCollaborationConfig(manifest: Record<string, unknown>): CollaborationConfig | undefined {
  if (!isRecord(manifest.collaboration)) return undefined;
  const record = manifest.collaboration;
  if (typeof record.enabled !== "boolean") {
    throw new AppInstallError("APP_MANIFEST_INVALID", "collaboration.enabled must be a boolean", 400, "collaboration.enabled");
  }
  if (!record.enabled) return { enabled: false };
  if (!isRecord(record.resources) || Object.keys(record.resources).length === 0) {
    throw new AppInstallError("APP_MANIFEST_INVALID", "collaboration.resources must declare at least one resource when collaboration.enabled is true", 400, "collaboration.resources");
  }
  if (record.overlay !== undefined && typeof record.overlay !== "boolean") {
    throw new AppInstallError("APP_MANIFEST_INVALID", "collaboration.overlay must be a boolean", 400, "collaboration.overlay");
  }
  const resources: NonNullable<CollaborationConfig["resources"]> = {};
  for (const [name, value] of Object.entries(record.resources)) {
    if (!isRecord(value)) {
      throw new AppInstallError("APP_MANIFEST_INVALID", `collaboration.resources.${name} must be an object`, 400, `collaboration.resources.${name}`);
    }
    const mode = value.mode ?? "record-versioned";
    if (mode !== "record-versioned" && mode !== "crdt") {
      throw new AppInstallError("APP_MANIFEST_INVALID", `collaboration.resources.${name}.mode must be record-versioned or crdt`, 400, `collaboration.resources.${name}.mode`);
    }
    if (mode === "record-versioned") {
      if (typeof value.mutation !== "string" || !value.mutation.trim()) {
        throw new AppInstallError("APP_MANIFEST_INVALID", `collaboration.resources.${name}.mutation is required`, 400, `collaboration.resources.${name}.mutation`);
      }
      if (value.history !== undefined && typeof value.history !== "boolean") {
        throw new AppInstallError("APP_MANIFEST_INVALID", `collaboration.resources.${name}.history must be a boolean`, 400, `collaboration.resources.${name}.history`);
      }
      resources[name] = {
        mode: "record-versioned",
        mutation: value.mutation.trim(),
        ...(typeof value.history === "boolean" ? { history: value.history } : {}),
      };
      continue;
    }

    const levels = new Set(["public", "authenticated", "owner", "acl"]);
    const read = value.read ?? "authenticated";
    const write = value.write ?? "authenticated";
    if (typeof read !== "string" || !levels.has(read)) {
      throw new AppInstallError("APP_MANIFEST_INVALID", `collaboration.resources.${name}.read is invalid`, 400, `collaboration.resources.${name}.read`);
    }
    if (typeof write !== "string" || !levels.has(write) || write === "public") {
      throw new AppInstallError("APP_MANIFEST_INVALID", `collaboration.resources.${name}.write cannot be public`, 400, `collaboration.resources.${name}.write`);
    }
    if ((read === "acl" || write === "acl") && (!Array.isArray(value.acl) || value.acl.length === 0 || value.acl.some((entry) => typeof entry !== "string" || !entry.trim()))) {
      throw new AppInstallError("APP_MANIFEST_INVALID", `collaboration.resources.${name}.acl is required for acl access`, 400, `collaboration.resources.${name}.acl`);
    }
    const maxCrdtDocumentBytes = PLATFORM_CAPABILITIES.collaboration.crdt.maxDocumentBytes;
    if (value.maxDocumentBytes !== undefined && (typeof value.maxDocumentBytes !== "number" || !Number.isInteger(value.maxDocumentBytes) || value.maxDocumentBytes < 1024 || value.maxDocumentBytes > maxCrdtDocumentBytes)) {
      throw new AppInstallError("APP_MANIFEST_INVALID", `collaboration.resources.${name}.maxDocumentBytes must be between 1024 and ${maxCrdtDocumentBytes}`, 400, `collaboration.resources.${name}.maxDocumentBytes`);
    }
    if (value.awareness !== undefined && typeof value.awareness !== "boolean") {
      throw new AppInstallError("APP_MANIFEST_INVALID", `collaboration.resources.${name}.awareness must be a boolean`, 400, `collaboration.resources.${name}.awareness`);
    }
    if (value.overlay !== undefined && typeof value.overlay !== "boolean") {
      throw new AppInstallError("APP_MANIFEST_INVALID", `collaboration.resources.${name}.overlay must be a boolean`, 400, `collaboration.resources.${name}.overlay`);
    }
    resources[name] = {
      mode: "crdt",
      read: read as "public" | "authenticated" | "owner" | "acl",
      write: write as "authenticated" | "owner" | "acl",
      ...(Array.isArray(value.acl) ? { acl: value.acl.map((entry) => String(entry).trim()) } : {}),
      ...(typeof value.maxDocumentBytes === "number" ? { maxDocumentBytes: value.maxDocumentBytes } : {}),
      ...(typeof value.awareness === "boolean" ? { awareness: value.awareness } : {}),
      ...(typeof value.overlay === "boolean" ? { overlay: value.overlay } : {}),
    };
  }
  validateCrdtManifestRequirements(manifest, record, resources);
  return { enabled: true, ...(typeof record.overlay === "boolean" ? { overlay: record.overlay } : {}), resources };
}

function validateCrdtManifestRequirements(
  manifest: Record<string, unknown>,
  collaboration: Record<string, unknown>,
  resources: NonNullable<CollaborationConfig["resources"]>,
): void {
  const crdtResources = Object.values(resources).filter((resource) => resource.mode === "crdt");
  if (crdtResources.length === 0) return;
  const platformRange = typeof manifest.platformVersion === "string" ? manifest.platformVersion : "";
  const minimum = minimumVersionForRange(platformRange);
  if (!minimum || compareVersionTuple(minimum, CRDT_MIN_PLATFORM_VERSION) < 0) {
    throw new AppInstallError("APP_MANIFEST_INVALID", "CRDT collaboration requires platformVersion ^1.3 or a range with minimum 1.3", 400, "platformVersion");
  }
  const requires = isRecord(manifest.requires) ? manifest.requires : undefined;
  const primitives = Array.isArray(requires?.primitives)
    ? new Set(requires.primitives.filter((value): value is string => typeof value === "string"))
    : new Set<string>();
  if (!primitives.has("crdt")) {
    throw new AppInstallError("APP_MANIFEST_INVALID", "CRDT collaboration requires requires.primitives to include crdt", 400, "requires.primitives");
  }
  const usesOverlay = collaboration.overlay !== false && crdtResources.some((resource) =>
    resource.awareness !== false && resource.overlay !== false,
  );
  if (usesOverlay && !primitives.has("editing-awareness-overlay")) {
    throw new AppInstallError("APP_MANIFEST_INVALID", "CRDT editing overlay requires requires.primitives to include editing-awareness-overlay", 400, "requires.primitives");
  }
}

function validateCollaborationMutations(collaboration: CollaborationConfig | undefined, mutations: Record<string, unknown>): string | null {
  if (!collaboration?.enabled) return null;
  for (const [resourceName, resource] of Object.entries(collaboration.resources ?? {})) {
    if (resource.mode !== "record-versioned") continue;
    if (!mutations[resource.mutation]) {
      return `collaboration.resources.${resourceName}.mutation references unknown backend mutation: ${resource.mutation}`;
    }
  }
  return null;
}

function assertPlatformCompatible(range: string): void {
  if (!isCompatiblePlatformVersion(range, CURRENT_PLATFORM_VERSION)) {
    throw new AppInstallError(
      "APP_PLATFORM_VERSION_MISMATCH",
      `Platform version mismatch. App requires ${range}, server is ${CURRENT_PLATFORM_VERSION}.`,
      400,
      "platformVersion",
    );
  }
}

function isCompatiblePlatformVersion(range: string, version: string): boolean {
  const trimmed = range.trim();
  if (trimmed.startsWith("^")) {
    const minimum = parseRangeVersion(trimmed.slice(1));
    const current = parseRangeVersion(version);
    if (!minimum || !current) return false;
    const maximum: [number, number, number] = minimum[0] > 0
      ? [minimum[0] + 1, 0, 0]
      : minimum[1] > 0 ? [0, minimum[1] + 1, 0] : [0, 0, minimum[2] + 1];
    return compareVersionTuple(current, minimum) >= 0 && compareVersionTuple(current, maximum) < 0;
  }
  const bounded = trimmed.match(/^>=\s*([^\s,]+)\s*,?\s*<\s*([^\s,]+)$/);
  if (!bounded) return false;
  const current = parseRangeVersion(version);
  const minimum = parseRangeVersion(bounded[1]);
  const maximum = parseRangeVersion(bounded[2]);
  return current !== null && minimum !== null && maximum !== null
    && compareVersionTuple(current, minimum) >= 0 && compareVersionTuple(current, maximum) < 0;
}

function minimumVersionForRange(range: string): [number, number, number] | null {
  const trimmed = range.trim();
  if (trimmed.startsWith("^")) return parseRangeVersion(trimmed.slice(1));
  const bounded = trimmed.match(/^>=\s*([^\s,]+)\s*,?\s*<\s*([^\s,]+)$/);
  return bounded ? parseRangeVersion(bounded[1]) : null;
}

function parseRangeVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

function requiresBackendSecurity(platformVersion: string): boolean {
  if (!PLATFORM_CAPABILITIES.backend.securityContracts.enabled) return false;
  const required = parseVersionTuple(PLATFORM_CAPABILITIES.backend.securityContracts.requiredFromPlatformVersion);
  if (!required) return false;
  const range = platformVersion.trim();
  const match = range.match(/^\^(\d+)(?:\.(\d+))?/) ?? range.match(/^>=\s*(\d+)(?:\.(\d+))?/);
  return Boolean(match && compareVersionTuple([Number(match[1]), Number(match[2] ?? 0), 0], required) >= 0);
}

function parseVersionTuple(value: string): [number, number, number] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersionTuple(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function isMigrationError(error: unknown): error is Error & { filename: string } {
  return error instanceof Error && typeof (error as { filename?: unknown }).filename === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
