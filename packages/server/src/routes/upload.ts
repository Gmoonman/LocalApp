import type { FastifyInstance, FastifyRequest } from "fastify";
import { registerApplicationUpload, type ApplicationUploadHost } from "@localapp/dsh-app-platform/upload-routes";
import { findUserById } from "../lib/meta-sqlite.js";
import { requestPublicOrigin } from "../lib/request-origin.js";

export function createApplicationUploadHost(app: FastifyInstance): ApplicationUploadHost {
  return {
    dataDir: app.config.dataDir,
    userId: request => (request as FastifyRequest).userId,
    displayName: userId => findUserById(userId)?.displayName ?? undefined,
    publicOrigin: request => requestPublicOrigin(request as FastifyRequest),
  };
}

export async function uploadRoutes(app: FastifyInstance) {
  await registerApplicationUpload(app, createApplicationUploadHost(app));
}
