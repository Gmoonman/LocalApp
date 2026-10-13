import { Context, Service } from "@deepseek-ai/cordis";
import type { FastifyInstance } from "fastify";
import { registerAgentRoutes, type AgentRoutesHost } from "./agent-routes.mjs";
import { registerLlmRoutes, type LlmRoutesHost } from "./llm-routes.cjs";
export interface RuntimeIdentity {
    userId: string;
    applicationId: string;
    role: "user" | "developer";
    providerId: string;
}
export interface Runtime {
    close(): Promise<void>;
}
interface Entry {
    identity: RuntimeIdentity;
    fingerprint: string;
    ready: Promise<Runtime>;
    value?: Runtime;
    invalidated: boolean;
    disposal?: Promise<void>;
}
export interface AgentRuntimeConfig {
    capacity?: number;
}
export default class AgentRuntime extends Service {
    private readonly entries = new Map<string, Entry>();
    private readonly capacity: number;
    private stopped = false;
    private closing?: Promise<void>;
    constructor(ctx: Context, config: AgentRuntimeConfig = {}) {
        super(ctx, "localappAgentRuntime");
        this.capacity = config.capacity ?? 100;
        if (!Number.isSafeInteger(this.capacity) || this.capacity < 1)
            throw new Error("Invalid Agent capacity");
        ctx.effect(() => () => this.close());
    }
    registerModelRoutes(app: FastifyInstance, host: {
        authenticate(scope: FastifyInstance): Promise<void>;
        llm: LlmRoutesHost;
        agent(): Promise<AgentRoutesHost>;
        nativeClientRoot?: string;
    }) {
        if (this.stopped)
            throw new Error("Agent runtime service closed");
        app.register(async (scope) => {
            await host.authenticate(scope);
            await this.registerLlm(scope, host.llm);
            scope.register(async (agentScope) => {
                agentScope.addHook("preClose", () => this.close());
                await this.registerAgent(agentScope, await host.agent(), { nativeClientRoot: host.nativeClientRoot });
            });
        });
    }
    registerAgent(app: FastifyInstance, host: AgentRoutesHost, options: {
        nativeClientRoot?: string;
    } = {}) {
        if (this.stopped)
            throw new Error("Agent runtime service closed");
        return registerAgentRoutes(app, host, options);
    }
    registerLlm(app: FastifyInstance, host: LlmRoutesHost) {
        if (this.stopped)
            throw new Error("Agent runtime service closed");
        return registerLlmRoutes(app, host);
    }
    private key(identity: RuntimeIdentity) {
        return JSON.stringify([identity.userId, identity.applicationId, identity.role, identity.providerId]);
    }
    async acquire<T extends Runtime>(identity: RuntimeIdentity, fingerprint: string, create: () => Promise<T>): Promise<T> {
        if (this.stopped)
            throw new Error("Agent runtime service closed");
        if (Object.values(identity).some(value => typeof value !== "string" || !value))
            throw new Error("Invalid runtime identity");
        const key = this.key(identity);
        const current = this.entries.get(key);
        if (current) {
            if (current.invalidated || current.fingerprint !== fingerprint) {
                await this.release(key, current);
                return this.acquire(identity, fingerprint, create);
            }
            const value = await current.ready;
            if (current.invalidated) {
                await this.release(key, current);
                throw new Error("Agent runtime invalidated");
            }
            return value as T;
        }
        if (this.entries.size >= this.capacity)
            throw new Error("Agent capacity reached");
        const entry: Entry = {
            identity: { ...identity }, fingerprint, invalidated: false,
            ready: Promise.resolve().then(create),
        };
        this.entries.set(key, entry);
        try {
            const value = await entry.ready;
            entry.value = value;
            if (entry.invalidated) {
                await this.release(key, entry);
                throw new Error("Agent runtime invalidated");
            }
            return value as T;
        }
        catch (error) {
            if (!entry.invalidated && this.entries.get(key) === entry)
                this.entries.delete(key);
            throw error;
        }
    }
    forUser<T extends Runtime>(userId: string): T[] {
        return [...this.entries.values()].filter(entry => entry.identity.userId === userId && !entry.invalidated && entry.value)
            .map(entry => entry.value as T);
    }
    private release(key: string, entry: Entry): Promise<void> {
        entry.invalidated = true;
        return entry.disposal ??= (async () => {
            try {
                // Failed initialization has no usable runtime; its factory owns cleanup.
                const value = await entry.ready.catch(() => undefined);
                if (value)
                    await value.close();
            }
            finally {
                if (this.entries.get(key) === entry)
                    this.entries.delete(key);
            }
        })();
    }
    async invalidate(userId: string, applicationId?: string): Promise<void> {
        const results = await Promise.allSettled([...this.entries].filter(([, entry]) => entry.identity.userId === userId && (applicationId === undefined || entry.identity.applicationId === applicationId))
            .map(([key, entry]) => this.release(key, entry)));
        const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
        if (failures.length)
            throw new AggregateError(failures, "Agent runtime cleanup failed");
    }
    close(): Promise<void> {
        this.stopped = true;
        return this.closing ??= (async () => {
            const results = await Promise.allSettled([
                ...[...this.entries].map(([key, entry]) => this.release(key, entry)),
            ]);
            const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
            if (failures.length)
                throw new AggregateError(failures, "Agent runtime cleanup failed");
        })();
    }
}
declare module "@deepseek-ai/cordis" {
    interface Context {
        localappAgentRuntime: AgentRuntime;
    }
}
export type RuntimeRegistry = Pick<AgentRuntime, "acquire" | "forUser" | "invalidate" | "close">;
