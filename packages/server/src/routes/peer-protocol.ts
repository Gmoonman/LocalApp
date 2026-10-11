import { registerPeerProtocol } from "@localapp/dsh-app-platform/peer-protocol-routes";
import type { FastifyInstance } from "fastify";
import { findUserById, validateApiKey } from "../lib/meta-sqlite.js";
export { PEER_PROTOCOL_VERSION } from "@localapp/dsh-app-platform/peer-protocol-routes";
export async function peerProtocolRoutes(app: FastifyInstance) { return registerPeerProtocol(app, { keyOwner: validateApiKey, user: findUserById }); }
