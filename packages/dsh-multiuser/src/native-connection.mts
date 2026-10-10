import { Context } from "@deepseek-ai/cordis";
import * as Connection from "@deepseek-ai/dsh-client-connection";
import LocalCredentials from "@deepseek-ai/dsh-credentials-local";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import EmbeddedWebServer from "./native-server.mjs";

export interface NativeConnectionConfig {
  userId: string;
  root: string;
  trustedHosts?: string[];
}

/** One private dsh Connection per authenticated user's isolated Context. */
export async function mountNativeConnection(ctx: Context, config: NativeConnectionConfig) {
  if (!config.userId || !path.isAbsolute(config.root)) throw new Error("Invalid native connection config");
  if (!(ctx.webServer instanceof EmbeddedWebServer)) throw new Error("Native connection requires the existing Server carrier");
  const nativeContext = ctx.isolate("credentials");
  await nativeContext.plugin(LocalCredentials, { dshHome: config.root, watch: false });
  await nativeContext.plugin(Connection, { trustedHosts: config.trustedHosts ?? [] });
  const connection = nativeContext.connection;
  const carrier = ctx.webServer as EmbeddedWebServer;
  let closed = false;
  ctx.effect(() => () => { closed = true; });

  function cookieFor(authority: string): string {
    // Internal authentication preserves dsh's normal request checks. This cookie
    // never reaches the browser, and is only minted after outer user admission.
    const launch = new URL(connection.authenticatedUrl(`http://${authority}/`));
    let cookie: string | undefined;
    connection.authorizeIndex({ method: "GET", url: launch.pathname + launch.search, headers: { host: authority } }, {
      writeHead(_status, headers) { cookie = headers?.["set-cookie"]?.split(";", 1)[0]; },
      end() {},
    });
    if (!cookie) throw new Error("Native connection authentication failed");
    return cookie;
  }

  async function admitted<T>(userId: string, request: IncomingMessage, run: () => Promise<T>): Promise<T> {
    if (closed) throw new Error("Native connection closed");
    if (userId !== config.userId) throw new Error("Native connection belongs to another user");
    const authority = request.headers.host;
    if (!authority) throw new Error("Native connection requires Host");
    const original = request.headers.cookie;
    request.headers.cookie = cookieFor(authority);
    try { return await run(); }
    finally { if (original === undefined) delete request.headers.cookie; else request.headers.cookie = original; }
  }

  return {
    // userId must come from the Server's authentication result, never the body.
    http(userId: string, request: IncomingMessage, response: ServerResponse) {
      return admitted(userId, request, () => carrier.dispatchHttp(request, response));
    },
    upgrade(userId: string, request: IncomingMessage, socket: Duplex, head: Buffer) {
      return admitted(userId, request, () => carrier.dispatchUpgrade(request, socket, head));
    },
  };
}
