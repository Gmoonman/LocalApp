import { registerPeers } from "@localapp/dsh-app-platform/peers-routes";
import type { FastifyInstance } from "fastify";
import type { PeerStore } from "../lib/peer-store.js";
import { adminAuth } from "../plugins/auth.js";
export async function peersRoutes(app: FastifyInstance, peers: PeerStore) { return registerPeers(app, peers, adminAuth); }
