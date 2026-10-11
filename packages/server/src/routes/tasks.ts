import type { FastifyInstance } from "fastify";
import { registerTasks } from "@localapp/dsh-app-development/tasks-routes";
import { getUserRole } from "../lib/meta-sqlite.js";
export type TaskRouteServices = Omit<Parameters<typeof registerTasks>[1], "user" | "isAdministrator">;
export function createTaskRoutesHost(services: TaskRouteServices) {
 return { ...services, user: (request: import("fastify").FastifyRequest) => request.userId, isAdministrator: (user: string) => getUserRole(user) === "admin" };
}
export function tasksRoutes(app: FastifyInstance, services: TaskRouteServices) { return registerTasks(app, createTaskRoutesHost(services)); }
