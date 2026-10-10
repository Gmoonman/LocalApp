import { Context, Service } from "@deepseek-ai/cordis";
import { AGENT_CAPABILITIES, type AgentCapability } from "@localapp/dsh-multiuser/settings";
import * as database from "./app-db.cjs";
import * as backend from "./backend-contract.cjs";
import * as appRuntime from "./app-runtime.cjs";
import * as recordAccess from "./record-access.cjs";

export interface ApplicationRecord {
  ownerId: string;
  offline: boolean;
  access: unknown;
  capabilities: unknown;
}

/** Persistence and group membership are supplied by the unified Server. */
export interface ApplicationStore {
  owner(nameOrId: string): { id: string; name: string } | undefined;
  application(ownerId: string, name: string): ApplicationRecord | undefined;
  canAccess(access: unknown, userId: string, ownerId: string): boolean;
}

export class ApplicationPlatform extends Service {
  readonly database = database;
  readonly backend = backend;
  readonly appRuntime = appRuntime;
  readonly recordAccess = recordAccess;
  constructor(ctx: Context, private readonly store: ApplicationStore) {
    super(ctx, "localappApps");
  }

  resolveAgentApp(userId: string, appId?: string): { id: string; capabilities: AgentCapability[] } {
    if (!appId || appId === "platform") return { id: "platform", capabilities: [] };
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(appId)) throw new Error("Invalid application identity");
    const [ownerName, name] = appId.split("/");
    const owner = this.store.owner(ownerName);
    const record = owner && this.store.application(owner.id, name);
    if (!owner || !record || record.offline || !this.store.canAccess(record.access, userId, record.ownerId)) throw new Error("Application is unavailable");
    const capabilities = record.capabilities;
    if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.some(value => !AGENT_CAPABILITIES.includes(value)))) throw new Error("Invalid application Agent capabilities");
    return { id: `${owner.name}/${name}`, capabilities: [...(capabilities ?? [])] as AgentCapability[] };
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context { localappApps: ApplicationPlatform; }
}

export default ApplicationPlatform;
