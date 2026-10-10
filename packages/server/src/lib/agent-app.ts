import { findUserByName, findUserById } from "./meta-sqlite.js";
import { getPageDir, readPageMeta } from "../plugins/storage.js";
import { readManifestState } from "./app-manifest.js";
import { checkPageAccess } from "./access-control.js";
import type { ApplicationStore } from "@localapp/dsh-app-platform" with { "resolution-mode": "import" };

export function applicationStore(dataDir: string): ApplicationStore {
  return {
    owner: identity => findUserByName(identity) ?? findUserById(identity) ?? undefined,
    application: (ownerId, name) => {
      const meta = readPageMeta(dataDir, ownerId, name);
      if (!meta) return;
      return {
        ownerId: meta.userId, access: meta.pageAccess, offline: meta.lifecycle?.status === "offline",
        get capabilities() {
          const manifest = readManifestState(getPageDir(dataDir, ownerId, name), meta).effectiveManifest;
          return (manifest.agent as { capabilities?: unknown } | undefined)?.capabilities;
        },
      };
    },
    canAccess: (access, userId, ownerId) => checkPageAccess(access as Parameters<typeof checkPageAccess>[0], userId, ownerId),
  };
}
