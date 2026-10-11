export * from "@localapp/dsh-app-development/builds";
import { DevelopmentBuilds as PluginBuilds, type BuildTask, createBuildOperations } from "@localapp/dsh-app-development/builds";
import type { ProjectStore } from "./projects.js";
import type { ValidatedProjectManifest } from "../../project/check.js";

export class DevelopmentBuilds extends PluginBuilds<ValidatedProjectManifest> {
  constructor(dataDir: string, projects: ProjectStore, task?: BuildTask) {
    super(dataDir, projects, task, createBuildOperations());
  }
}
