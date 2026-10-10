export const ISSUE_SAVED_REPLY_LIMIT = 100;

export interface IssueSavedReplyInput {
  title: string;
  body: string;
}

export function normalizeIssueSavedReplyInput(value: unknown): IssueSavedReplyInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_SAVED_REPLY");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "title" && key !== "body")) throw new Error("INVALID_SAVED_REPLY");
  if (typeof input.title !== "string" || typeof input.body !== "string") throw new Error("INVALID_SAVED_REPLY");
  const title = input.title.trim();
  const body = input.body.trim();
  if (Array.from(title).length < 1 || Array.from(title).length > 80) throw new Error("INVALID_SAVED_REPLY_TITLE");
  if (Array.from(body).length < 1 || Array.from(body).length > 20_000) throw new Error("INVALID_SAVED_REPLY_BODY");
  return { title, body };
}
