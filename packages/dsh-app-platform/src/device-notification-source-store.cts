import { randomBytes, randomUUID } from "node:crypto";
import type { Database as SqlJsDatabase } from "sql.js";
import type { PeerRow } from "./peer-records.cjs";
export interface DeviceNotificationPersistence {
  database(): SqlJsDatabase;
  atomic<T>(mutation: (database: SqlJsDatabase) => T): T;
  keyStorage(value: string): string;
  user(id: string): { name: string; displayName: string | null } | null;
  peer(id: string): PeerRow | null;
  peers(): PeerRow[];
}
export interface DeviceNotificationSecrets { seal(value: string, aad: string): string; open(value: string, aad: string): string; }
export type DeviceNotificationSourceKind = "local" | "peer";
export type DeviceNotificationConnectionState = "disabled" | "pending" | "connecting" | "connected" | "error";
export type DeviceNotificationPermissionState = "not-determined" | "granted" | "denied" | "unsupported" | "unknown";
export type DeviceNotificationTestResult = "shown" | "denied" | "unsupported" | "failed";
export interface DeviceNotificationDisplaySettings {
  quietHours: { start: string; end: string; timeZone: string } | null;
  preview: "full" | "hidden";
}
export interface DeviceNotificationPeerCandidate {
  peerId: string;
  sourceLabel: string;
  accountLabel: string;
}

