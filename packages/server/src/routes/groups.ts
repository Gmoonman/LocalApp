import type { FastifyInstance, FastifyRequest } from "fastify";
import { registerGroupRoutes, type GroupRoutesHost } from "@localapp/dsh-multiuser/groups-routes";
import { createGroup, findGroupById, listGroupsByUser, updateGroup, deleteGroup,
  addGroupMembers, removeGroupMembers, getGroupMembers, getUserRole, validateApiKey } from "../lib/meta-sqlite.js";

export function createGroupRoutesHost(): GroupRoutesHost {
  return {
    createGroup, findGroupById, listGroupsByUser, updateGroup, deleteGroup,
    addGroupMembers, removeGroupMembers, getGroupMembers, getUserRole,
    resolveUserId(request) {
      const req = request as FastifyRequest;
      const key = req.headers["x-api-key"];
      return typeof key === "string" && key ? validateApiKey(key) : req.visitorId || null;
    },
  };
}

export async function groupsRoutes(app: FastifyInstance) {
  return registerGroupRoutes(app, createGroupRoutesHost());
}
