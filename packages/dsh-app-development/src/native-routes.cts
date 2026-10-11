import type { FastifyInstance } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
export interface DevelopmentNativeHost {
  client?: {
    renderIndex(html:string):Promise<string>;
    resource(request:IncomingMessage,reply:ServerResponse):Promise<boolean>;
    entry(filename:string):Promise<{bytes:Buffer;mime:string}|null>;
  };
  user(request: import("fastify").FastifyRequest): string;
  authorized(request: import("fastify").FastifyRequest, userId: string, projectId: string): boolean;
  runtime(project: string, user: string, provider?: string): Promise<{ nativeApi(): Promise<{ transport: {
    http(user: string, request: IncomingMessage, reply: ServerResponse): Promise<boolean>;
    upgrade(user: string, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
  } }> }>;
}
function nativePrefix(request: import("fastify").FastifyRequest) {
  const { id, providerId } = request.params as { id: string; providerId?: string };
  return "/api/development/projects/" + encodeURIComponent(id) + "/native" + (providerId === undefined ? "" : "/" + encodeURIComponent(providerId));
}
const nativeBases = ["/api/development/projects/:id/native", "/api/development/projects/:id/native/:providerId"];
/** Mount native dsh requests on the existing authenticated Server. */
export async function registerDevelopmentNative(app: FastifyInstance, host: DevelopmentNativeHost) {
  if (host.client) app.register(async pages => {
    pages.addHook("onRequest", async request => { await host.runtime((request.params as {id:string}).id,host.user(request),(request.params as {providerId?:string}).providerId ?? (request.query as {providerId?:string}).providerId); });
    for (const base of nativeBases) {
    pages.get(base+"/",async(request,reply)=>{
      const url=nativePrefix(request)+"/";
      const html='<!doctype html><html><head><meta charset="utf-8"><base href="'+url+'"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="client/entry.css"></head><body><div id="root"></div><script type="module" src="client/entry.js"></script></body></html>';
      reply.header("Cache-Control","no-store");return reply.type("text/html; charset=utf-8").send(await host.client!.renderIndex(html));
    });
    pages.get(base+"/client/*",async(request,reply)=>{
      const entry=await host.client!.entry((request.params as {"*":string})["*"]);
      return entry?reply.type(entry.mime).send(entry.bytes):reply.code(404).send();
    });
    const resource: import("fastify").RouteHandlerMethod=async(request,reply)=>{
      const original=request.raw.url;request.raw.url=original?.slice(nativePrefix(request).length);
      reply.hijack();
      try {if(!await host.client!.resource(request.raw,reply.raw)){reply.raw.writeHead(404);reply.raw.end();}}
      catch(error){if(!reply.raw.headersSent)reply.raw.writeHead(500);reply.raw.end();app.log.error({err:error},"Development native resource failed");}
      finally {request.raw.url=original;}
    };
    pages.get(base+"/plugins/",resource);pages.get(base+"/plugins/*",resource);
    }
  });
  const upgrades = new WeakMap<IncomingMessage, { socket: Duplex; head: Buffer }>();
  const capture = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (/^\/api\/development\/projects\/[^/]+\/native\/(?:[^/]+\/)?api\/remote\.mux$/.test(new URL(request.url ?? "/", "http://localapp.invalid").pathname)) upgrades.set(request, { socket, head });
  };
  app.server.prependListener("upgrade", capture);
  const connectionChecks = new Set<() => void>();
  app.addHook("onClose", async () => {
    app.server.removeListener("upgrade", capture);
    for (const close of [...connectionChecks]) close();
  });
  app.register(async routes => {
    routes.addHook("onRequest", async (request, reply) => {
      const { id, providerId: selectedProvider } = request.params as { id: string; providerId?: string };
      const user = host.user(request);
      const { providerId } = request.query as { providerId?: string };
      // Resolve project ownership and runtime before handing over the response.
      const native = await (await host.runtime(id, user, selectedProvider ?? providerId)).nativeApi();
      const original = request.raw.url;
      request.raw.url = original?.slice(nativePrefix(request).length);
      reply.hijack();
      try {
        const upgrade = upgrades.get(request.raw); upgrades.delete(request.raw);
        if (upgrade) {
          const authorized = () => { try { return host.authorized(request, user, id); } catch { return false; } };
          if (!authorized()) { upgrade.socket.destroy(); return; }
          const timer = setInterval(() => { if (!authorized()) upgrade.socket.destroy(); }, 1000);
          timer.unref();
          const close = () => { clearInterval(timer); connectionChecks.delete(close); upgrade.socket.destroy(); };
          connectionChecks.add(close);
          upgrade.socket.once("close", close);
        }
        const handled = upgrade
          ? await native.transport.upgrade(user, request.raw, upgrade.socket, upgrade.head)
          : await native.transport.http(user, request.raw, reply.raw);
        if (!handled) { reply.raw.writeHead(404); reply.raw.end(); }
      } catch (error) {
        if (!reply.raw.headersSent) reply.raw.writeHead(500);
        reply.raw.end(); app.log.error({ err: error }, "Development native request failed");
      } finally { request.raw.url = original; }
    });
    for (const base of nativeBases) {
    const prefix = base + "/api";
    routes.get(prefix + "/remote.mux", async () => {});
    routes.post(prefix + "/$events/result", async () => {});
    routes.post(prefix + "/workspace/initializeDefault", async () => {});
    for(const method of ["archiveSession","unarchiveSession","pinSession","unpinSession"])routes.post(prefix+"/workspace/"+method,async()=>{});
    routes.post(prefix + "/settings/describe", async () => {});
    for (const method of ["clear", "complete", "create", "edit", "get", "pause", "resume"]) routes.post(prefix + "/goals/" + method, async () => {});
    routes.post(prefix + "/commands/list", async () => {});
    routes.post(prefix + "/skills/list", async () => {});
    routes.post(prefix + "/fileReferences/list", async () => {});
    routes.post(prefix + "/job/kill", async () => {});
    routes.post(prefix + "/userQuestions/answer", async () => {});
    for (const method of ["list", "page", "create", "prompt", "cancel", "rename", "search", "modelCatalog", "selectModel", "uploadFileBinary", "fork", "attachment", "projections", "updateQueue"]) routes.post(prefix + "/session/" + method, async () => {});
    }
  });
}
