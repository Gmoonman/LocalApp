import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppSyncSource, SyncSourceError } from "./app-sync-source.cjs";
import { SyncSessionError } from "./sync-session-store.cjs";
import { validateName } from "./validate-name.cjs";
const TERMINAL = new Set(["completed", "rolled-back", "failed", "recovery-required"]);
export async function registerSyncSource(app: FastifyInstance, source: AppSyncSource, userId: (request: FastifyRequest) => string): Promise<void> {
  app.addHook("onRequest", async (_request, reply) => {
    if (!source.active) return reply.status(503).send({ success: false, code: "SYNC_SOURCE_STOPPED", error: "Synchronization source is stopped" });
  });
  app.get("/api/sync-jobs", async (request) => ({ success: true, data: source.jobs.list(userId(request)) }));

  app.post<{ Params: { name: string } }>("/api/me/apps/:name/sync", async (request, reply) => {
    try {
      const nameError = validateName(request.params.name);
      if (nameError) throw new SyncSourceError(400, nameError, "APP_NAME_INVALID");
      const body = request.body as Record<string, unknown> | null;
      const peerId = body?.peerName !== undefined || body?.peer !== undefined
        ? source.resolvePeerName(requiredString(body?.peerName ?? body?.peer, "peerName"))
        : requiredString(body?.peerId, "peerId");
      if (!peerId) throw new SyncSourceError(404, "Peer not found", "PEER_NOT_FOUND");
      let job;
      if (body?.withData === true) {
        const confirmation = requiredString(body.confirmation, "confirmation");
        if (confirmation !== request.params.name) throw new SyncSourceError(400, "Application name confirmation does not match", "APP_CONFIRMATION_MISMATCH");
        job = await source.start({ ownerId: userId(request), appName: request.params.name, peerId, withData: true, confirmation });
      } else if (body?.withData === false) {
        job = await source.start({ ownerId: userId(request), appName: request.params.name, peerId, withData: false });
      } else {
        throw new SyncSourceError(400, "withData must be a boolean", "SYNC_MODE_UNSUPPORTED");
      }
      return reply.status(202).send({ success: true, data: job });
    } catch (error) { return sourceError(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/api/sync-jobs/:id", async (request, reply) => {
    const job = source.jobs.getOwned(request.params.id, userId(request));
    return job ? { success: true, data: job } : reply.status(404).send({ success: false, error: "Synchronization job not found" });
  });

  app.post<{ Params: { id: string } }>("/api/sync-jobs/:id/cancel", async (request, reply) => {
    try { return { success: true, data: await source.cancel(request.params.id, userId(request)) }; }
    catch (error) { return sourceError(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/api/sync-jobs/:id/events", async (request, reply) => {
    const initial = source.jobs.getOwned(request.params.id, userId(request));
    if (!initial) return reply.status(404).send({ success: false, error: "Synchronization job not found" });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no",
    });
    let ended = false;
    const emitter = source.events(initial.id);
    const finish = () => { if (!ended) { ended = true; reply.raw.end(); } };
    const write = (job: typeof initial) => { if (!ended) reply.raw.write(`event: status\ndata: ${JSON.stringify(job)}\n\n`); };
    if (TERMINAL.has(initial.status)) { write(initial); finish(); return; }
    const listener = (job: typeof initial) => { write(job); if (TERMINAL.has(job.status)) { emitter.off("status", listener); finish(); } };
    emitter.on("status", listener);
    const current = source.jobs.getOwned(initial.id, userId(request));
    if (!current) { emitter.off("status", listener); finish(); return; }
    write(current);
    if (TERMINAL.has(current.status)) { emitter.off("status", listener); finish(); return; }
    request.raw.once("close", () => { emitter.off("status", listener); finish(); });
  });
}

function sourceError(reply: FastifyReply, error: unknown) {
  if (error instanceof SyncSourceError) return reply.status(error.statusCode).send({ success: false, code: error.code, error: error.message });
  return reply.status(400).send({ success: false, code: "SYNC_FAILED", error: error instanceof Error ? error.message : "Synchronization failed" });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new SyncSessionError("SYNC_METADATA_INVALID", `${field} is required`, 400);
  return value.trim();
}
