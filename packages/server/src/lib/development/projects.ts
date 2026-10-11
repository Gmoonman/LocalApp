export * from "@localapp/dsh-app-development/projects";
import { ProjectStore as PluginProjectStore } from "@localapp/dsh-app-development/projects";
import { getDb, flushMetaDb } from "../meta-sqlite.js";

export class ProjectStore extends PluginProjectStore {
  constructor(dataDir: string) { super(dataDir, { database: getDb, flush: flushMetaDb }); }
}
