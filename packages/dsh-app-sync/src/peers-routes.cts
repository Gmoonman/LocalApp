import type { FastifyInstance, FastifyReply } from "fastify";
import { checkPeerCapabilities, normalizePeerUrl } from "@localapp/dsh-app-sync/peer-client";
import { PeerStore } from "@localapp/dsh-app-sync/peer-store";

type PeerRequestBody = {
  name?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  acceptInsecureHttp?: unknown;
};

export async function registerPeers(app: FastifyInstance, peerStore: PeerStore, authenticate: (app: FastifyInstance) => Promise<void>): Promise<void> {
  await app.register(async (adminScope) => {
    await authenticate(adminScope);

    adminScope.get("/api/peers", async () => ({ success: true, data: peerStore.listPublic() }));

    adminScope.post("/api/peers", async (req, reply) => {
      try {
        const body = req.body as PeerRequestBody | undefined;
        const name = requiredName(body?.name);
        const apiKey = requiredApiKey(body?.apiKey);
        const peerUrl = normalizePeerUrl(requiredString(body?.baseUrl, "baseUrl"), body?.acceptInsecureHttp === true);
        const peer = peerStore.create({ name, apiKey, ...peerUrl });
        return reply.status(201).send({ success: true, data: peer });
      } catch (error) {
        return peerError(reply, error);
      }
    });

    adminScope.patch<{ Params: { id: string } }>("/api/peers/:id", async (req, reply) => {
      try {
        const body = req.body as PeerRequestBody | undefined;
        if (!body || Object.keys(body).length === 0) throw new Error("At least one peer setting is required");
        const existing = peerStore.getPublic(req.params.id);
        if (!existing) return reply.status(404).send({ success: false, error: "Peer not found" });
        const input: { name?: string; baseUrl?: string; apiKey?: string; acceptInsecureHttp?: boolean } = {};
        if (body.name !== undefined) input.name = requiredName(body.name);
        if (body.apiKey !== undefined) input.apiKey = requiredApiKey(body.apiKey);
        if (body.baseUrl !== undefined || body.acceptInsecureHttp !== undefined) {
          const url = normalizePeerUrl(
            body.baseUrl === undefined ? existing.baseUrl : requiredString(body.baseUrl, "baseUrl"),
            body.acceptInsecureHttp === undefined ? existing.acceptInsecureHttp : body.acceptInsecureHttp === true,
          );
          input.baseUrl = url.baseUrl;
          input.acceptInsecureHttp = url.acceptInsecureHttp;
        }
        const peer = peerStore.update(req.params.id, input);
        return { success: true, data: peer };
      } catch (error) {
        return peerError(reply, error);
      }
    });

    adminScope.delete<{ Params: { id: string } }>("/api/peers/:id", async (req, reply) => {
      if (!peerStore.remove(req.params.id)) return reply.status(404).send({ success: false, error: "Peer not found" });
      return reply.status(204).send();
    });

    adminScope.post<{ Params: { id: string } }>("/api/peers/:id/check", async (req, reply) => {
      let target;
      try {
        target = peerStore.loadForCheck(req.params.id);
      } catch {
        return reply.status(502).send({ success: false, error: "Peer capability check failed" });
      }
      if (!target) return reply.status(404).send({ success: false, error: "Peer not found" });
      let verification;
      try {
        verification = await checkPeerCapabilities(target.baseUrl, target.apiKey);
      } catch {
        return reply.status(502).send({ success: false, error: "Peer capability check failed" });
      }
      const persisted = peerStore.recordVerification(target, verification);
      if (persisted.kind !== "updated") {
        if (persisted.kind === "missing") return reply.status(404).send({ success: false, error: "Peer not found" });
        return reply.status(409).send({ success: false, error: "Peer configuration changed during capability check" });
      }
      return { success: true, data: persisted.peer };
    });
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function requiredName(value: unknown): string {
  const name = requiredString(value, "name");
  if (name.length > 80) throw new Error("name must be at most 80 characters");
  return name;
}

function requiredApiKey(value: unknown): string {
  const apiKey = requiredString(value, "apiKey");
  if (apiKey.length > 1024) throw new Error("apiKey is too long");
  return apiKey;
}

function peerError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "Invalid peer request";
  if (message.includes("UNIQUE constraint")) return reply.status(409).send({ success: false, error: "Peer name already exists" });
  return reply.status(400).send({ success: false, error: message });
}
