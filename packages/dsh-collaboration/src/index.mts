import type { FastifyInstance } from "fastify";
import { createApplicationCollaboration } from "@localapp/dsh-collaboration/collaboration-handler";
import { createApplicationCrdt } from "@localapp/dsh-collaboration/crdt-handler";
import * as crdt from "@localapp/dsh-collaboration/crdt-store";
import { Context, Service } from "@deepseek-ai/cordis";
export default class Contribution extends Service {
    private active = true;
    constructor(ctx: Context) { super(ctx, "localappCollaboration"); ctx.effect(() => () => { this.active = false; }); }
    private assertActive() { if (!this.active)
        throw new Error("dsh-collaboration plugin is stopped"); }
    private route<Args extends unknown[], Result>(register: (app: FastifyInstance, ...args: Args) => Result) {
        return (app: FastifyInstance, ...args: Args): Result => {
            this.assertActive();
            app.addHook("onRequest", async (_req, reply) => { if (!this.active)
                return reply.code(503).send({ success: false, error: "Plugin is stopped" }); });
            return register(app, ...args);
        };
    }
    readonly crdt = crdt;
    createCrdt(host: Parameters<typeof createApplicationCrdt>[0]) {
        this.assertActive();
        const handlers = createApplicationCrdt(host);
        this.ctx.effect(() => () => handlers.dispose());
        return handlers;
    }
    createCollaboration(host: Parameters<typeof createApplicationCollaboration>[0]) {
        this.assertActive();
        const handlers = createApplicationCollaboration(host);
        this.ctx.effect(() => () => handlers.dispose());
        return handlers;
    }
}
declare module "@deepseek-ai/cordis" {
    interface Context {
        localappCollaboration: Contribution;
    }
}
