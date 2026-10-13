import { PeerStore as PluginPeerStore, type PeerSecrets } from "@localapp/dsh-app-sync/peer-store";
import { getDb, flushMetaDb } from "./meta-sqlite.js";
export * from "@localapp/dsh-app-sync/peer-store";
export class PeerStore extends PluginPeerStore {
 constructor(secrets: PeerSecrets) { super(secrets, { database: getDb, flush: flushMetaDb }); }
}
