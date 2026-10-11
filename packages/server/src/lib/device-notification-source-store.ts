import { DeviceNotificationSourceStore as PluginStore } from "@localapp/dsh-app-platform/device-notification-source-store";
import { apiKeyStorageValue, findUserById, getDb, getPeerRecord, listPeerRecords, mutateMetaDbAtomically } from "./meta-sqlite.js";
import type { SecretBox } from "./secret-box.js";
export * from "@localapp/dsh-app-platform/device-notification-source-store";
export function createDeviceNotificationPersistence() {
  return { database: getDb, atomic: mutateMetaDbAtomically, keyStorage: apiKeyStorageValue,
    user: findUserById, peer: getPeerRecord, peers: listPeerRecords };
}
export class DeviceNotificationSourceStore extends PluginStore {
  constructor(secretBox: SecretBox, keyFactory?: () => string) {
    super(createDeviceNotificationPersistence(), secretBox, keyFactory);
  }
}
