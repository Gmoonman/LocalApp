import path from "node:path";
import { TaskRunner as PluginTaskRunner, type TaskRunnerOptions as PluginOptions } from "@localapp/dsh-app-development/task-runner";
import { getUserRole } from "./meta-sqlite.js";
export * from "@localapp/dsh-app-development/task-runner";
export type TaskRunnerOptions = Omit<PluginOptions, "supervisorPath"> & { supervisorPath?: string };
export class TaskRunner extends PluginTaskRunner {
  constructor(options: TaskRunnerOptions) {
    super({ ...options, supervisorPath: options.supervisorPath ?? path.resolve(__dirname, "../../runner/task-supervisor.mjs"), authorizeExecution: options.authorizeExecution ?? (user => getUserRole(user) === "admin") });
  }
}
