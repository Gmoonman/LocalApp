import { Context, Service } from "@deepseek-ai/cordis";
import WebServer, { type WebRoute, type WebUpgradeRoute, type Config } from "@deepseek-ai/dsh-host-webserver";
import { createServer, type IncomingMessage, type ServerResponse, type RequestListener, type Server } from "node:http";
import type { Duplex } from "node:stream";

/**
 * dsh route carrier inside the existing LocalApp Server. The caller must select
 * this user's Context after authentication, before dispatching HTTP or upgrades.
 * dsh owns the RPC, event and WebSocket protocols. Initialization opens no
 * listener; the composing host can request the one shared listener explicitly.
 */
export default class EmbeddedWebServer extends WebServer {
  private readonly httpRoutes = new Map<string, WebRoute>();
  private readonly upgradeRoutes = new Map<string, WebUpgradeRoute>();
  private readonly fallbackRoutes = new Map<string, WebRoute["handler"]>();
  private readonly embeddedPort: number;
  private active = true;
  private listener?: Server;

  /** The host owns listen/close; this creates the one socket used by its adapter. */
  createListener(compatibility: RequestListener): Server {
    this.assertActive();
    if (this.listener) throw new Error("dsh HTTP listener already created");
    const removeFallback = this.registerFallback((request, response) => { compatibility(request, response); });
    this.ctx.effect(() => removeFallback);
    this.listener = createServer((request, response) => {
      if (!this.active) {
        response.writeHead(503);
        response.end("Server is stopped");
        return;
      }
      void this.dispatchHttp(request, response).catch(error => {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
        if (response.headersSent) { response.destroy(); return; }
        response.writeHead(500);
        response.end("Internal Server Error");
      });
    });
    // Select one upgrade owner before EventEmitter invokes compatibility listeners.
    const emit = this.listener.emit.bind(this.listener);
    this.listener.emit = (event: string | symbol, ...args: unknown[]) => {
      if (event !== "upgrade") return emit(event, ...args);
      const [request, socket, head] = args as [IncomingMessage, Duplex, Buffer];
      if (!this.active) { socket.destroy(); return true; }
      if (!this.hasUpgradeRoute(request.url ?? "/")) return emit(event, ...args);
      void this.dispatchUpgrade(request, socket, head).catch(error => {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
      });
      return true;
    };
    return this.listener;
  }

  private assertActive(): void {
    if (!this.active) throw new Error("dsh HTTP carrier is stopped");
  }

  constructor(ctx: Context, config: Config) {
    super(ctx, config);
    this.embeddedPort = config.port;
  }

  override get port(): number {
    const address = this.listener?.address();
    return address && typeof address === "object" ? address.port : this.embeddedPort;
  }

  override async [Service.init](): Promise<void> {
    // The composing Server already owns node:http and its listening socket.
    this.ctx.effect(() => () => {
      this.active = false;
      this.httpRoutes.clear(); this.upgradeRoutes.clear(); this.fallbackRoutes.clear();
    });
  }

  override register(route: WebRoute): () => void {
    this.assertActive();
    const key = `${route.kind}:${route.path}`;
    if (this.httpRoutes.has(key)) throw new Error(`Duplicate dsh route ${route.path}`);
    this.httpRoutes.set(key, route);
    return () => { if (this.httpRoutes.get(key) === route) this.httpRoutes.delete(key); };
  }

  override registerUpgrade(route: WebUpgradeRoute): () => void {
    this.assertActive();
    if (this.upgradeRoutes.has(route.path)) throw new Error(`Duplicate dsh upgrade ${route.path}`);
    this.upgradeRoutes.set(route.path, route);
    return () => { if (this.upgradeRoutes.get(route.path) === route) this.upgradeRoutes.delete(route.path); };
  }

  override registerFallback(handler: WebRoute["handler"]): () => void {
    this.assertActive();
    if (this.fallbackRoutes.has("fallback")) throw new Error("dsh fallback already registered");
    this.fallbackRoutes.set("fallback", handler);
    return () => { if (this.fallbackRoutes.get("fallback") === handler) this.fallbackRoutes.delete("fallback"); };
  }

  private pathname(url: string): string {
    return new URL(url, "http://localapp.invalid").pathname;
  }

  private httpRoute(url: string): WebRoute | undefined {
    const pathname = this.pathname(url);
    const exact = this.httpRoutes.get(`exact:${pathname}`);
    if (exact) return exact;
    return [...this.httpRoutes.values()].filter(route => route.kind === "prefix" &&
      (pathname === route.path || pathname.startsWith(`${route.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }

  hasHttpRoute(url: string): boolean { return this.httpRoute(url) !== undefined || this.fallbackRoutes.has("fallback"); }
  hasUpgradeRoute(url: string): boolean { return this.upgradeRoutes.has(this.pathname(url)); }

  async dispatchHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const route = this.httpRoute(request.url ?? "/");
    const handler = route?.handler ?? this.fallbackRoutes.get("fallback");
    if (!handler) return false;
    await handler(request, response);
    return true;
  }

  async dispatchUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const route = this.upgradeRoutes.get(this.pathname(request.url ?? "/"));
    if (!route) return false;
    await route.handler(request, socket, head);
    return true;
  }
}
