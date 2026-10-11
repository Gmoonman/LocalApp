import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { registerSetupRoutes, type SetupHost } from "@localapp/dsh-multiuser/setup-routes";
import { accountServices } from "../lib/meta-sqlite.js";
import type { SetupTokenStore } from "../lib/setup-token-store.js";
export function createSetupHost(app: FastifyInstance, tokens: SetupTokenStore): SetupHost {
  return { accounts: accountServices.accounts, tokens, bootstrapApiKey: app.config.bootstrapApiKey,
    hashPassword: (password, rounds) => bcrypt.hash(password, rounds) };
}
export async function setupRoutes(app: FastifyInstance, tokens: SetupTokenStore): Promise<void> {
  await registerSetupRoutes(app, createSetupHost(app, tokens));
}
