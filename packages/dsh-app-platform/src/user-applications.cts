import fs from "node:fs";
import path from "node:path";
import { readPageMeta, getUserTotalSize } from "./page-storage.cjs";
import { removeDirRecursive } from "./file-utils.cjs";
import { closeConnectionsForPage } from "./app-db.cjs";
import { withAppDataMaintenance } from "./app-data-maintenance.cjs";
export interface UserApplicationsHost {
  dataDir: string;
  deleteAppObjects(owner: string, name: string): Promise<void>;
}
export function createUserApplicationManagement(host: UserApplicationsHost) {
  const dataDir = host.dataDir;
  return {
    applicationSummary(id: string) {
      const userDir = path.join(dataDir, id);
      if (!fs.existsSync(userDir)) return { pages: 0, storageUsed: 0 };
      const pages = fs.readdirSync(userDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && fs.existsSync(path.join(userDir, entry.name, "meta.json"))).length;
      return { pages, storageUsed: getUserTotalSize(dataDir, id) };
    },
    listApplications(id: string) {
      const userDir = path.join(dataDir, id);
      if (!fs.existsSync(userDir)) return [];
      return fs.readdirSync(userDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
        const meta = readPageMeta(dataDir, id, entry.name);
        return meta ? [{ name: meta.name, currentVersion: meta.currentVersion, updatedAt: meta.updatedAt }] : [];
      });
    },
    async deleteUserApplications(id: string, deleteAccount: () => void) {
      // Close all DB connections for user's pages
      const userDir = path.join(dataDir, id);
      if (fs.existsSync(userDir)) {
        const appNames = fs.readdirSync(userDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
        const deleteWithReservations = async (index: number): Promise<void> => {
          if (index >= appNames.length) {
            removeDirRecursive(userDir);
            deleteAccount();
            return;
          }
          const appName = appNames[index];
          const pageDir = path.join(userDir, appName);
          await withAppDataMaintenance(pageDir, async () => {
            closeConnectionsForPage(pageDir);
            await host.deleteAppObjects(id, appName);
            await deleteWithReservations(index + 1);
          });
        };
        await deleteWithReservations(0);
      } else {
        deleteAccount();
      }
    },
  };
}
