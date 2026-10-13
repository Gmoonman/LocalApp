import type { FastifyInstance } from "fastify";
import { registerDeviceControl, type DeviceControlHost } from "@localapp/dsh-device-services/device-control-routes";
import { executeDeviceAction } from "../lib/device-action-executor.js";
import { getUserRole } from "../lib/meta-sqlite.js";
import { requireRequestUser } from "../plugins/auth.js";
export function createDeviceControlHost(app: FastifyInstance): DeviceControlHost {
  return { config: app.config, execute: executeDeviceAction, requireUser: requireRequestUser, userRole: getUserRole };
}
export async function deviceControlRoutes(app: FastifyInstance) { return registerDeviceControl(app, createDeviceControlHost(app)); }
