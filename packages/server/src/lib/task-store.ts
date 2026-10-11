import { TaskStore as PluginTaskStore } from "@localapp/dsh-app-development/task-store";
import { getDb, flushMetaDb } from "./meta-sqlite.js";
export type { TaskKind, TaskStatus, TaskRecord, CreateTaskInput } from "@localapp/dsh-app-development/task-store";
export class TaskStore extends PluginTaskStore {
  constructor() { super({ database: getDb, flush: flushMetaDb }); }
}
