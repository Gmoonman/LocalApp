export { readDevelopmentSettings, saveDevelopmentSettings, type DevelopmentSettings } from "@localapp/dsh-app-development/environment";
import { developmentEnvironment as pluginEnvironment } from "@localapp/dsh-app-development/environment";
import { createBuildOperations } from "./builds.js";
export function developmentEnvironment(dataDir: string) {
 return pluginEnvironment(dataDir, createBuildOperations().createExecutor);
}
