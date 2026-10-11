import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type { AccountServices } from "./account-services.cjs";
export interface AdministratorAccountsHost extends Pick<AccountServices, "accounts" | "groups"> {
  onCredentialsChanged?(userId: string): Promise<void>;
  bootstrapUserId: string;
  userId(request: FastifyRequest): string | undefined;
  isProtectedUserId(id: string): boolean;
  countAdministrators(): number;
  generateTemporaryPassword(): string;
  hashPassword(password: string, rounds: number): Promise<string>;
  applicationSummary(userId: string): { pages: number; storageUsed: number };
  listApplications(userId: string): Array<{ name: string; currentVersion: number; updatedAt: string }>;
  deleteUserApplications(userId: string, deleteAccount: () => void): Promise<void>;
}

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{2,32}$/;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

export async function registerAdministratorAccounts(app: FastifyInstance, host: AdministratorAccountsHost): Promise<void> {
  // GET /api/admin/users — paginated user list
  app.get("/api/admin/users", async (req) => {
    const page = Math.max(1, parseInt((req.query as any).page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query as any).limit || "20", 10)));

    const { data, total } = host.accounts.listUsers(page, limit);
    const users = data.map((u) => {
      const { pages, storageUsed } = host.applicationSummary(u.id);
      return {
        id: u.id,
        name: u.name,
        role: u.role,
        createdAt: u.createdAt,
        pages,
        storageUsed: formatSize(storageUsed),
        storageBytes: storageUsed,
        mustChangePassword: u.mustChangePassword,
      };
    });

    return { success: true, data: users, pagination: { page, limit, total } };
  });

  // POST /api/admin/users — admin provisions a user and one-time credentials.
  app.post<{ Body: { username?: string } }>("/api/admin/users", async (req, reply) => {
    const { username } = req.body || {};

    if (!username || !USERNAME_REGEX.test(username)) {
      return reply.status(400).send({ success: false, error: "Invalid username format" });
    }

    const temporaryPassword = host.generateTemporaryPassword();
    const apiKey = randomBytes(24).toString("hex");
    const passwordHash = await host.hashPassword(temporaryPassword, 10);
    try {
      const user = host.accounts.provisionUserWithApiKey(username, username, passwordHash, apiKey);
      return {
        success: true,
        data: {
          id: user.id,
          name: user.name,
          role: user.role,
          mustChangePassword: true,
          credentials: { temporaryPassword, apiKey },
        },
      };
    } catch (err: any) {
      if (err.message === "USER_EXISTS") {
        return reply.status(409).send({ success: false, error: "Username already exists" });
      }
      throw err;
    }
  });

  // POST /api/admin/reset-password — issue a one-time random password.
  app.post<{ Body: { userId: string } }>("/api/admin/reset-password", async (req, reply) => {
    const { userId } = req.body;

    if (!userId) {
      return reply.status(400).send({ success: false, error: "userId is required" });
    }

    const user = host.accounts.findUserById(userId);
    if (!user) {
      return reply.status(404).send({ success: false, error: "User not found" });
    }

    const temporaryPassword = host.generateTemporaryPassword();
    const passwordHash = await host.hashPassword(temporaryPassword, 10);
    host.accounts.updateUserPasswordAndRevokeSessions(userId, passwordHash, true);
    await host.onCredentialsChanged?.(userId);

    return {
      success: true,
      data: { temporaryPassword, mustChangePassword: true },
    };
  });

  // PATCH /api/admin/users/:id/role — change a user's role
  app.patch<{ Params: { id: string }; Body: { role?: string } }>("/api/admin/users/:id/role", async (req, reply) => {
    const { id } = req.params;
    const { role } = req.body || {};

    if (role !== "admin" && role !== "user") {
      return reply.status(400).send({ success: false, error: "Invalid role" });
    }

    const user = host.accounts.findUserById(id);
    if (!user) {
      return reply.status(404).send({ success: false, error: "User not found" });
    }

    if (role === "user" && user.role === "admin") {
      if (host.isProtectedUserId(id)) {
        return reply.status(400).send({ success: false, error: "Cannot demote protected user" });
      }
      if (id === host.userId(req)) {
        return reply.status(400).send({ success: false, error: "Cannot demote yourself" });
      }
      const adminCount = host.countAdministrators();
      if (adminCount <= 1) {
        return reply.status(400).send({ success: false, error: "Cannot demote the last admin" });
      }
    }

    host.accounts.updateUserRole(id, role);
    return { success: true, data: { id, role } };
  });

  // GET /api/admin/users/:id — user detail
  app.get<{ Params: { id: string } }>("/api/admin/users/:id", async (req, reply) => {
    const { id } = req.params;
    const user = host.accounts.findUserById(id);
    if (!user) {
      return reply.status(404).send({ success: false, error: "User not found" });
    }

    const pageList = host.listApplications(id);
    return {
      success: true,
      data: {
        id: user.id,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
        storageUsed: formatSize(host.applicationSummary(id).storageUsed),
        pages: pageList,
      },
    };
  });

  // DELETE /api/admin/users/:id — delete user
  app.delete<{ Params: { id: string } }>("/api/admin/users/:id", async (req, reply) => {
    const { id } = req.params;

    if (host.isProtectedUserId(id)) {
      return reply.status(400).send({ success: false, error: "Cannot delete protected user" });
    }

    if (id === host.userId(req)) {
      return reply.status(400).send({ success: false, error: "Cannot delete yourself" });
    }

    const user = host.accounts.findUserById(id);
    if (!user) {
      return reply.status(404).send({ success: false, error: "User not found" });
    }

    await host.deleteUserApplications(id, () => { host.accounts.deleteUserById(id); });

    return { success: true, data: { deleted: true, id } };
  });

  // --- System Group Management ---

  // GET /api/admin/groups — list system groups
  app.get("/api/admin/groups", async () => {
    const groups = host.groups.listSystemGroups();
    return { success: true, data: groups };
  });

  // POST /api/admin/groups — create system group
  app.post("/api/admin/groups", async (req, reply) => {
    const { name, description } = req.body as { name?: string; description?: string };
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return reply.status(400).send({ success: false, error: "Group name is required" });
    }
    try {
      const group = host.groups.createGroup(name.trim(), description, host.bootstrapUserId, true);
      return reply.status(201).send({ success: true, data: group });
    } catch (e: any) {
      if (e.message === "GROUP_NAME_EXISTS") {
        return reply.status(409).send({ success: false, error: "Group name already exists" });
      }
      throw e;
    }
  });

  // PUT /api/admin/groups/:id — update system group
  app.put<{ Params: { id: string } }>("/api/admin/groups/:id", async (req, reply) => {
    const group = host.groups.findGroupById(req.params.id);
    if (!group) return reply.status(404).send({ success: false, error: "Group not found" });
    if (!group.system) return reply.status(400).send({ success: false, error: "Not a system group" });

    const { name, description } = req.body as { name?: string; description?: string };
    try {
      host.groups.updateGroup(group.id, name, description);
    } catch (e: any) {
      if (e.message === "GROUP_NAME_EXISTS") {
        return reply.status(409).send({ success: false, error: "Group name already exists" });
      }
      throw e;
    }
    const updated = host.groups.findGroupById(group.id);
    return { success: true, data: updated };
  });

  // POST /api/admin/groups/:id/members — add members to system group
  app.post<{ Params: { id: string } }>("/api/admin/groups/:id/members", async (req, reply) => {
    const group = host.groups.findGroupById(req.params.id);
    if (!group) return reply.status(404).send({ success: false, error: "Group not found" });
    if (!group.system) return reply.status(400).send({ success: false, error: "Not a system group" });

    const { userIds } = req.body as { userIds?: string[] };
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return reply.status(400).send({ success: false, error: "userIds array is required" });
    }

    host.groups.addGroupMembers(group.id, userIds);
    const members = host.groups.getGroupMembers(group.id);
    return { success: true, data: members };
  });

  // POST /api/admin/groups/:id/members/remove — remove members from system group
  app.post<{ Params: { id: string } }>("/api/admin/groups/:id/members/remove", async (req, reply) => {
    const group = host.groups.findGroupById(req.params.id);
    if (!group) return reply.status(404).send({ success: false, error: "Group not found" });
    if (!group.system) return reply.status(400).send({ success: false, error: "Not a system group" });

    const { userIds } = req.body as { userIds?: string[] };
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return reply.status(400).send({ success: false, error: "userIds array is required" });
    }

    host.groups.removeGroupMembers(group.id, userIds);
    const members = host.groups.getGroupMembers(group.id);
    return { success: true, data: members };
  });
}
