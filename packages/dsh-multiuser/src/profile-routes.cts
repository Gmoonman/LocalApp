import type { FastifyInstance, FastifyRequest } from "fastify";
import type {} from "./browser-sessions.cjs";
import fs from "node:fs";
import path from "node:path";
import type { AuthenticationHost } from "./auth-routes.cjs";
export interface ProfileHost extends Pick<AuthenticationHost, "findUserById" | "findUserByName" | "comparePassword" | "hashPassword" | "updateUserPasswordAndRevokeSessions" | "createAuthSessionForUserVersion" | "setAuthSessionCookie" | "validateApiKey"> {
  onCredentialsChanged?(userId: string): Promise<void>;
  dataDir: string;
  updateUserProfile(id: string, displayName?: string, bio?: string): void;
  updateUserAvatar(id: string, url: string): void;
  listAllUsersBasic(): unknown[];
  file(req: FastifyRequest): Promise<{ mimetype: string; toBuffer(): Promise<Buffer> } | undefined>;
}

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function extFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

export async function registerProfileRoutes(app: FastifyInstance, host: ProfileHost) {
  const { findUserById, updateUserProfile, updateUserPasswordAndRevokeSessions,
    updateUserAvatar, listAllUsersBasic, validateApiKey } = host;
  const dataDir = () => host.dataDir;

  // Session-only guard: reject requests without visitorId (no API Key auth)
  function requireSession(visitorId: string | null | undefined, reply: any): visitorId is string {
    if (!visitorId) {
      reply.status(401).send({ success: false, error: "Authentication required" });
      return false;
    }
    return true;
  }

  // GET /api/users — public user list (authenticated users only)
  app.get("/api/users", async (req, reply) => {
    const apiKey = req.headers["x-api-key"] as string | undefined;
    const userId = apiKey ? validateApiKey(apiKey) : req.visitorId;
    if (!userId) {
      return reply.status(401).send({ success: false, error: "Authentication required" });
    }
    const users = listAllUsersBasic();
    return { success: true, data: users };
  });

  // PUT /api/me/profile — update display name and bio
  app.put("/api/me/profile", async (req, reply) => {
    if (!requireSession(req.visitorId, reply)) return;

    const { displayName, bio } = req.body as { displayName?: string; bio?: string };

    if (displayName !== undefined && (displayName.length < 1 || displayName.length > 32)) {
      return reply.status(400).send({ success: false, error: "Display name must be 1-32 characters" });
    }

    updateUserProfile(req.visitorId!, displayName, bio);

    const user = findUserById(req.visitorId!);
    return {
      success: true,
      data: {
        displayName: user?.displayName ?? null,
        bio: user?.bio ?? null,
      },
    };
  });

  // PUT /api/me/password — change password
  app.put("/api/me/password", async (req, reply) => {
    if (!requireSession(req.visitorId, reply)) return;

    const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string };

    const user = findUserById(req.visitorId!);
    if (!user) return reply.status(404).send({ success: false, error: "User not found" });

    // Get password hash
    const { findUserByName } = host;
    const fullUser = findUserByName(user.name);
    if (!fullUser) return reply.status(404).send({ success: false, error: "User not found" });

    if (!oldPassword || !(await host.comparePassword(oldPassword, fullUser.password))) {
      return reply.status(401).send({ success: false, error: "Incorrect current password" });
    }

    if (!newPassword || newPassword.length < 6) {
      return reply.status(400).send({ success: false, error: "New password must be at least 6 characters" });
    }

    const hash = await host.hashPassword(newPassword, 10);
    const authVersion = updateUserPasswordAndRevokeSessions(
      req.visitorId!,
      hash,
      false,
      fullUser.authVersion,
      fullUser.authGeneration,
    );
    if (authVersion === null) {
      return reply.status(409).send({ success: false, error: "Password changed concurrently; retry with the current password" });
    }
    await host.onCredentialsChanged?.(req.visitorId!);
    const session = host.createAuthSessionForUserVersion(req.visitorId!, authVersion, fullUser.authGeneration);
    if (!session) {
      return reply.status(409).send({ success: false, error: "Password changed concurrently; sign in again" });
    }
    host.setAuthSessionCookie(req, reply, session.token, session.expiresAt);

    return { success: true };
  });

  // POST /api/me/avatar — upload avatar
  app.post("/api/me/avatar", async (req, reply) => {
    if (!requireSession(req.visitorId, reply)) return;

    const data = await host.file(req);
    if (!data) {
      return reply.status(400).send({ success: false, error: "No avatar file provided" });
    }

    if (!ALLOWED_MIME_TYPES.has(data.mimetype)) {
      return reply.status(400).send({ success: false, error: "Avatar must be JPG, PNG, or WebP" });
    }

    const buffer = await data.toBuffer();
    if (buffer.length > MAX_AVATAR_SIZE) {
      return reply.status(413).send({ success: false, error: "Avatar must be smaller than 2MB" });
    }

    const ext = extFromMime(data.mimetype);
    const avatarsDir = path.join(dataDir(), "avatars");
    fs.mkdirSync(avatarsDir, { recursive: true });

    // Remove old avatar files for this user
    const existingFiles = fs.readdirSync(avatarsDir).filter((f) => f.startsWith(req.visitorId! + "."));
    for (const f of existingFiles) {
      fs.unlinkSync(path.join(avatarsDir, f));
    }

    const filename = `${req.visitorId!}.${ext}`;
    fs.writeFileSync(path.join(avatarsDir, filename), buffer);

    const avatarUrl = `/api/avatar/${req.visitorId!}`;
    updateUserAvatar(req.visitorId!, avatarUrl);

    return { success: true, data: { avatarUrl } };
  });

  // GET /api/me/avatar — current user's avatar
  app.get("/api/me/avatar", async (req, reply) => {
    if (!req.visitorId) {
      return reply.status(401).send({ success: false, error: "Authentication required" });
    }

    const user = findUserById(req.visitorId);
    if (!user?.avatarUrl) {
      return reply.status(404).send({ success: false, error: "No avatar" });
    }

    const avatarsDir = path.join(dataDir(), "avatars");
    const files = fs.readdirSync(avatarsDir).filter((f) => f.startsWith(req.visitorId + "."));
    if (files.length === 0) {
      return reply.status(404).send({ success: false, error: "No avatar" });
    }

    const filePath = path.join(avatarsDir, files[0]);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
    reply.header("Content-Type", mimeMap[ext] || "application/octet-stream");
    return reply.send(fs.readFileSync(filePath));
  });

  // GET /api/avatar/:userId — public avatar access
  app.get<{ Params: { userId: string } }>("/api/avatar/:userId", async (req, reply) => {
    const { userId } = req.params;
    const avatarsDir = path.join(dataDir(), "avatars");

    if (!fs.existsSync(avatarsDir)) {
      return reply.status(404).send({ success: false, error: "No avatar" });
    }

    const files = fs.readdirSync(avatarsDir).filter((f) => f.startsWith(userId + "."));
    if (files.length === 0) {
      return reply.status(404).send({ success: false, error: "No avatar" });
    }

    const filePath = path.join(avatarsDir, files[0]);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
    reply.header("Content-Type", mimeMap[ext] || "application/octet-stream");
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send(fs.readFileSync(filePath));
  });

}
