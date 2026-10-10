import { Context, Service } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import EmbeddedWebServer from "./native-server.mjs";
import { mountNativeClientModules } from "./native-client.mjs";

declare module "@deepseek-ai/cordis" {
  interface Context { nativeClientAssets: NativeClientAssets }
}

/** Shared UI resources have their own Context, separate from private Agents. */
export default class NativeClientAssets extends Service {
  private readonly assets = new Context();
  private readonly ready: Promise<void>;
  constructor(ctx: Context) {
    super(ctx, "nativeClientAssets");
    this.ready = (async () => {
      await this.assets.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
      await mountNativeClientModules(this.assets);
    })();
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.assets.fiber.dispose(); });
  }
  [Service.init](): Promise<void> { return this.ready; }
  async renderIndex(html: string): Promise<string> {
    await this.ready;
    return this.assets.webServer.renderIndex(html);
  }
  async resource(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    await this.ready;
    if (!new URL(request.url ?? "/", "http://localapp.invalid").pathname.startsWith("/plugins/")) return false;
    return (this.assets.webServer as EmbeddedWebServer).dispatchHttp(request, response);
  }
}
