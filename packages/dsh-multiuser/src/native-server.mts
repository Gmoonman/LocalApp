import { Service } from "@deepseek-ai/cordis";
import WebServer, { type WebRoute, type WebUpgradeRoute } from "@deepseek-ai/dsh-host-webserver";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/**
 * dsh route carrier inside the existing LocalApp Server. The caller must select
 * this user's Context after authentication, before dispatching HTTP or upgrades.
 * dsh owns the RPC, event and WebSocket protocols; this service opens no listener.
 */
export default class EmbeddedWebServer extends WebServer {
  private readonly httpRoutes = new Map<string, WebRoute>();
  private readonly upgradeRoutes = new Map<string, WebUpgradeRoute>();

  override async [Service.init](): Promise<void> {
    // The composing Server already owns node:http and its listening socket.
  }

  override register(route: WebRoute): () => void {
    const key = `${route.kind}:${route.path}`;
    if (this.httpRoutes.has(key)) throw new Error(`Duplicate dsh route ${route.path}`);
    this.httpRoutes.set(key, route);
    return () => { if (this.httpRoutes.get(key) === route) this.httpRoutes.delete(key); };
  }

  override registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgradeRoutes.has(route.path)) throw new Error(`Duplicate dsh upgrade ${route.path}`);
    this.upgradeRoutes.set(route.path, route);
    return () => { if (this.upgradeRoutes.get(route.path) === route) this.upgradeRoutes.delete(route.path); };
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

  hasHttpRoute(url: string): boolean { return this.httpRoute(url) !== undefined; }
  hasUpgradeRoute(url: string): boolean { return this.upgradeRoutes.has(this.pathname(url)); }

  async dispatchHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const route = this.httpRoute(request.url ?? "/");
    if (!route) return false;
    await route.handler(request, response);
    return true;
  }

  async dispatchUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const route = this.upgradeRoutes.get(this.pathname(request.url ?? "/"));
    if (!route) return false;
    await route.handler(request, socket, head);
    return true;
  }
}
