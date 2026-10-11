import type { FastifyInstance } from "fastify";
import type { GroupRecord, GroupWithMeta } from "./groups.cjs";
export interface GroupRoutesHost {
  createGroup(name: string, description: string | undefined, creatorId: string): GroupRecord;
  findGroupById(id: string): GroupRecord | null;
  listGroupsByUser(userId: string): GroupWithMeta[];
  updateGroup(id: string, name?: string, description?: string): void;
  deleteGroup(id: string): void;
  addGroupMembers(id: string, userIds: string[]): void;
  removeGroupMembers(id: string, userIds: string[]): void;
  getGroupMembers(id: string): Array<{ id: string; name: string; displayName: string | null }>;
  resolveUserId(request: unknown): string | null;
  getUserRole(userId: string): string | null;
}

export async function registerGroupRoutes(app: FastifyInstance, host: GroupRoutesHost) {
  const { createGroup, findGroupById, listGroupsByUser, updateGroup, deleteGroup,
    addGroupMembers, removeGroupMembers, getGroupMembers, getUserRole, resolveUserId } = host;

  // POST /api/groups — create private group
  app.post("/api/groups", async (req, reply) => {
    const userId = resolveUserId(req);
    if (!userId) return reply.status(401).send({ success: false, error: "Authentication required" });

    const { name, description } = req.body as { name?: string; description?: string };
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return reply.status(400).send({ success: false, error: "Group name is required" });
    }

    try {
      const group = createGroup(name.trim(), description, userId);
      return reply.status(201).send({ success: true, data: group });
    } catch (e: any) {
      if (e.message === "GROUP_NAME_EXISTS") {
        return reply.status(409).send({ success: false, error: "Group name already exists" });
      }
      throw e;
    }
  });

  // GET /api/groups — list my groups
  app.get("/api/groups", async (req, reply) => {
    const userId = resolveUserId(req);
    if (!userId) return reply.status(401).send({ success: false, error: "Authentication required" });

    const groups = listGroupsByUser(userId);
    return { success: true, data: groups };
  });

  // GET /api/groups/:id — group detail with members
  app.get<{ Params: { id: string } }>("/api/groups/:id", async (req, reply) => {
    const userId = resolveUserId(req);
    if (!userId) return reply.status(401).send({ success: false, error: "Authentication required" });

    const group = findGroupById(req.params.id);
    if (!group) return reply.status(404).send({ success: false, error: "Group not found" });

    // Only creator or members can view
    const groups = listGroupsByUser(userId);
    const isMember = groups.some((g) => g.id === group.id);
    const isAdmin = getUserRole(userId) === "admin" && group.system;
    if (!isMember && !isAdmin) {
      return reply.status(403).send({ success: false, error: "Access denied" });
    }

    const members = getGroupMembers(group.id);
    return {
      success: true,
      data: {
        ...group,
        members,
        memberCount: members.length,
        isCreator: group.creatorId === userId,
      },
    };
  });

  // PUT /api/groups/:id — update group
  app.put<{ Params: { id: string } }>("/api/groups/:id", async (req, reply) => {
    const userId = resolveUserId(req);
    if (!userId) return reply.status(401).send({ success: false, error: "Authentication required" });

    const group = findGroupById(req.params.id);
    if (!group) return reply.status(404).send({ success: false, error: "Group not found" });

    // System groups: only admin
    if (group.system) {
      if (getUserRole(userId) !== "admin") {
        return reply.status(403).send({ success: false, error: "Only admin can modify system groups" });
      }
    } else {
      // Private groups: only creator
      if (group.creatorId !== userId) {
        return reply.status(403).send({ success: false, error: "Only group creator can modify" });
      }
    }

    const { name, description } = req.body as { name?: string; description?: string };
    try {
      updateGroup(group.id, name, description);
    } catch (e: any) {
      if (e.message === "GROUP_NAME_EXISTS") {
        return reply.status(409).send({ success: false, error: "Group name already exists" });
      }
      throw e;
    }

    const updated = findGroupById(group.id);
    return { success: true, data: updated };
  });

  // DELETE /api/groups/:id — delete group
  app.delete<{ Params: { id: string } }>("/api/groups/:id", async (req, reply) => {
    const userId = resolveUserId(req);
    if (!userId) return reply.status(401).send({ success: false, error: "Authentication required" });

    const group = findGroupById(req.params.id);
    if (!group) return reply.status(404).send({ success: false, error: "Group not found" });

    if (group.system) {
      return reply.status(403).send({ success: false, error: "System groups cannot be deleted" });
    }

    if (group.creatorId !== userId) {
      return reply.status(403).send({ success: false, error: "Only group creator can delete" });
    }

    deleteGroup(group.id);
    return { success: true };
  });

  // POST /api/groups/:id/members — add members
  app.post<{ Params: { id: string } }>("/api/groups/:id/members", async (req, reply) => {
    const userId = resolveUserId(req);
    if (!userId) return reply.status(401).send({ success: false, error: "Authentication required" });

    const group = findGroupById(req.params.id);
    if (!group) return reply.status(404).send({ success: false, error: "Group not found" });

    if (group.system) {
      if (getUserRole(userId) !== "admin") {
        return reply.status(403).send({ success: false, error: "Only admin can manage system group members" });
      }
    } else {
      if (group.creatorId !== userId) {
        return reply.status(403).send({ success: false, error: "Only group creator can add members" });
      }
    }

    const { userIds } = req.body as { userIds?: string[] };
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return reply.status(400).send({ success: false, error: "userIds array is required" });
    }

    addGroupMembers(group.id, userIds);
    const members = getGroupMembers(group.id);
    return { success: true, data: members };
  });

  // POST /api/groups/:id/members/remove — remove members
  app.post<{ Params: { id: string } }>("/api/groups/:id/members/remove", async (req, reply) => {
    const userId = resolveUserId(req);
    if (!userId) return reply.status(401).send({ success: false, error: "Authentication required" });

    const group = findGroupById(req.params.id);
    if (!group) return reply.status(404).send({ success: false, error: "Group not found" });

    if (group.system) {
      if (getUserRole(userId) !== "admin") {
        return reply.status(403).send({ success: false, error: "Only admin can manage system group members" });
      }
    } else {
      if (group.creatorId !== userId) {
        return reply.status(403).send({ success: false, error: "Only group creator can remove members" });
      }
    }

    const { userIds } = req.body as { userIds?: string[] };
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return reply.status(400).send({ success: false, error: "userIds array is required" });
    }

    // Creator cannot remove themselves
    if (!group.system && userIds.includes(group.creatorId)) {
      return reply.status(400).send({ success: false, error: "Creator cannot be removed from the group" });
    }

    removeGroupMembers(group.id, userIds);
    const members = getGroupMembers(group.id);
    return { success: true, data: members };
  });
}
