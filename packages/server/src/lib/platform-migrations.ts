import path from "node:path";
import { applyPlatformMigrationsToAllApps as apply, type ApplyPlatformMigrationsOptions as PluginOptions } from "@localapp/dsh-app-platform/platform-migrations";
export type ApplyPlatformMigrationsOptions = Omit<PluginOptions, "migrationsDir"> & { migrationsDir?: string };
export async function applyPlatformMigrationsToAllApps(options: ApplyPlatformMigrationsOptions): Promise<void> {
  return apply({ ...options, migrationsDir: options.migrationsDir ?? path.resolve(__dirname, "../../platform-migrations") });
}
