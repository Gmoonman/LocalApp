import type { Database } from "sql.js";
import { ISSUE_SAVED_REPLY_LIMIT, normalizeIssueSavedReplyInput, type IssueSavedReplyInput } from "./issue-saved-replies.cjs";
export interface SavedReplyRecord {
  id: number;
  userId: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
export function createSavedRepliesStore(persistence: { database(): Database; flush(): void }) {
function savedReplyFromRow(row: Record<string, unknown>): SavedReplyRecord {
  return {
    id: Number(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    body: String(row.body),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function listSavedReplies(userId: string): SavedReplyRecord[] {
  const stmt = persistence.database().prepare("SELECT * FROM saved_replies WHERE user_id = ? ORDER BY updated_at DESC, id DESC");
  stmt.bind([userId]);
  const replies: SavedReplyRecord[] = [];
  while (stmt.step()) replies.push(savedReplyFromRow(stmt.getAsObject()));
  stmt.free();
  return replies;
}

function createSavedReply(userId: string, value: IssueSavedReplyInput): SavedReplyRecord {
  const input = normalizeIssueSavedReplyInput(value);
  const d = persistence.database();
  const countStmt = d.prepare("SELECT COUNT(*) AS count FROM saved_replies WHERE user_id = ?");
  countStmt.bind([userId]);
  countStmt.step();
  const count = Number((countStmt.getAsObject() as { count: number }).count);
  countStmt.free();
  if (count >= ISSUE_SAVED_REPLY_LIMIT) throw new Error("SAVED_REPLY_LIMIT_EXCEEDED");
  const now = new Date().toISOString();
  try {
    d.run("INSERT INTO saved_replies (user_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [userId, input.title, input.body, now, now]);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) throw new Error("SAVED_REPLY_TITLE_CONFLICT");
    throw error;
  }
  persistence.flush();
  const stmt = d.prepare("SELECT * FROM saved_replies WHERE user_id = ? AND title = ?");
  stmt.bind([userId, input.title]);
  if (!stmt.step()) { stmt.free(); throw new Error("SAVED_REPLY_CREATE_FAILED"); }
  const reply = savedReplyFromRow(stmt.getAsObject());
  stmt.free();
  return reply;
}

function updateSavedReply(userId: string, id: number, value: IssueSavedReplyInput): SavedReplyRecord | null {
  const input = normalizeIssueSavedReplyInput(value);
  const d = persistence.database();
  try {
    d.run("UPDATE saved_replies SET title = ?, body = ?, updated_at = ? WHERE id = ? AND user_id = ?", [input.title, input.body, new Date().toISOString(), id, userId]);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) throw new Error("SAVED_REPLY_TITLE_CONFLICT");
    throw error;
  }
  if (d.getRowsModified() === 0) return null;
  persistence.flush();
  const stmt = d.prepare("SELECT * FROM saved_replies WHERE id = ? AND user_id = ?");
  stmt.bind([id, userId]);
  const reply = stmt.step() ? savedReplyFromRow(stmt.getAsObject()) : null;
  stmt.free();
  return reply;
}

function deleteSavedReply(userId: string, id: number): boolean {
  const d = persistence.database();
  d.run("DELETE FROM saved_replies WHERE id = ? AND user_id = ?", [id, userId]);
  const deleted = d.getRowsModified() > 0;
  if (deleted) persistence.flush();
  return deleted;
}

  return { listSavedReplies, createSavedReply, updateSavedReply, deleteSavedReply };
}
