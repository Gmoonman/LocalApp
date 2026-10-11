import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { VerificationSessionStore } from "../lib/verification-sessions.js";

declare module "fastify" {
  interface FastifyInstance {
    verificationSessions: VerificationSessionStore;
  }
}

export interface VerificationPluginOptions { createStore(dataDir: string): VerificationSessionStore; }
async function verification(app: FastifyInstance, options: VerificationPluginOptions) {
  app.decorate("verificationSessions", options.createStore(app.config.dataDir));
}

export const verificationPlugin = fp(verification, {
  name: "verification",
  dependencies: ["storage"],
});
