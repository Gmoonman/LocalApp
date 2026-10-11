import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
export interface AuthUser {
  id: string; name: string; role: string;
  displayName?: string | null; avatarUrl?: string | null; bio?: string | null;
}
export interface PasswordUser extends AuthUser {
  password: string; authVersion: number; authGeneration: string; mustChangePassword: boolean;
}
export interface AuthenticationHost {
  findUserByName(name: string): PasswordUser | null;
  findUserById(id: string): AuthUser | null;
  comparePassword(password: string, hash: string): Promise<boolean>;
  hashPassword(password: string, rounds: number): Promise<string>;
  updateUserPasswordAndRevokeSessions(id: string, hash: string, mustChange: boolean, version: number, generation: string): number | null;
  createAuthSessionForUserVersion(id: string, version: number, generation: string): { token: string; expiresAt: Date } | null;
  setAuthSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string, expiresAt: Date): void;
  logout(req: FastifyRequest, reply: FastifyReply): void | Promise<void>;
  verificationUser(req: FastifyRequest): unknown;
  visitorId(req: FastifyRequest): string | null | undefined;
  validateApiKey(key: string): string | null;
}

const MIN_PASSWORD_LENGTH = 6;

export async function registerAuthenticationRoutes(app: FastifyInstance, host: AuthenticationHost) {
  const { findUserByName, findUserById, updateUserPasswordAndRevokeSessions,
    createAuthSessionForUserVersion, setAuthSessionCookie } = host;
  app.post("/api/auth/cli-register", async (_req, reply) => {
    return reply.status(410).send({
      success: false,
      code: "CLI_AUTO_REGISTRATION_REMOVED",
      error: "CLI automatic registration has been removed. Ask an administrator for an API Key.",
    });
  });

  app.post<{
    Body: { username: string; password: string };
  }>("/api/auth/login", async (req, reply) => {
    const { username, password } = req.body;

    const user = findUserByName(username);
    if (!user) {
      return reply.status(401).send({ success: false, error: "Invalid credentials" });
    }

    const valid = await host.comparePassword(password, user.password);
    if (!valid) {
      return reply.status(401).send({ success: false, error: "Invalid credentials" });
    }

    if (user.mustChangePassword) {
      return reply.status(403).send({ success: false, error: "Password reset required", code: "MUST_CHANGE_PASSWORD" });
    }

    const session = createAuthSessionForUserVersion(user.id, user.authVersion, user.authGeneration);
    if (!session) {
      return reply.status(401).send({ success: false, error: "Invalid credentials" });
    }
    setAuthSessionCookie(req, reply, session.token, session.expiresAt);

    return { success: true, data: { id: user.id, name: user.name, role: user.role } };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await host.logout(req, reply);
    return { success: true };
  });

  app.post<{
    Body: { userId: string; oldPassword: string; newPassword: string };
  }>("/api/auth/force-change-password", async (req, reply) => {
    const { userId, oldPassword, newPassword } = req.body;

    const user = findUserById(userId);
    if (!user) {
      return reply.status(404).send({ success: false, error: "User not found" });
    }

    // Need password hash for verification — fetch from name lookup
    const userWithPassword = findUserByName(user.name);
    if (!userWithPassword) {
      return reply.status(404).send({ success: false, error: "User not found" });
    }

    const valid = await host.comparePassword(oldPassword, userWithPassword.password);
    if (!valid) {
      return reply.status(401).send({ success: false, error: "Invalid credentials" });
    }

    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      return reply.status(400).send({ success: false, error: "Password too short" });
    }

    const passwordHash = await host.hashPassword(newPassword, 10);
    const authVersion = updateUserPasswordAndRevokeSessions(
      userId,
      passwordHash,
      false,
      userWithPassword.authVersion,
      userWithPassword.authGeneration,
    );
    if (authVersion === null) {
      return reply.status(409).send({ success: false, error: "Password changed concurrently; retry with the current password" });
    }
    const session = createAuthSessionForUserVersion(user.id, authVersion, userWithPassword.authGeneration);
    if (!session) {
      return reply.status(409).send({ success: false, error: "Password changed concurrently; sign in again" });
    }
    setAuthSessionCookie(req, reply, session.token, session.expiresAt);

    return { success: true, data: { id: user.id, name: user.name, role: user.role } };
  });

  app.get("/api/me", async (req) => {
    const userData = (user: AuthUser) => ({
      id: user.id,
      name: user.name,
      role: user.role,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
    });

    // Verification identity is accepted only for this read-only endpoint and only
    // when the browser came from the bound formal application path. It takes
    // precedence so a pre-existing login cannot change the requested test role.
    const verification = host.verificationUser(req);
    if (verification) return { success: true, data: verification };

    // Try cookie session after the app-scoped verification identity.
    const visitorId = host.visitorId(req);
    if (visitorId) {
      const user = findUserById(visitorId);
      if (user) {
        return { success: true, data: userData(user) };
      }
    }

    // Try API Key
    const apiKey = req.headers["x-api-key"] as string | undefined;
    if (apiKey) {
      const userId = host.validateApiKey(apiKey);
      if (userId) {
        const user = findUserById(userId);
        if (user) {
          return { success: true, data: userData(user) };
        }
      }
    }

    return { success: true, data: null };
  });
}
