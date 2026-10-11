import { execRawSql, runDbTransaction } from "./app-db.cjs";

const TABLE = "_localapp_crdt_documents";
let yjsPromise: Promise<any> | null = null;

function getYjs(): Promise<any> {
  yjsPromise ??= import("yjs");
  return yjsPromise;
}

export class CrdtStoreError extends Error {
  constructor(
    readonly code: "CRDT_UPDATE_INVALID" | "CRDT_DOCUMENT_TOO_LARGE" | "CRDT_STATE_VECTOR_INVALID" | "CRDT_DOCUMENT_CORRUPT",
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CrdtStoreError";
  }
}

export async function readCrdtDiff(input: {
  dbPath: string;
  resource: string;
  documentId: string;
  stateVector?: Uint8Array;
}): Promise<Uint8Array> {
  return runDbTransaction(input.dbPath, async () => {
    ensureCrdtTable(input.dbPath);
    const snapshot = readSnapshot(input.dbPath, input.resource, input.documentId);
    const Y = await getYjs();
    try {
      if (input.stateVector && input.stateVector.byteLength > 0) Y.decodeStateVector(input.stateVector);
    } catch {
      throw new CrdtStoreError("CRDT_STATE_VECTOR_INVALID", "CRDT state vector is invalid");
    }
    if (!snapshot) return new Uint8Array();
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, snapshot);
    } catch {
      throw new CrdtStoreError("CRDT_DOCUMENT_CORRUPT", "Stored CRDT document is corrupt", 500);
    }
    return input.stateVector && input.stateVector.byteLength > 0
      ? Y.encodeStateAsUpdate(doc, input.stateVector)
      : Y.encodeStateAsUpdate(doc);
  });
}

export async function applyCrdtUpdate(input: {
  dbPath: string;
  resource: string;
  documentId: string;
  update: Uint8Array;
  actorId: string;
  maxDocumentBytes: number;
}): Promise<{ snapshotBytes: number; updatedAt: string }> {
  if (input.update.byteLength === 0) throw new CrdtStoreError("CRDT_UPDATE_INVALID", "CRDT update is empty");
  return runDbTransaction(input.dbPath, async () => {
    ensureCrdtTable(input.dbPath);
    const current = readSnapshot(input.dbPath, input.resource, input.documentId);
    let snapshot: Uint8Array;
    try {
      const Y = await getYjs();
      const doc = new Y.Doc();
      if (current) Y.applyUpdate(doc, current);
      Y.applyUpdate(doc, input.update);
      snapshot = Y.encodeStateAsUpdate(doc);
    } catch {
      throw new CrdtStoreError("CRDT_UPDATE_INVALID", "CRDT update is invalid");
    }
    if (snapshot.byteLength > input.maxDocumentBytes) {
      throw new CrdtStoreError(
        "CRDT_DOCUMENT_TOO_LARGE",
        `CRDT document exceeds ${input.maxDocumentBytes} bytes`,
        413,
      );
    }
    const updatedAt = new Date().toISOString();
    execRawSql(
      input.dbPath,
      `INSERT INTO ${TABLE} (resource, document_id, snapshot, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(resource, document_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
      [input.resource, input.documentId, snapshot, input.actorId, updatedAt],
    );
    return { snapshotBytes: snapshot.byteLength, updatedAt };
  });
}

function ensureCrdtTable(dbPath: string): void {
  execRawSql(
    dbPath,
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      resource TEXT NOT NULL,
      document_id TEXT NOT NULL,
      snapshot BLOB NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (resource, document_id)
    )`,
  );
}

function readSnapshot(dbPath: string, resource: string, documentId: string): Uint8Array | null {
  const row = execRawSql(
    dbPath,
    `SELECT snapshot FROM ${TABLE} WHERE resource = ? AND document_id = ?`,
    [resource, documentId],
  ).rows?.[0];
  const value = row?.snapshot;
  if (value instanceof Uint8Array) return value;
  return null;
}
