import type { Database } from "sql.js";
export interface PeerRow {
  id: string;
  name: string;
  baseUrl: string;
  credential: string;
  acceptInsecureHttp: boolean;
  connectionVersion: number;
  verifiedUserId: string | null;
  verifiedUserName: string | null;
  verifiedUserDisplayName: string | null;
  protocolVersion: number | null;
  transferLimits: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PeerPersistence { database(): Database; flush(): void; }
export class PeerRecords {
 constructor(private readonly persistence: PeerPersistence) {}
createPeerRecord(peer: PeerRow): PeerRow {
  const d = this.persistence.database();
  d.run(
    `INSERT INTO peers (id, name, base_url, credential, accept_insecure_http, connection_version, verified_user_id, verified_user_name, verified_user_display_name, protocol_version, transfer_limits, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [peer.id, peer.name, peer.baseUrl, peer.credential, peer.acceptInsecureHttp ? 1 : 0, peer.connectionVersion, peer.verifiedUserId, peer.verifiedUserName, peer.verifiedUserDisplayName, peer.protocolVersion, peer.transferLimits, peer.verifiedAt, peer.createdAt, peer.updatedAt],
  );
  this.persistence.flush();
  return peer;
}

getPeerRecord(id: string): PeerRow | null {
  const stmt = this.persistence.database().prepare("SELECT * FROM peers WHERE id = ?");
  stmt.bind([id]);
  const peer = stmt.step() ? peerFromRow(stmt.getAsObject() as Record<string, unknown>) : null;
  stmt.free();
  return peer;
}

listPeerRecords(): PeerRow[] {
  const stmt = this.persistence.database().prepare("SELECT * FROM peers ORDER BY created_at ASC, id ASC");
  const peers: PeerRow[] = [];
  while (stmt.step()) peers.push(peerFromRow(stmt.getAsObject() as Record<string, unknown>));
  stmt.free();
  return peers;
}

updatePeerRecord(peer: PeerRow): PeerRow | null {
  const d = this.persistence.database();
  d.run(
    `UPDATE peers SET name = ?, base_url = ?, credential = ?, accept_insecure_http = ?, connection_version = ?, verified_user_id = ?, verified_user_name = ?, verified_user_display_name = ?, protocol_version = ?, transfer_limits = ?, verified_at = ?, updated_at = ? WHERE id = ?`,
    [peer.name, peer.baseUrl, peer.credential, peer.acceptInsecureHttp ? 1 : 0, peer.connectionVersion, peer.verifiedUserId, peer.verifiedUserName, peer.verifiedUserDisplayName, peer.protocolVersion, peer.transferLimits, peer.verifiedAt, peer.updatedAt, peer.id],
  );
  if (d.getRowsModified() === 0) return null;
  this.persistence.flush();
  return peer;
}

deletePeerRecord(id: string): boolean {
  const d = this.persistence.database();
  d.run("DELETE FROM peers WHERE id = ?", [id]);
  const deleted = d.getRowsModified() > 0;
  if (deleted) this.persistence.flush();
  return deleted;
}

updatePeerVerificationIfCurrent(input: {
  id: string;
  connectionVersion: number;
  verifiedUserId: string;
  verifiedUserName: string;
  verifiedUserDisplayName: string | null;
  protocolVersion: number;
  transferLimits: string;
  verifiedAt: string;
  updatedAt: string;
}): "updated" | "changed" | "missing" {
  const d = this.persistence.database();
  d.run(
    `UPDATE peers SET verified_user_id = ?, verified_user_name = ?, verified_user_display_name = ?, protocol_version = ?, transfer_limits = ?, verified_at = ?, updated_at = ? WHERE id = ? AND connection_version = ?`,
    [input.verifiedUserId, input.verifiedUserName, input.verifiedUserDisplayName, input.protocolVersion, input.transferLimits, input.verifiedAt, input.updatedAt, input.id, input.connectionVersion],
  );
  if (d.getRowsModified() > 0) {
    this.persistence.flush();
    return "updated";
  }
  return this.getPeerRecord(input.id) ? "changed" : "missing";
}
}
function peerFromRow(row: Record<string, unknown>): PeerRow {
  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    credential: String(row.credential),
    acceptInsecureHttp: Number(row.accept_insecure_http) === 1,
    connectionVersion: Number(row.connection_version),
    verifiedUserId: row.verified_user_id == null ? null : String(row.verified_user_id),
    verifiedUserName: row.verified_user_name == null ? null : String(row.verified_user_name),
    verifiedUserDisplayName: row.verified_user_display_name == null ? null : String(row.verified_user_display_name),
    protocolVersion: row.protocol_version == null ? null : Number(row.protocol_version),
    transferLimits: row.transfer_limits == null ? null : String(row.transfer_limits),
    verifiedAt: row.verified_at == null ? null : String(row.verified_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

