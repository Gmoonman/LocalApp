import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import initSqlJs from "sql.js";
import { AppInstallError, installAppPackage, rollbackAppVersion, verifyInstalledAppVersion, type InstallAppPackageInput, type InstallOutcome } from "./app-installer.cjs";
import { inspectAppPackage } from "./app-package.cjs";
import { AppDataError } from "./app-data-errors.cjs";
import { createAppBackup, importAppData, restoreAppBackupExact } from "./app-data-service.cjs";
import { getPageDir, readPageMeta } from "./page-storage.cjs";
import type { AppDataIdentity } from "./app-data-service.cjs";
import { removeDirRecursive } from "./file-utils.cjs";
import { SyncSessionError, SyncSessionStore, type SyncSessionRecord } from "./sync-session-store.cjs";

export interface SyncCommitResult {
  session: SyncSessionRecord;
  outcome: InstallOutcome;
  backupId: string | null;
}

export class AppSyncTarget {
  private stopped = false;

  get active(): boolean { return !this.stopped; }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const stream of this.uploads.values()) {
      stream.destroy(new SyncSessionError("SYNC_TARGET_STOPPED", "Synchronization target is stopped", 503));
    }
    await Promise.allSettled([...this.uploads.keys(), ...this.commits.values()]);
  }

  private readonly uploads = new Map<Promise<SyncSessionRecord>, Readable>();

  receivePackage(input: Parameters<SyncSessionStore["receivePackage"]>[0]): Promise<SyncSessionRecord> {
    return this.receive(input, () => this.sessions.receivePackage(input));
  }

  receiveData(input: Parameters<SyncSessionStore["receiveData"]>[0]): Promise<SyncSessionRecord> {
    return this.receive(input, () => this.sessions.receiveData(input));
  }

  private async receive(input: { stream: Readable }, operation: () => Promise<SyncSessionRecord>): Promise<SyncSessionRecord> {
    this.assertActive();
    // Shutdown may destroy the stream while the store is opening its partial file.
    const onError = () => undefined;
    input.stream.on("error", onError);
    const run = operation();
    this.uploads.set(run, input.stream);
    try { return await run; }
    finally {
      this.uploads.delete(run);
      input.stream.off("error", onError);
    }
  }

  private assertActive(): void {
    if (this.stopped) throw new SyncSessionError("SYNC_TARGET_STOPPED", "Synchronization target is stopped", 503);
  }

  private readonly commits = new Map<string, Promise<SyncCommitResult>>();
  private readonly install: (input: InstallAppPackageInput) => Promise<InstallOutcome>;
  private readonly createBackup: typeof createAppBackup;
  private readonly importData: typeof importAppData;
  private readonly restoreBackup: typeof restoreAppBackupExact;
  private readonly rollbackVersion: typeof rollbackAppVersion;

  constructor(
    private readonly dataDir: string,
    readonly sessions: SyncSessionStore,
    options: {
      install?: (input: InstallAppPackageInput) => Promise<InstallOutcome>;
      createBackup?: typeof createAppBackup;
      importData?: typeof importAppData;
      restoreBackup?: typeof restoreAppBackupExact;
      rollbackVersion?: typeof rollbackAppVersion;
    } = {},
  ) {
    this.install = options.install ?? installAppPackage;
    this.createBackup = options.createBackup ?? createAppBackup;
    this.importData = options.importData ?? importAppData;
    this.restoreBackup = options.restoreBackup ?? restoreAppBackupExact;
    this.rollbackVersion = options.rollbackVersion ?? rollbackAppVersion;
  }

  create(input: {
    id: string; ownerId: string; mode: "app-only" | "app-and-data"; appName: string; appVersion: string; packageDigest: string; packageSize: number;
    dataDigest?: string | null; dataSize?: number | null;
  }): SyncSessionRecord {
    this.assertActive();
    const prior = this.sessions.get(input.id);
    if (prior && prior.ownerId !== input.ownerId) {
      throw new SyncSessionError("SYNC_SESSION_NOT_FOUND", "Synchronization session not found", 404);
    }
    const existing = readPageMeta(this.dataDir, input.ownerId, input.appName);
    const knownDigest = existing?.packageIdentities?.[input.appVersion]?.digest
      ?? existing?.versions.find((entry) => entry.appVersion === input.appVersion)?.digest;
    if (knownDigest && knownDigest !== input.packageDigest) {
      throw new SyncSessionError("APP_VERSION_DIGEST_CONFLICT", `Application version ${input.appVersion} already exists with another digest`, 409);
    }
    return this.sessions.create(input);
  }

  async commit(id: string, ownerId: string): Promise<SyncCommitResult> {
    this.assertActive();
    const session = this.sessions.getOwned(id, ownerId);
    if (!session) return Promise.reject(new SyncSessionError("SYNC_SESSION_NOT_FOUND", "Synchronization session not found", 404));
    if (session.status === "completed" && session.outcome) {
      const { backupId, ...outcome } = session.outcome;
      return Promise.resolve({
        session,
        outcome: outcome as unknown as InstallOutcome,
        backupId: typeof backupId === "string" ? backupId : null,
      });
    }
    if (session.status === "recovery-required") {
      return Promise.reject(new SyncSessionError("SYNC_RECOVERY_REQUIRED", "Synchronization requires operator recovery", 409));
    }
    const inFlight = this.commits.get(id);
    if (inFlight) return inFlight;
    if (session.status === "committing") {
      return Promise.reject(new SyncSessionError("SYNC_COMMIT_IN_PROGRESS", "Synchronization commit is in progress", 409));
    }
    if (session.status !== "uploaded" && session.status !== "failed") {
      return Promise.reject(new SyncSessionError("SYNC_PACKAGE_REQUIRED", "A verified package upload is required", 409));
    }
    const run = (async () => {
      if (session.mode === "app-and-data" && !(await hasVerifiedDataArchive(this.sessions, session))) {
        throw new SyncSessionError("SYNC_DATA_REQUIRED", "A verified application data upload is required", 409);
      }
      return this.executeCommit(session, ownerId);
    })();
    this.commits.set(id, run);
    void run.finally(() => { if (this.commits.get(id) === run) this.commits.delete(id); }).catch(() => undefined);
    return run;
  }

  private async executeCommit(session: SyncSessionRecord, ownerId: string): Promise<SyncCommitResult> {
    const id = session.id;
    const packagePath = this.sessions.packagePath(id);
    const inspected = await inspectAppPackage(packagePath);
    if (inspected.name !== session.appName || inspected.version !== session.appVersion || inspected.digest !== session.packageDigest) {
      throw new SyncSessionError("SYNC_PACKAGE_METADATA_MISMATCH", "Package metadata does not match the synchronization session", 409);
    }
    this.sessions.transition(id, ownerId, "committing");
    const pageDir = getPageDir(this.dataDir, ownerId, session.appName);
    const previousMeta = readPageMeta(this.dataDir, ownerId, session.appName);
    const previousDatabaseExisted = fsExists(path.join(pageDir, "app.db"));
    let safetyBackupId: string | undefined;
    try {
      if (session.mode === "app-and-data" && previousMeta) {
        const safety = await this.createSafetyBackup(pageDir, previousMeta, ownerId, session.appName, previousDatabaseExisted);
        safetyBackupId = safety.id;
      }
      const outcome = await this.install({ dataDir: this.dataDir, ownerId, packagePath, preserveTargetAccess: true });
      if (session.mode === "app-and-data") {
        const currentMeta = readPageMeta(this.dataDir, ownerId, session.appName);
        if (!currentMeta) throw new AppDataError("APP_DATABASE_NOT_FOUND", "Application metadata disappeared during data synchronization");
        const versionChanged = !previousMeta || currentMeta.currentVersion !== previousMeta.currentVersion;
        try {
          if (!previousMeta) {
            const safety = await this.createSafetyBackup(
              pageDir, currentMeta, ownerId, session.appName, fsExists(path.join(pageDir, "app.db")),
            );
            safetyBackupId = safety.id;
          }
          const imported = await this.importData({
            pageDir,
            application: pageIdentity(currentMeta, ownerId, session.appName),
            archivePath: this.sessions.dataPath(id),
            reason: "peer-data-sync",
            ...(safetyBackupId ? { safetyBackupId } : {}),
          });
          safetyBackupId ??= imported.safetyBackupId;
        } catch (dataError) {
          await this.rollbackAfterDataFailure({
            pageDir, ownerId, appName: session.appName, previousMeta, currentMeta,
            safetyBackupId, versionChanged, previousDatabaseExisted,
          });
          throw recoveredDataFailure(dataError);
        }
      }
      return {
        session: this.sessions.transition(id, ownerId, "completed", {
          outcome: { ...outcome, backupId: safetyBackupId ?? null },
        }),
        outcome,
        backupId: safetyBackupId ?? null,
      };
    } catch (error) {
      this.sessions.transition(id, ownerId, isRecoveryRequired(error)
        ? "recovery-required" : "failed", { error: publicInstallError(error) });
      throw error;
    }
  }

  async reconcileInterrupted(): Promise<number> {
    let reconciled = 0;
    for (const session of this.sessions.list()) {
      if (session.status !== "committing") continue;
      if (session.mode === "app-and-data") {
        this.sessions.transition(session.id, session.ownerId, "recovery-required", {
          error: "Server restarted during application and data replacement; operator verification is required",
        });
        reconciled += 1;
        continue;
      }
      try {
        const version = await verifyInstalledAppVersion({
          dataDir: this.dataDir, ownerId: session.ownerId, appName: session.appName,
          appVersion: session.appVersion, digest: session.packageDigest,
        });
        const outcome: InstallOutcome = {
          name: session.appName, ownerId: session.ownerId, localVersion: version.version,
          appVersion: session.appVersion, digest: session.packageDigest,
          created: false, upgraded: false, idempotent: true,
        };
        this.sessions.transition(session.id, session.ownerId, "completed", { outcome: outcome as unknown as Record<string, unknown> });
      } catch {
        this.sessions.transition(session.id, session.ownerId, "recovery-required", {
          error: "Server restarted before synchronization commit outcome could be verified",
        });
      }
      reconciled += 1;
    }
    return reconciled;
  }

  private async rollbackAfterDataFailure(input: {
    pageDir: string;
    ownerId: string;
    appName: string;
    previousMeta: ReturnType<typeof readPageMeta>;
    currentMeta: NonNullable<ReturnType<typeof readPageMeta>>;
    safetyBackupId?: string;
    versionChanged: boolean;
    previousDatabaseExisted: boolean;
  }): Promise<void> {
    try {
      if (input.previousMeta && input.safetyBackupId) {
        if (input.versionChanged) await this.rollbackVersion({ dataDir: this.dataDir, ownerId: input.ownerId, name: input.appName });
        await this.restoreBackup(input.pageDir, input.safetyBackupId, {
          application: pageIdentity(input.previousMeta, input.ownerId, input.appName),
        });
        if (!input.previousDatabaseExisted) fs.rmSync(path.join(input.pageDir, "app.db"), { force: true });
      } else if (!input.previousMeta) {
        if (input.safetyBackupId) {
          await this.restoreBackup(input.pageDir, input.safetyBackupId, {
            application: pageIdentity(input.currentMeta, input.ownerId, input.appName),
          });
        }
        removeDirRecursive(input.pageDir);
      } else if (input.versionChanged) {
        await this.rollbackVersion({ dataDir: this.dataDir, ownerId: input.ownerId, name: input.appName });
      }
    } catch (rollbackError) {
      throw new AppInstallError(
        "APP_INSTALL_RECOVERY_REQUIRED",
        `Application and data replacement failed and rollback could not complete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        503,
        undefined,
        { cause: rollbackError },
      );
    }
  }

  private async createSafetyBackup(
    pageDir: string,
    previousMeta: NonNullable<ReturnType<typeof readPageMeta>>,
    ownerId: string,
    appName: string,
    databaseExisted: boolean,
  ) {
    const databasePath = path.join(pageDir, "app.db");
    if (!databaseExisted) {
      const SQL = await initSqlJs();
      const database = new SQL.Database();
      try { fs.writeFileSync(databasePath, Buffer.from(database.export()), { mode: 0o600 }); }
      finally { database.close(); }
    }
    try {
      return await this.createBackup(pageDir, {
        application: pageIdentity(previousMeta, ownerId, appName),
        source: "automatic",
        reason: "peer-data-sync",
      });
    } finally {
      if (!databaseExisted) fs.rmSync(databasePath, { force: true });
    }
  }
}

function recoveredDataFailure(error: unknown): unknown {
  return error instanceof AppDataError && error.code === "APP_DATA_ROLLBACK_FAILED"
    ? new AppDataError("APP_DATA_IMPORT_FAILED", "Application data replacement failed; the target state was restored")
    : error;
}

function isRecoveryRequired(error: unknown): boolean {
  return (error instanceof AppInstallError && error.code === "APP_INSTALL_RECOVERY_REQUIRED")
    || (error instanceof AppDataError && error.code === "APP_DATA_ROLLBACK_FAILED")
    || (error instanceof SyncSessionError && error.code === "SYNC_RECOVERY_REQUIRED");
}

export function targetInstallStatus(error: unknown): number {
  if (error instanceof SyncSessionError) return error.statusCode;
  if (error instanceof AppInstallError) return error.code === "APP_MIGRATION_APPLY_FAILED" ? 422 : error.statusCode;
  if (error instanceof AppDataError) return 422;
  return 400;
}

export function targetInstallCode(error: unknown): string {
  if (error instanceof SyncSessionError || error instanceof AppInstallError || error instanceof AppDataError) return error.code;
  return "SYNC_COMMIT_FAILED";
}

function publicInstallError(error: unknown): string {
  return error instanceof AppInstallError || error instanceof SyncSessionError || error instanceof AppDataError ? error.message : "Synchronization commit failed";
}

async function hasVerifiedDataArchive(sessions: SyncSessionStore, session: SyncSessionRecord): Promise<boolean> {
  if (session.dataDigest === null || session.dataSize === null) return false;
  const archivePath = sessions.dataPath(session.id);
  if (!fsExists(archivePath)) return false;
  return fsStatSize(archivePath) === session.dataSize && await sha256File(archivePath) === session.dataDigest;
}

function pageIdentity(meta: NonNullable<ReturnType<typeof readPageMeta>>, owner: string, name: string): AppDataIdentity {
  return { owner, name, version: meta.currentVersion };
}

function fsExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function fsStatSize(filePath: string): number {
  return fs.statSync(filePath).size;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
