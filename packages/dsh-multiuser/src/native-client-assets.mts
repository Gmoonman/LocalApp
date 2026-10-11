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
  private scheduledAssets?: Promise<Context>;
  private readonly ready: Promise<void>;
  constructor(ctx: Context, private readonly config: { baseUrl?: string; contributions?: string[] } = {}) {
    super(ctx, "nativeClientAssets");
    this.ready = (async () => {
      await this.assets.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
      await mountNativeClientModules(this.assets, false, config);
    })();
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.assets.fiber.dispose(); });
  }
  [Service.init](): Promise<void> { return this.ready; }
  private async context(schedule: boolean): Promise<Context> {
    await this.ready;
    if (!schedule) return this.assets;
    return this.scheduledAssets ??= (async () => {
      const assets = new Context();
      this.ctx.effect(() => () => assets.fiber.dispose());
      await assets.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
      await mountNativeClientModules(assets, true, this.config);
      return assets;
    })();
  }
  async renderIndex(html: string, schedule = false): Promise<string> {
    return (await this.context(schedule)).webServer.renderIndex(html);
  }
  async resource(request: IncomingMessage, response: ServerResponse, schedule = false): Promise<boolean> {
    const assets = await this.context(schedule);
    if (!new URL(request.url ?? "/", "http://localapp.invalid").pathname.startsWith("/plugins/")) return false;
    return (assets.webServer as EmbeddedWebServer).dispatchHttp(request, response);
  }
}
