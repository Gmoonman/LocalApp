import { registerPeerProtocol } from "@localapp/dsh-app-sync/peer-protocol-routes";
import { registerPeers } from "@localapp/dsh-app-sync/peers-routes";
import { PeerStore, type PeerSecrets } from "@localapp/dsh-app-sync/peer-store";
import type { PeerPersistence } from "@localapp/dsh-app-sync/peer-records";
import { AppSyncSource, type SyncPeers } from "@localapp/dsh-app-sync/app-sync-source";
import { registerSyncSource } from "@localapp/dsh-app-sync/sync-source-routes";
import { registerSyncTarget } from "@localapp/dsh-app-sync/sync-target-routes";
import { AppSyncTarget } from "@localapp/dsh-app-sync/app-sync-target";
import { SyncJobStore, type SyncJobPersistence } from "@localapp/dsh-app-sync/sync-job-store";
import { SyncSessionStore } from "@localapp/dsh-app-sync/sync-session-store";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Context, Service } from "@deepseek-ai/cordis";
export default class Contribution extends Service {
    private active = true;
    constructor(ctx: Context) { super(ctx, "localappAppSync"); ctx.effect(() => () => { this.active = false; }); }
    private assertActive() { if (!this.active)
        throw new Error("dsh-app-sync plugin is stopped"); }
    private route<Args extends unknown[], Result>(register: (app: FastifyInstance, ...args: Args) => Result) {
        return (app: FastifyInstance, ...args: Args): Result => {
            this.assertActive();
            app.addHook("onRequest", async (_req, reply) => { if (!this.active)
                return reply.code(503).send({ success: false, error: "Plugin is stopped" }); });
            return register(app, ...args);
        };
    }
    registerSynchronizationRoutes(app: FastifyInstance, host: {
        protocol: Parameters<typeof registerPeerProtocol>[1];
        target: AppSyncTarget;
        authenticateTarget: Parameters<typeof registerSyncTarget>[2];
        source: AppSyncSource;
        userId: Parameters<typeof registerSyncSource>[2];
        authenticateUser: (scope: FastifyInstance) => Promise<void>;
        peers: PeerStore;
        authenticateAdministrator: Parameters<typeof registerPeers>[2];
    }) {
        this.assertActive();
        app.register(async (scope) => this.registerPeerProtocol(scope, host.protocol));
        app.register(async (scope) => this.registerSyncTarget(scope, host.target, host.authenticateTarget));
        app.register(async (scope) => this.registerPeers(scope, host.peers, host.authenticateAdministrator));
        app.register(async (scope) => {
            await host.authenticateUser(scope);
            await this.registerSyncSource(scope, host.source, host.userId);
        });
    }
    async initializeSynchronization(host: {
        dataDir: string;
        secrets: PeerSecrets;
        persistence: PeerPersistence;
    }) {
        this.assertActive();
        const peerStore = this.peers(host.secrets, host.persistence);
        const sessions = this.syncSessions({ dataDir: host.dataDir });
        sessions.prune();
        const jobs = this.syncJobs(host.persistence);
        jobs.reconcileInterrupted();
        const syncTarget = this.syncTarget(host.dataDir, sessions);
        await syncTarget.reconcileInterrupted();
        this.assertActive();
        const syncSource = this.syncSource(host.dataDir, jobs, peerStore);
        return { peerStore, syncTarget, syncSource };
    }
    readonly registerPeerProtocol = this.route(registerPeerProtocol);
    readonly registerPeers = this.route(registerPeers);
    peers(secrets: PeerSecrets, persistence: PeerPersistence) {
        this.assertActive();
        return new PeerStore(secrets, persistence);
    }
    readonly registerSyncSource = this.route(registerSyncSource);
    syncSource(dataDir: string, jobs: SyncJobStore, peers: SyncPeers) {
        this.assertActive();
        const source = new AppSyncSource(dataDir, jobs, peers);
        this.ctx.effect(() => () => source.shutdown());
        return source;
    }
    readonly registerSyncTarget = this.route(registerSyncTarget);
    syncTarget(dataDir: string, sessions: SyncSessionStore) {
        this.assertActive();
        const target = new AppSyncTarget(dataDir, sessions);
        this.ctx.effect(() => () => target.shutdown());
        return target;
    }
    syncJobs(persistence: SyncJobPersistence) {
        this.assertActive();
        return new SyncJobStore(persistence);
    }
    syncSessions(options: ConstructorParameters<typeof SyncSessionStore>[0]) {
        this.assertActive();
        return new SyncSessionStore(options);
    }
}
declare module "@deepseek-ai/cordis" {
    interface Context {
        localappAppSync: Contribution;
    }
}
