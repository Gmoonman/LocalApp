import type { ArchiveLimits } from "./app-data-archive.cjs";
import { AppDataError } from "./app-data-errors.cjs";
import { withAppDataMaintenance } from "./app-data-maintenance.cjs";
import {
  createAppBackup,
  deleteAppBackup,
  getAppBackup,
  getAppBackupPath,
  inferAppDataIdentity,
  listAppBackups,
  replaceAppDatabase,
  resetApplicationData,
  restoreAppBackup,
  validateAppDatabase,
  type AppBackup,
  type AppBackupFormat,
  type AppBackupSource,
  type AppDataIdentity,
  type AppDataStorage,
} from "./app-data-service.cjs";

export { AppDataError };
export type {
  AppBackup,
  AppBackupFormat,
  AppBackupSource,
  AppDataIdentity,
  AppDataStorage,
};
export {
  createAppBackup,
  deleteAppBackup,
  getAppBackup,
  getAppBackupPath,
  listAppBackups,
  replaceAppDatabase,
  restoreAppBackup,
  validateAppDatabase,
};

export function withAppDataLock<T>(pageDir: string, operation: () => Promise<T>): Promise<T> {
  return withAppDataMaintenance(pageDir, operation);
}

export async function resetAppDatabase(
  pageDir: string,
  options: { application?: AppDataIdentity; limits?: ArchiveLimits; storage?: AppDataStorage } = {},
): Promise<void> {
  await resetApplicationData({
    pageDir,
    application: options.application ?? inferAppDataIdentity(pageDir),
    limits: options.limits,
    storage: options.storage,
  });
}
