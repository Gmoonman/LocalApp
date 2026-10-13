/**
 * 校验 url 是否为相对路径（同源）。
 *
 * 拒绝：
 * - 绝对 URL（含 scheme，如 `https://`、`http://`、`mailto:`）
 * - 协议相对 URL（以 `//` 开头）
 *
 * 接受：以 `/` 开头的路径（含查询字符串、hash）。
 */
export function validateRelativeUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  if (!url.startsWith("/") || url.startsWith("//")) return false;
  if (url.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/u.test(url)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  if (/%(?![0-9a-f]{2})/i.test(url)) return false;
  for (const match of url.matchAll(/%([0-9a-f]{2})/gi)) {
    const byte = Number.parseInt(match[1], 16);
    if (byte === 0x25 || byte === 0x2f || byte === 0x5c || byte <= 0x1f || byte === 0x7f) {
      return false;
    }
  }

  try {
    const decoded = decodeURI(url);
    if (decoded.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/u.test(decoded)) return false;
    const base = new URL("http://localapp.invalid/");
    const parsed = new URL(url, base);
    return parsed.origin === base.origin
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname.startsWith("/")
      && !parsed.pathname.startsWith("//");
  } catch {
    return false;
  }
}

export interface NotifyPayload {
  title: string;
  body?: string;
  url?: string;
  priority: "normal" | "high";
  to?: string[];
  data?: Record<string, unknown>;
}

const ALLOWED_PRIORITIES = new Set(["normal", "high"]);

/**
 * 校验 notify 端点 payload。
 *
 * 成功返回 `{ ok: true, payload }`；失败返回 `{ ok: false, error }`。
 * 用判别式联合方便调用方通过 `if (!result.ok)` 窄化类型。
 */
export type NotifyPayloadResult =
  | { ok: true; payload: NotifyPayload }
  | { ok: false; error: string };

export function validateNotifyPayload(input: unknown): NotifyPayloadResult {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Payload must be a JSON object" };
  }
  const obj = input as Record<string, unknown>;

  const { title, body, url, priority, to, data } = obj;

  if (typeof title !== "string" || title.length === 0) {
    return { ok: false, error: "title is required and must be a non-empty string" };
  }
  if (title.length > 200) {
    return { ok: false, error: "title must be at most 200 characters" };
  }

  if (body !== undefined && body !== null) {
    if (typeof body !== "string") {
      return { ok: false, error: "body must be a string" };
    }
    if (body.length > 1000) {
      return { ok: false, error: "body must be at most 1000 characters" };
    }
  }

  if (url !== undefined && url !== null) {
    if (typeof url !== "string" || !validateRelativeUrl(url)) {
      return { ok: false, error: "url must be a relative path (same-origin)" };
    }
  }

  let normalizedPriority: "normal" | "high" = "normal";
  if (priority !== undefined && priority !== null) {
    if (typeof priority !== "string" || !ALLOWED_PRIORITIES.has(priority)) {
      return { ok: false, error: "priority must be one of: normal, high" };
    }
    normalizedPriority = priority as "normal" | "high";
  }

  if (to !== undefined && to !== null) {
    if (!Array.isArray(to) || !to.every((v) => typeof v === "string")) {
      return { ok: false, error: "to must be an array of user_id strings" };
    }
  }

  if (data !== undefined && data !== null) {
    if (typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "data must be an object" };
    }
    const serialized = JSON.stringify(data);
    if (serialized.length > 4 * 1024) {
      return { ok: false, error: "data must serialize to at most 4KB" };
    }
  }

  const payload: NotifyPayload = {
    title,
    priority: normalizedPriority,
  };
  if (typeof body === "string") payload.body = body;
  if (typeof url === "string") payload.url = url;
  if (Array.isArray(to)) payload.to = to;
  if (data && typeof data === "object") payload.data = data as Record<string, unknown>;

  return { ok: true, payload };
}
