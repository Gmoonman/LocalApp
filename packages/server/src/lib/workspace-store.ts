import { WorkspaceStore as PluginWorkspaceStore, type WorkspaceStoreOptions } from "@localapp/dsh-app-development/workspace-store";
import { getDb, flushMetaDb, getUserRole } from "./meta-sqlite.js";
export type { WorkspaceRecord, WorkspaceArchiveLimits, WorkspaceStoreOptions, WorkspaceFileOperations } from "@localapp/dsh-app-development/workspace-store";
export class WorkspaceStore extends PluginWorkspaceStore {
  constructor(options: WorkspaceStoreOptions) {
    super({ ...options, authorizeExecution: options.authorizeExecution ?? (user => getUserRole(user) === "admin") }, { database: getDb, flush: flushMetaDb });
  }
}
