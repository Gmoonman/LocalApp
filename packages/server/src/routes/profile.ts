import { registerOwnApplicationPages, type OwnApplicationPagesHost } from "@localapp/dsh-app-platform/own-pages-routes";
import type { FastifyInstance } from "fastify";
import {
  updateUserProfile,
  updateUserAvatar,
  listAllUsersBasic,
} from "../lib/meta-sqlite.js";
import { deleteAppObjects } from "../lib/s3-client.js";
import { registerProfileRoutes, type ProfileHost } from "@localapp/dsh-multiuser/profile-routes";
import { createAuthenticationHost } from "./auth.js";
export function createProfileHost(app: FastifyInstance): ProfileHost {
  return { ...createAuthenticationHost(app), dataDir: app.config.dataDir,
    updateUserProfile, updateUserAvatar, listAllUsersBasic,
    file: req => req.file(),
  };
}
export async function profileRoutes(app: FastifyInstance) {
  await registerProfileRoutes(app, createProfileHost(app));
  await profilePageRoutes(app);
}
export function createOwnApplicationPagesHost(app: FastifyInstance): OwnApplicationPagesHost {
  return { dataDir: app.config.dataDir, visitorId: req => req.visitorId, deleteAppObjects };
}
export async function profilePageRoutes(app: FastifyInstance) {
  return registerOwnApplicationPages(app, createOwnApplicationPagesHost(app));
}