export interface DeviceNotificationPublicSource {
  id: string;
  kind: DeviceNotificationSourceKind;
  peerId?: string;
  sourceLabel: string;
  accountLabel: string;
  desiredEnabled: boolean;
  capability: { available: boolean; reason: string | null };
  connectionState: DeviceNotificationConnectionState;
  cursor: number | null;
  lastEventAt: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceNotificationInternalSource {
  id: string;
  kind: DeviceNotificationSourceKind;
  generation: number;
  sourceOrigin: string;
  targetUserId: string;
  accountLabel: string;
  sourceLabel: string;
  enabled: boolean;
  capability: { available: boolean; reason: string | null };
  credential?: string;
}

type SourceRow = {
  id: string;
  ownerUserId: string;
  kind: DeviceNotificationSourceKind;
  targetUserId: string;
  peerId: string | null;
  peerConnectionVersion: number | null;
  sourceOrigin: string;
  sourceLabel: string;
  accountLabel: string;
  desiredEnabled: boolean;
  encryptedCredential: string | null;
  revocationKey: string | null;
  configGeneration: number;
  statusGeneration: number | null;
  statusState: DeviceNotificationConnectionState;
  statusCursor: number | null;
  statusLastEventAt: string | null;
  statusErrorCode: string | null;
  statusErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export class DeviceNotificationSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class DeviceNotificationSourceStore {
  constructor(
    private readonly persistence: DeviceNotificationPersistence,
    private readonly secretBox: DeviceNotificationSecrets,
    private readonly keyFactory: () => string = () => randomBytes(24).toString("hex"),
  ) {}

  generation(): number {
    const values = this.persistence.database().exec("SELECT generation FROM device_notification_state WHERE singleton = 1")[0]?.values;
    const generation = Number(values?.[0]?.[0]);
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("DEVICE_NOTIFICATION_STATE_CORRUPT");
    return generation;
  }

  listPublic(ownerUserId: string): DeviceNotificationPublicSource[] {
    return this.listRows("WHERE owner_user_id = ?", [ownerUserId]).map((row) => this.publicSource(row));
  }

  getPublic(ownerUserId: string, sourceId: string): DeviceNotificationPublicSource | null {
    const row = this.findRow("owner_user_id = ? AND id = ?", [ownerUserId, sourceId]);
    return row ? this.publicSource(row) : null;
  }

  listPeerCandidates(ownerUserId: string): DeviceNotificationPeerCandidate[] {
    const existing = new Set(this.listRows("WHERE owner_user_id = ? AND kind = 'peer'", [ownerUserId]).map((row) => row.peerId));
    return this.persistence.peers()
      .filter((peer) => isVerifiedPeer(peer) && !existing.has(peer.id))
      .map((peer) => ({
        peerId: peer.id,
        sourceLabel: peer.name,
        accountLabel: peer.verifiedUserDisplayName ?? peer.verifiedUserName ?? "Unknown user",
      }))
      .sort((left, right) => left.sourceLabel.localeCompare(right.sourceLabel) || left.peerId.localeCompare(right.peerId));
  }

  enableLocal(input: { ownerUserId: string; sourceOrigin: string; sourceLabel: string; expectedGeneration: number }) {
    const user = this.persistence.user(input.ownerUserId);
    if (!user) throw new DeviceNotificationSourceError("DEVICE_NOTIFICATION_ACCOUNT_NOT_FOUND");
    const existing = this.findRow("owner_user_id = ? AND kind = 'local' AND target_user_id = ?", [input.ownerUserId, input.ownerUserId]);
    if (existing?.desiredEnabled && existing.sourceLabel === input.sourceLabel && existing.sourceOrigin === input.sourceOrigin) {
      return { generation: this.generation(), source: this.publicSource(existing) };
    }
    this.assertGeneration(input.expectedGeneration);

    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    let key: string | null = null;
    let encryptedCredential = existing?.encryptedCredential ?? null;
    let revocationKey = existing?.revocationKey ?? null;
    if (!existing?.desiredEnabled) {
      key = this.keyFactory();
      revocationKey = this.persistence.keyStorage(key);
      encryptedCredential = this.secretBox.seal(key, localCredentialAad(id));
    }

    this.persistence.atomic((database) => {
      const generation = incrementGeneration(database);
      if (key && revocationKey) {
        database.run("INSERT INTO api_keys (key, user_id, created_at) VALUES (?, ?, ?)", [revocationKey, input.ownerUserId, now]);
      }
      database.run(`
        INSERT INTO device_notification_sources (
          id, owner_user_id, kind, target_user_id, peer_id, peer_connection_version,
          source_origin, source_label, account_label, desired_enabled, encrypted_credential,
          revocation_key, config_generation, status_generation, status_state, status_cursor,
          status_last_event_at, status_error_code, status_error_message, created_at, updated_at
        ) VALUES (?, ?, 'local', ?, NULL, NULL, ?, ?, ?, 1, ?, ?, ?, NULL, 'pending', NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_origin = excluded.source_origin,
          source_label = excluded.source_label,
          account_label = excluded.account_label,
          desired_enabled = 1,
          encrypted_credential = excluded.encrypted_credential,
          revocation_key = excluded.revocation_key,
          config_generation = excluded.config_generation,
          status_generation = NULL,
          status_state = 'pending',
          status_cursor = NULL,
          status_last_event_at = NULL,
          status_error_code = NULL,
          status_error_message = NULL,
          updated_at = excluded.updated_at
      `, [id, input.ownerUserId, input.ownerUserId, input.sourceOrigin, input.sourceLabel, user.displayName ?? user.name, encryptedCredential, revocationKey, generation, existing?.createdAt ?? now, now]);
    });
    return { generation: this.generation(), source: this.publicSource(this.requiredRow(id)) };
  }

  enablePeer(input: { ownerUserId: string; peerId: string; sourceLabel: string; expectedGeneration: number }) {
    const peer = this.persistence.peer(input.peerId);
    if (!isVerifiedPeer(peer)) throw new DeviceNotificationSourceError("DEVICE_NOTIFICATION_PEER_NOT_VERIFIED");
    const existing = this.findRow("owner_user_id = ? AND kind = 'peer' AND target_user_id = ?", [input.ownerUserId, peer.verifiedUserId]);
    if (existing?.desiredEnabled && existing.peerId === peer.id && existing.peerConnectionVersion === peer.connectionVersion
      && existing.targetUserId === peer.verifiedUserId && existing.sourceLabel === input.sourceLabel) {
      return { generation: this.generation(), source: this.publicSource(existing) };
    }
    this.assertGeneration(input.expectedGeneration);
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    this.persistence.atomic((database) => {
      const generation = incrementGeneration(database);
      database.run(`
        INSERT INTO device_notification_sources (
          id, owner_user_id, kind, target_user_id, peer_id, peer_connection_version,
          source_origin, source_label, account_label, desired_enabled, encrypted_credential,
          revocation_key, config_generation, status_generation, status_state, status_cursor,
          status_last_event_at, status_error_code, status_error_message, created_at, updated_at
        ) VALUES (?, ?, 'peer', ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, NULL, 'pending', NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          target_user_id = excluded.target_user_id,
          peer_id = excluded.peer_id,
          peer_connection_version = excluded.peer_connection_version,
          source_origin = excluded.source_origin,
          source_label = excluded.source_label,
          account_label = excluded.account_label,
          desired_enabled = 1,
          encrypted_credential = NULL,
          revocation_key = NULL,
          config_generation = excluded.config_generation,
          status_generation = NULL,
          status_state = 'pending',
          status_cursor = NULL,
          status_last_event_at = NULL,
          status_error_code = NULL,
          status_error_message = NULL,
          updated_at = excluded.updated_at
      `, [id, input.ownerUserId, peer.verifiedUserId, peer.id, peer.connectionVersion, peer.baseUrl, input.sourceLabel, peer.verifiedUserDisplayName ?? peer.verifiedUserName, generation, existing?.createdAt ?? now, now]);
    });
    return { generation: this.generation(), source: this.publicSource(this.requiredRow(id)) };
  }

  disable(input: { ownerUserId: string; sourceId: string; expectedGeneration: number }) {
    const existing = this.findRow("owner_user_id = ? AND id = ?", [input.ownerUserId, input.sourceId]);
    if (!existing) throw new DeviceNotificationSourceError("DEVICE_NOTIFICATION_SOURCE_NOT_FOUND");
    if (!existing.desiredEnabled) return { generation: this.generation(), source: this.publicSource(existing) };
    this.assertGeneration(input.expectedGeneration);
    const now = new Date().toISOString();
    this.persistence.atomic((database) => {
      const generation = incrementGeneration(database);
      if (existing.revocationKey) database.run("DELETE FROM api_keys WHERE key = ?", [existing.revocationKey]);
      database.run(`
        UPDATE device_notification_sources SET
          desired_enabled = 0, encrypted_credential = NULL, revocation_key = NULL,
          config_generation = ?, status_generation = NULL, status_state = 'disabled',
          status_cursor = NULL, status_last_event_at = NULL,
          status_error_code = NULL, status_error_message = NULL, updated_at = ?
        WHERE id = ? AND owner_user_id = ?
      `, [generation, now, input.sourceId, input.ownerUserId]);
    });
    return { generation: this.generation(), source: this.publicSource(this.requiredRow(input.sourceId)) };
  }

  snapshot(): { generation: number; sources: DeviceNotificationInternalSource[] } {
    return { generation: this.generation(), sources: this.listRows().map((row) => this.internalSource(row)) };
  }

  reportStatus(sourceId: string, input: {
    generation: number;
    state: Exclude<DeviceNotificationConnectionState, "disabled">;
    cursor: number | null;
    lastEventAt: string | null;
    error: { code: string; message: string } | null;
  }): DeviceNotificationPublicSource {
    const row = this.findRow("id = ?", [sourceId]);
    if (!row) throw new DeviceNotificationSourceError("DEVICE_NOTIFICATION_SOURCE_NOT_FOUND");
    if (!row.desiredEnabled || row.configGeneration !== input.generation) {
      throw new DeviceNotificationSourceError("DEVICE_NOTIFICATION_STALE_STATUS");
    }
    const now = new Date().toISOString();
    this.persistence.atomic((database) => {
      database.run(`
        UPDATE device_notification_sources SET status_generation = ?, status_state = ?, status_cursor = ?,
          status_last_event_at = ?, status_error_code = ?, status_error_message = ?, updated_at = ?
        WHERE id = ? AND desired_enabled = 1 AND config_generation = ?
      `, [input.generation, input.state, input.cursor, input.lastEventAt, input.error?.code ?? null, input.error ? "Notification source reported an error" : null, now, sourceId, input.generation]);
      if (database.getRowsModified() !== 1) throw new DeviceNotificationSourceError("DEVICE_NOTIFICATION_STALE_STATUS");
    });
    return this.publicSource(this.requiredRow(sourceId));
  }

  controlState(ownerUserId: string) {
    const state = requiredNotificationState(this.persistence.database());
    const last = this.persistence.database().exec(`
      SELECT id, state, result FROM device_notification_test_commands
      WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `, [ownerUserId])[0]?.values[0];
    const permission = String(state.native_permission);
    if (!NOTIFICATION_PERMISSIONS.has(permission) || !validStoredVersion(state.daemon_version) || !validStoredVersion(state.adapter_version)
      || !validStoredDate(state.native_updated_at) || !Number.isSafeInteger(Number(state.generation)) || Number(state.generation) < 0) {
      throw new Error("DEVICE_NOTIFICATION_STATE_CORRUPT");
    }
    if (last && (!NOTIFICATION_TEST_STATES.has(String(last[1])) || (last[2] !== null && !NOTIFICATION_TEST_RESULTS.has(String(last[2]))))) {
      throw new Error("DEVICE_NOTIFICATION_STATE_CORRUPT");
    }
    return {
      generation: Number(state.generation),
      settings: displaySettings(state),
      native: {
        permission: permission as DeviceNotificationPermissionState,
        daemonVersion: state.daemon_version == null ? null : String(state.daemon_version),
        adapterVersion: state.adapter_version == null ? null : String(state.adapter_version),
        updatedAt: state.native_updated_at == null ? null : String(state.native_updated_at),
      },
      lastTest: last ? { id: String(last[0]), state: String(last[1]), result: last[2] == null ? null : String(last[2]) } : null,
    };
  }

  updateDisplaySettings(input: { ownerUserId: string; expectedGeneration: number; settings: DeviceNotificationDisplaySettings }) {
    this.assertGeneration(input.expectedGeneration);
    this.persistence.atomic((database) => {
      incrementGeneration(database);
      database.run(`UPDATE device_notification_state SET quiet_hours_start = ?, quiet_hours_end = ?, quiet_hours_timezone = ?, preview = ? WHERE singleton = 1`, [
        input.settings.quietHours?.start ?? null,
        input.settings.quietHours?.end ?? null,
        input.settings.quietHours?.timeZone ?? null,
        input.settings.preview,
      ]);
    });
    return this.controlState(input.ownerUserId);
  }

  createTestCommand(input: { ownerUserId: string; expectedGeneration: number; now?: Date }) {
    if (!this.persistence.user(input.ownerUserId)) throw new DeviceNotificationSourceError("DEVICE_NOTIFICATION_ACCOUNT_NOT_FOUND");
    const now = input.now ?? new Date();
    const existing = this.persistence.database().exec(`
      SELECT id, state FROM device_notification_test_commands
      WHERE user_id = ? AND state IN ('pending', 'claimed') AND expires_at > ?
      ORDER BY created_at, id LIMIT 1
    `, [input.ownerUserId, now.toISOString()])[0]?.values[0];
    if (existing) return { generation: this.generation(), test: { id: String(existing[0]), state: String(existing[1]) as "pending" | "claimed", result: null } };
    this.assertGeneration(input.expectedGeneration);
    const id = randomUUID();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 2 * 60_000).toISOString();
    this.persistence.atomic((database) => {
      incrementGeneration(database);
      database.run("DELETE FROM device_notification_test_commands WHERE expires_at <= ?", [createdAt]);
      database.run(`INSERT INTO device_notification_test_commands (id, user_id, state, result, created_at, expires_at, completed_at) VALUES (?, ?, 'pending', NULL, ?, ?, NULL)`, [id, input.ownerUserId, createdAt, expiresAt]);
      database.run(`DELETE FROM device_notification_test_commands WHERE state = 'completed' AND id NOT IN (SELECT id FROM device_notification_test_commands WHERE state = 'completed' ORDER BY completed_at DESC, id DESC LIMIT 100)`);
    });
    return { generation: this.generation(), test: { id, state: "pending" as const, result: null } };
  }

  claimTestCommand(now = new Date()): { id: string; type: "test-notification"; userId: string } | null {
    let command: { id: string; type: "test-notification"; userId: string } | null = null;
    this.persistence.atomic((database) => {
      database.run("DELETE FROM device_notification_test_commands WHERE state != 'completed' AND expires_at <= ?", [now.toISOString()]);
      const row = database.exec(`SELECT id, user_id FROM device_notification_test_commands WHERE state = 'pending' ORDER BY created_at, id LIMIT 1`)[0]?.values[0];
      if (!row) return;
      database.run("UPDATE device_notification_test_commands SET state = 'claimed' WHERE id = ? AND state = 'pending'", [row[0]]);
      if (database.getRowsModified() !== 1) return;
      command = { id: String(row[0]), type: "test-notification", userId: String(row[1]) };
    });
    return command;
  }

  completeTestCommand(input: { id: string; result: DeviceNotificationTestResult; permission: DeviceNotificationPermissionState; daemonVersion: string; adapterVersion: string; now?: Date }) {
    const now = (input.now ?? new Date()).toISOString();
    this.persistence.atomic((database) => {
      database.run("UPDATE device_notification_test_commands SET state = 'completed', result = ?, completed_at = ? WHERE id = ? AND state = 'claimed'", [input.result, now, input.id]);
      if (database.getRowsModified() !== 1) throw new DeviceNotificationSourceError("DEVICE_NOTIFICATION_TEST_NOT_FOUND");
      incrementGeneration(database);
      database.run("UPDATE device_notification_state SET native_permission = ?, daemon_version = ?, adapter_version = ?, native_updated_at = ? WHERE singleton = 1", [input.permission, input.daemonVersion, input.adapterVersion, now]);
    });
    return { generation: this.generation() };
  }

  reportNativeStatus(input: { permission: DeviceNotificationPermissionState; daemonVersion: string; adapterVersion: string; now?: Date }) {
    const state = requiredNotificationState(this.persistence.database());
    if (state.native_permission === input.permission && state.daemon_version === input.daemonVersion && state.adapter_version === input.adapterVersion) {
      return { generation: this.generation() };
    }
    const now = (input.now ?? new Date()).toISOString();
    this.persistence.atomic((database) => {
      incrementGeneration(database);
      database.run("UPDATE device_notification_state SET native_permission = ?, daemon_version = ?, adapter_version = ?, native_updated_at = ? WHERE singleton = 1", [input.permission, input.daemonVersion, input.adapterVersion, now]);
    });
    return { generation: this.generation() };
  }

  async waitForGeneration(current: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.generation() !== current || timeoutMs === 0) return;
    await new Promise<void>((resolve) => {
      let interval: ReturnType<typeof setInterval> | undefined;
      const finish = () => {
        if (interval) clearInterval(interval);
        clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      interval = setInterval(() => { if (this.generation() !== current) finish(); }, Math.min(50, timeoutMs));
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private assertGeneration(expected: number): void {
    if (this.generation() !== expected) throw new DeviceNotificationSourceError("DEVICE_NOTIFICATION_GENERATION_CONFLICT");
  }

  private publicSource(row: SourceRow): DeviceNotificationPublicSource {
    const capability = this.capability(row);
    return {
      id: row.id,
      kind: row.kind,
      ...(row.kind === "peer" && row.peerId !== null ? { peerId: row.peerId } : {}),
      sourceLabel: row.sourceLabel,
      accountLabel: row.accountLabel,
      desiredEnabled: row.desiredEnabled,
      capability,
      connectionState: row.statusState,
      cursor: row.statusCursor,
      lastEventAt: row.statusLastEventAt,
      error: row.statusErrorCode && row.statusErrorMessage
        ? { code: bounded(row.statusErrorCode, 64), message: bounded(row.statusErrorMessage, 240) }
        : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private internalSource(row: SourceRow): DeviceNotificationInternalSource {
    const base = {
      id: row.id,
      kind: row.kind,
      generation: row.configGeneration,
      sourceOrigin: row.sourceOrigin,
      targetUserId: row.targetUserId,
      accountLabel: row.accountLabel,
      sourceLabel: row.sourceLabel,
    };
    if (!row.desiredEnabled) return { ...base, enabled: false, capability: this.capability(row) };
    try {
      if (row.kind === "local") {
        if (!row.encryptedCredential || !row.revocationKey) throw new Error("invalid local source");
        return {
          ...base,
          enabled: true,
          capability: { available: true, reason: null },
          credential: this.secretBox.open(row.encryptedCredential, localCredentialAad(row.id)),
        };
      }
      const peer = row.peerId ? this.persistence.peer(row.peerId) : null;
      if (!isVerifiedPeer(peer) || peer.connectionVersion !== row.peerConnectionVersion || peer.verifiedUserId !== row.targetUserId) {
        return { ...base, enabled: false, capability: { available: false, reason: "PEER_CONFIGURATION_CHANGED" } };
      }
      return {
        ...base,
        sourceOrigin: peer.baseUrl,
        enabled: true,
        capability: { available: true, reason: null },
        credential: this.secretBox.open(peer.credential, peer.id),
      };
    } catch {
      return {
        ...base,
        enabled: false,
        capability: { available: false, reason: row.kind === "local" ? "SOURCE_CREDENTIAL_INVALID" : "PEER_CREDENTIAL_INVALID" },
      };
    }
  }

  private capability(row: SourceRow): { available: boolean; reason: string | null } {
    if (row.statusErrorCode === "PEER_CONFIGURATION_CHANGED" || row.statusErrorCode === "PEER_DELETED") {
      return { available: false, reason: row.statusErrorCode };
    }
    if (row.kind === "peer" && row.desiredEnabled) {
      const peer = row.peerId ? this.persistence.peer(row.peerId) : null;
      if (!isVerifiedPeer(peer) || peer.connectionVersion !== row.peerConnectionVersion || peer.verifiedUserId !== row.targetUserId) {
        return { available: false, reason: "PEER_CONFIGURATION_CHANGED" };
      }
    }
    if (row.kind === "local" && row.desiredEnabled) {
      try {
        if (!row.encryptedCredential || !row.revocationKey) throw new Error("invalid local source");
        this.secretBox.open(row.encryptedCredential, localCredentialAad(row.id));
      } catch {
        return { available: false, reason: "SOURCE_CREDENTIAL_INVALID" };
      }
    }
    return { available: true, reason: null };
  }

  private requiredRow(id: string): SourceRow {
    const row = this.findRow("id = ?", [id]);
    if (!row) throw new Error("DEVICE_NOTIFICATION_SOURCE_NOT_FOUND");
    return row;
  }

  private findRow(condition: string, parameters: Array<string | number>): SourceRow | null {
    return this.listRows(`WHERE ${condition}`, parameters)[0] ?? null;
  }

  private listRows(clause = "", parameters: Array<string | number> = []): SourceRow[] {
    const statement = this.persistence.database().prepare(`SELECT * FROM device_notification_sources ${clause} ORDER BY created_at, id`);
    statement.bind(parameters);
    const rows: SourceRow[] = [];
    while (statement.step()) rows.push(sourceRow(statement.getAsObject()));
    statement.free();
    return rows;
  }
}

function incrementGeneration(database: SqlJsDatabase): number {
  database.run("UPDATE device_notification_state SET generation = generation + 1 WHERE singleton = 1");
  return Number(database.exec("SELECT generation FROM device_notification_state WHERE singleton = 1")[0]?.values[0]?.[0]);
}

function isVerifiedPeer(peer: PeerRow | null): peer is PeerRow & { verifiedUserId: string; verifiedUserName: string; verifiedAt: string } {
  return Boolean(peer?.verifiedUserId && peer.verifiedUserName && peer.verifiedAt && Number.isSafeInteger(peer.connectionVersion) && peer.connectionVersion > 0);
}

function localCredentialAad(id: string): string {
  return `device-notification-source:${id}:local-credential:v1`;
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function requiredNotificationState(database: SqlJsDatabase): Record<string, unknown> {
  const statement = database.prepare("SELECT * FROM device_notification_state WHERE singleton = 1");
  try {
    if (!statement.step()) throw new Error("DEVICE_NOTIFICATION_STATE_CORRUPT");
    return statement.getAsObject();
  } finally { statement.free(); }
}

function displaySettings(row: Record<string, unknown>): DeviceNotificationDisplaySettings {
  const start = row.quiet_hours_start == null ? null : String(row.quiet_hours_start);
  const end = row.quiet_hours_end == null ? null : String(row.quiet_hours_end);
  const timeZone = row.quiet_hours_timezone == null ? null : String(row.quiet_hours_timezone);
  if (row.preview !== "full" && row.preview !== "hidden") throw new Error("DEVICE_NOTIFICATION_STATE_CORRUPT");
  const allNull = start === null && end === null && timeZone === null;
  const allPresent = start !== null && end !== null && timeZone !== null;
  if (!allNull && !allPresent) throw new Error("DEVICE_NOTIFICATION_STATE_CORRUPT");
  if (allPresent && (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(end) || start === end || !validStoredTimeZone(timeZone))) {
    throw new Error("DEVICE_NOTIFICATION_STATE_CORRUPT");
  }
  return { quietHours: allPresent ? { start, end, timeZone } : null, preview: row.preview };
}

const NOTIFICATION_PERMISSIONS = new Set(["not-determined", "granted", "denied", "unsupported", "unknown"]);
const NOTIFICATION_TEST_STATES = new Set(["pending", "claimed", "completed"]);
const NOTIFICATION_TEST_RESULTS = new Set(["shown", "denied", "unsupported", "failed"]);
function validStoredVersion(value: unknown): boolean { return value == null || (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value)); }
function validStoredDate(value: unknown): boolean { return value == null || (typeof value === "string" && value.length <= 32 && !Number.isNaN(Date.parse(value))); }
function validStoredTimeZone(value: string): boolean { try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; } }

function sourceRow(row: Record<string, unknown>): SourceRow {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    kind: String(row.kind) as DeviceNotificationSourceKind,
    targetUserId: String(row.target_user_id),
    peerId: row.peer_id == null ? null : String(row.peer_id),
    peerConnectionVersion: row.peer_connection_version == null ? null : Number(row.peer_connection_version),
    sourceOrigin: String(row.source_origin),
    sourceLabel: String(row.source_label),
    accountLabel: String(row.account_label),
    desiredEnabled: Number(row.desired_enabled) === 1,
    encryptedCredential: row.encrypted_credential == null ? null : String(row.encrypted_credential),
    revocationKey: row.revocation_key == null ? null : String(row.revocation_key),
    configGeneration: Number(row.config_generation),
    statusGeneration: row.status_generation == null ? null : Number(row.status_generation),
    statusState: String(row.status_state) as DeviceNotificationConnectionState,
    statusCursor: row.status_cursor == null ? null : Number(row.status_cursor),
    statusLastEventAt: row.status_last_event_at == null ? null : String(row.status_last_event_at),
    statusErrorCode: row.status_error_code == null ? null : String(row.status_error_code),
    statusErrorMessage: row.status_error_message == null ? null : String(row.status_error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
