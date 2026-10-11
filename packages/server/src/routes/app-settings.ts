import type { FastifyInstance } from "fastify";
import { registerApplicationSettings, type ApplicationSettingsHost } from "@localapp/dsh-app-platform/settings-routes";
import { registerApplicationDataSettings, type ApplicationDataSettingsHost } from "@localapp/dsh-app-platform/data-settings-routes";
export function createApplicationSettingsHost(app: FastifyInstance): ApplicationSettingsHost {
  return { dataDir: app.config.dataDir, visitorId: req => req.visitorId };
}
export function createApplicationDataSettingsHost(app: FastifyInstance): ApplicationDataSettingsHost {
  return { ...createApplicationSettingsHost(app), appDataArchiveMaxBytes: app.config.appDataArchiveMaxBytes,
    appDataExpandedMaxBytes: app.config.appDataExpandedMaxBytes, appDataArchiveMaxFiles: app.config.appDataArchiveMaxFiles };
}
export async function appSettingsRoutes(app: FastifyInstance) {
  await registerApplicationSettings(app, createApplicationSettingsHost(app));
  await appDataSettingsRoutes(app);
}
export async function appDataSettingsRoutes(app: FastifyInstance) {
  await registerApplicationDataSettings(app, createApplicationDataSettingsHost(app));
}
