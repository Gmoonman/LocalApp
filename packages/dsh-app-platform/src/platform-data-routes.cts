import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PLATFORM_CAPABILITIES } from "./platform-capabilities.cjs";
import { CURRENT_PLATFORM_VERSION } from "./platform-version.cjs";
export interface PlatformDataHost {
  allow(request: FastifyRequest): boolean;
  users(): unknown[];
  user(id: string): { id: string; name: string; displayName: string | null; avatarUrl: string | null; role: string } | null;
  groups(): { id: string; name: string; description: string | null; memberCount: number }[];
  group(id: string): { id: string; name: string; description: string | null } | null;
}

const PLATFORM_ROLES = [
  { id: "admin", name: "Admin", permissions: ["*"] },
  { id: "user", name: "User", permissions: ["apps:read", "apps:create"] },
];

export async function registerPlatformData(app: FastifyInstance, host: PlatformDataHost) {
  app.get("/api/platform/capabilities", async () => ({
    success: true,
    data: PLATFORM_CAPABILITIES,
  }));

  app.get("/api/platform/users", async (req, reply) => {
    if (!requirePlatformAccess(req, reply, host)) return;
    return {
    success: true,
    data: host.users(),
    };
  });

  app.get<{ Params: { id: string } }>("/api/platform/users/:id", async (req, reply) => {
    if (!requirePlatformAccess(req, reply, host)) return;
    const user = host.user(req.params.id);
    if (!user) return reply.status(404).send({ success: false, error: "User not found" });
    return {
      success: true,
      data: {
        id: user.id,
        name: user.name,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        role: user.role,
      },
    };
  });

  app.get("/api/platform/groups", async (req, reply) => {
    if (!requirePlatformAccess(req, reply, host)) return;
    return {
      success: true,
      data: host.groups().map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        memberCount: group.memberCount,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/platform/groups/:id", async (req, reply) => {
    if (!requirePlatformAccess(req, reply, host)) return;
    const group = host.group(req.params.id);
    if (!group) return reply.status(404).send({ success: false, error: "Group not found" });
    return {
      success: true,
      data: {
        id: group.id,
        name: group.name,
        description: group.description,
      },
    };
  });

  app.get("/api/platform/roles", async (req, reply) => {
    if (!requirePlatformAccess(req, reply, host)) return;
    return {
      success: true,
      data: PLATFORM_ROLES,
    };
  });

  app.get("/api/platform/version", async (req, reply) => {
    if (!requirePlatformAccess(req, reply, host)) return;
    return {
      success: true,
      data: {
        version: CURRENT_PLATFORM_VERSION,
      },
    };
  });

  app.all("/api/platform/*", async (req, reply) => {
    if (req.method !== "GET") {
      return reply.status(405).send({
        success: false,
        error: "Platform data is read-only",
      });
    }
    if (!requirePlatformAccess(req, reply, host)) return;
    return reply.status(404).send({ success: false, error: "Platform data not found" });
  });
}

function requirePlatformAccess(req: FastifyRequest, reply: FastifyReply, host: PlatformDataHost): boolean {
  if (host.allow(req)) return true;
  reply.status(401).send({ success: false, error: "Authentication required" });
  return false;
}
