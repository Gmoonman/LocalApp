import { createApplicationCrdt } from "@localapp/dsh-app-platform/crdt-handler";
import { findUserById, validateApiKey } from "../lib/meta-sqlite.js";

export function createCrdtHandlers() {
  return createApplicationCrdt({
    visitorId: request => request.visitorId,
    verification: request => request.verificationSession,
    user: findUserById, validateApiKey,
  });
}
