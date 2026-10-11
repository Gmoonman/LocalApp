import fs from "node:fs";
import path from "node:path";
import {
  assertDeviceActionIdentity,
  canonicalizeDeviceActionPermissions,
  deviceActionPermissionsContain,
  deviceActionPermissionsDigest,
  type DeviceActionIdentity,
  type DeviceActionPermissionSet,
} from "./device-action-types.cjs";

export type DeviceActionTrustIdentity = DeviceActionIdentity;

export interface DeviceActionTrustGrant extends DeviceActionTrustIdentity {
  permissions: DeviceActionPermissionSet;
  permissionsDigest: string;
  trustedAt: string;
}

export class DeviceActionTrustStore {
  private readonly filePath?: string;
  private grants: DeviceActionTrustGrant[];

  constructor(options: { dataDir?: string } = {}) {
    this.filePath = options.dataDir ? path.join(options.dataDir, "device-actions", "trust.json") : undefined;
    this.grants = this.load();
  }

  find(identity: DeviceActionTrustIdentity, requested: unknown): DeviceActionTrustGrant | null {
    const normalizedIdentity = assertDeviceActionIdentity(identity);
    const permissions = canonicalizeDeviceActionPermissions(requested);
    return this.grants.find((grant) => sameIdentity(grant, normalizedIdentity)
      && deviceActionPermissionsContain(grant.permissions, permissions)) ?? null;
  }

  grant(identity: DeviceActionTrustIdentity, requested: unknown): DeviceActionTrustGrant {
    const normalizedIdentity = assertDeviceActionIdentity(identity);
    const permissions = canonicalizeDeviceActionPermissions(requested);
    const record: DeviceActionTrustGrant = {
      ...normalizedIdentity,
      permissions,
      permissionsDigest: deviceActionPermissionsDigest(permissions),
      trustedAt: new Date().toISOString(),
    };
    this.grants = [
      ...this.grants.filter((grant) => !sameIdentity(grant, normalizedIdentity)),
      record,
    ];
    this.persist();
    return record;
  }

  revoke(identity: DeviceActionTrustIdentity): boolean {
    const normalizedIdentity = assertDeviceActionIdentity(identity);
    const before = this.grants.length;
    this.grants = this.grants.filter((grant) => !sameIdentity(grant, normalizedIdentity));
    if (this.grants.length !== before) this.persist();
    return this.grants.length !== before;
  }

  list(): DeviceActionTrustGrant[] {
    return this.grants.map((grant) => ({ ...grant, permissions: { ...grant.permissions } }));
  }

  private load(): DeviceActionTrustGrant[] {
    if (!this.filePath || !fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((candidate) => {
        try {
          if (candidate === null || typeof candidate !== "object") return [];
          const value = candidate as Record<string, unknown>;
          const identity = assertDeviceActionIdentity({
            sourceOrigin: typeof value.sourceOrigin === "string" ? value.sourceOrigin : "",
            appOwner: typeof value.appOwner === "string" ? value.appOwner : "",
            appName: typeof value.appName === "string" ? value.appName : "",
            publisherUserId: typeof value.publisherUserId === "string" ? value.publisherUserId : "",
            publisherDisplayName: typeof value.publisherDisplayName === "string" ? value.publisherDisplayName : null,
          });
          const permissions = canonicalizeDeviceActionPermissions(value.permissions);
          return [{
            ...identity,
            permissions,
            permissionsDigest: deviceActionPermissionsDigest(permissions),
            trustedAt: typeof value.trustedAt === "string" ? value.trustedAt : new Date(0).toISOString(),
          }];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.grants, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}

function sameIdentity(left: DeviceActionTrustIdentity, right: DeviceActionTrustIdentity): boolean {
  return left.sourceOrigin === right.sourceOrigin
    && left.appOwner === right.appOwner
    && left.appName === right.appName
    && left.publisherUserId === right.publisherUserId;
}
