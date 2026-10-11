import type { FastifyInstance } from "fastify";
import path from "node:path";
import { registerPersonalPages, type PersonalPagesHost } from "@localapp/dsh-multiuser/personal-pages";
import { getUserRole } from "../lib/meta-sqlite.js";
export function createPersonalPagesHost(options: { webRoot?: string } = {}): PersonalPagesHost {
  return { webRoot: options.webRoot ?? path.resolve(__dirname, "../../../web/out"), visitor: request => request.visitorId, userRole: getUserRole };
}
export async function myServeRoutes(app: FastifyInstance, options: { webRoot?: string } = {}) { return registerPersonalPages(app, createPersonalPagesHost(options)); }
