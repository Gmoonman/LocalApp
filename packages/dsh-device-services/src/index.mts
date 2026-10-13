import { registerDeviceNotifications, parseDeviceNotificationJson } from "@localapp/dsh-device-services/device-notifications-routes";
import { DeviceNotificationSourceStore } from "@localapp/dsh-device-services/device-notification-source-store";
import { createDesktopActionRoutes } from "@localapp/dsh-device-services/desktop-actions-routes";
import { createDeviceActionRoutes } from "@localapp/dsh-device-services/device-actions-routes";
import { registerDeviceControl } from "@localapp/dsh-device-services/device-control-routes";
import { createDeviceActionStore } from "@localapp/dsh-device-services/desktop-actions-db";
import type { NotificationServices } from "@localapp/dsh-device-services/notification-services";
import { registerApplicationInbox } from "@localapp/dsh-device-services/inbox-routes";
import { registerApplicationSubscriptions } from "@localapp/dsh-device-services/subscription-routes";
import type { FastifyInstance, FastifyRequest } from "fastify";
import * as notifications from "@localapp/dsh-device-services/notify-handler";
import { Context, Service } from "@deepseek-ai/cordis";
export default class Contribution extends Service {
    private active = true;
    constructor(ctx: Context) { super(ctx, "localappDeviceServices"); ctx.effect(() => () => { this.active = false; }); }
    private assertActive() { if (!this.active)
        throw new Error("dsh-device-services plugin is stopped"); }
    private route<Args extends unknown[], Result>(register: (app: FastifyInstance, ...args: Args) => Result) {
        return (app: FastifyInstance, ...args: Args): Result => {
            this.assertActive();
            app.addHook("onRequest", async (_req, reply) => { if (!this.active)
                return reply.code(503).send({ success: false, error: "Plugin is stopped" }); });
            return register(app, ...args);
        };
    }
    registerDeviceRoutes(app: FastifyInstance, host: {
        desktop: ReturnType<typeof createDesktopActionRoutes>;
        device: ReturnType<typeof createDeviceActionRoutes>;
        control: Parameters<typeof registerDeviceControl>[1];
    }) {
        this.assertActive();
        app.register(async (scope) => host.desktop.register(scope));
        app.register(async (scope) => host.device.register(scope));
        app.register(async (scope) => this.registerDeviceControl(scope, host.control));
    }
    registerNotificationRoutes(app: FastifyInstance, store: DeviceNotificationSourceStore, host: Parameters<typeof registerDeviceNotifications>[2]) {
        this.assertActive();
        app.register(async (scope) => {
            scope.removeContentTypeParser("application/json");
            scope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
                try {
                    done(null, parseDeviceNotificationJson(String(body)));
                }
                catch {
                    done(null, { __invalidJson: true });
                }
            });
            await this.registerDeviceNotifications(scope, store, host);
        });
    }
    readonly registerDeviceNotifications = this.route(registerDeviceNotifications);
    createDeviceNotificationSources(...options: ConstructorParameters<typeof DeviceNotificationSourceStore>) {
        this.assertActive();
        return new DeviceNotificationSourceStore(...options);
    }
    createDesktopActionRoutes(host: Parameters<typeof createDesktopActionRoutes>[0]) {
        this.assertActive();
        return createDesktopActionRoutes({ ...host, isActive: () => this.active, onStop: cleanup => { this.ctx.effect(() => cleanup); } });
    }
    createDeviceActionRoutes(host: Parameters<typeof createDeviceActionRoutes>[0]) {
        this.assertActive();
        return createDeviceActionRoutes({ ...host, isActive: () => this.active, onStop: cleanup => { this.ctx.effect(() => cleanup); } });
    }
    readonly deviceActions = createDeviceActionStore;
    readonly registerDeviceControl = this.route(registerDeviceControl);
    readonly notifications = notifications;
    readonly registerSubscriptions = this.route(registerApplicationSubscriptions);
    readonly registerInbox = this.route(registerApplicationInbox);
}
declare module "@deepseek-ai/cordis" {
    interface Context {
        localappDeviceServices: Contribution;
    }
}
