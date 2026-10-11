import { SyncJobStore as PluginSyncJobStore } from "@localapp/dsh-app-platform/sync-job-store";
import { getDb, flushMetaDb } from "./meta-sqlite.js";
export * from "@localapp/dsh-app-platform/sync-job-store";
export class SyncJobStore extends PluginSyncJobStore {
 constructor() { super({ database: getDb, flush: flushMetaDb }); }
}
