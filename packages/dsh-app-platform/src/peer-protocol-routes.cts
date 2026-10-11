export interface PeerProtocolHost {
  keyOwner(key: string): string | null;
  user(id: string): { id: string; name: string; displayName: string | null } | null;
}
import type { FastifyInstance } from "fastify";
import { MAX_APP_PACKAGE_BYTES } from "./app-package.cjs";

export const PEER_PROTOCOL_VERSION = 2;

export async function registerPeerProtocol(app: FastifyInstance, host: PeerProtocolHost): Promise<void> {
  app.get("/api/peer/capabilities", async (req, reply) => {
    const authorization = req.headers.authorization;
    const match = typeof authorization === "string" ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
    const userId = match ? host.keyOwner(match[1]) : null;
    if (!userId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const user = host.user(userId);
    if (!user) return reply.status(401).send({ success: false, error: "Authentication required" });
    return {
      success: true,
      data: {
        protocolVersion: PEER_PROTOCOL_VERSION,
        user: { id: user.id, name: user.name, displayName: user.displayName },
        transferLimits: { maxPackageBytes: MAX_APP_PACKAGE_BYTES },
      },
    };
  });
}
