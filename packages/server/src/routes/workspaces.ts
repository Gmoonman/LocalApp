import type { FastifyInstance } from "fastify";
import type { WorkspaceStore } from "../lib/workspace-store.js";
import { getUserRole } from "../lib/meta-sqlite.js";
import { registerWorkspaces } from "@localapp/dsh-app-development/workspaces-routes";
export function createWorkspaceRoutesHost(store: WorkspaceStore) {
  return { store, user: (request: import("fastify").FastifyRequest) => request.userId, isAdministrator: (user: string) => getUserRole(user) === "admin" };
}
export function workspacesRoutes(app: FastifyInstance, store: WorkspaceStore): Promise<void> {
  return registerWorkspaces(app, createWorkspaceRoutesHost(store));
}
