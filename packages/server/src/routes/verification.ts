import type { FastifyInstance } from "fastify";
import { registerVerification, type VerificationRoutesHost } from "@localapp/dsh-app-platform/verification-routes";
import { validateApiKey } from "../lib/meta-sqlite.js";
import { requestPublicOrigin } from "../lib/request-origin.js";
export function createVerificationHost(app: FastifyInstance): VerificationRoutesHost {
  return { dataDir: app.config.dataDir, sessions: app.verificationSessions, keyOwner: validateApiKey, publicOrigin: requestPublicOrigin };
}
export async function verificationRoutes(app: FastifyInstance) { return registerVerification(app, createVerificationHost(app)); }
