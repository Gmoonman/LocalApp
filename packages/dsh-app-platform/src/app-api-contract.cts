// 应用 API 表面：仅识别平台辅助、内容、named SQL、schemas 自省。
// REST CRUD / transitions / raw SQL / legacy upload 等路径全部走 not-found。

export interface AppApiRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  visitor?: { id: string | null; name?: string | null; role?: string | null };
  ownerId?: string;
}

export interface AppApiJsonBody {
  success: boolean;
  data?: unknown;
  error?: string;
  pagination?: { offset: number; limit: number; total: number };
}

export interface AppApiResponse {
  status: number;
  body: AppApiJsonBody;
  headers?: Record<string, string>;
}

export type AppApiRoute =
  | { kind: "not-found" }
  | { kind: "invalid"; error: string }
  | { kind: "time" }
  | { kind: "me" }
  | { kind: "users" }
  | { kind: "groups" }
  | { kind: "group-detail"; id: string }
  | { kind: "platform"; path: string }
  | { kind: "content-upload" }
  | { kind: "content-read"; key: string }
  | { kind: "named-query"; name: string }
  | { kind: "named-mutation"; name: string }
  | { kind: "named-mutation-transaction" }
  | { kind: "action"; name: string }
  | { kind: "schemas" };

export function appApiJson(status: number, body: AppApiJsonBody): AppApiResponse {
  return {
    status,
    body,
    headers: { "content-type": "application/json; charset=utf-8" },
  };
}

export function normalizeAppApiPath(pathname: string): string {
  const withoutApi = pathname.startsWith("/api/") ? pathname.slice("/api".length) : pathname;
  const normalized = withoutApi.startsWith("/") ? withoutApi : `/${withoutApi}`;
  return normalized.replace(/\/+$/, "") || "/";
}

export function matchAppApiRoute(method: string, pathname: string): AppApiRoute {
  const verb = method.toUpperCase();
  const path = normalizeAppApiPath(pathname);
  const parts = path.split("/").filter(Boolean);

  if (verb === "GET" && path === "/time") return { kind: "time" };
  if (verb === "GET" && path === "/me") return { kind: "me" };
  if (verb === "GET" && path === "/users") return { kind: "users" };
  if (verb === "GET" && path === "/groups") return { kind: "groups" };
  if (verb === "GET" && parts.length === 2 && parts[0] === "groups") {
    return { kind: "group-detail", id: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === "platform") return { kind: "platform", path };
  if (verb === "POST" && path === "/content/upload") return { kind: "content-upload" };
  if (verb === "GET" && parts.length === 2 && parts[0] === "content") {
    return { kind: "content-read", key: decodeURIComponent(parts[1]) };
  }
  if (verb === "POST" && parts.length === 2 && parts[0] === "queries") {
    return { kind: "named-query", name: decodeURIComponent(parts[1]) };
  }
  if (verb === "POST" && parts.length === 2 && parts[0] === "mutations") {
    if (parts[1] === "_transaction") return { kind: "named-mutation-transaction" };
    return { kind: "named-mutation", name: decodeURIComponent(parts[1]) };
  }
  if (verb === "POST" && parts.length === 2 && parts[0] === "actions") {
    return { kind: "action", name: decodeURIComponent(parts[1]) };
  }
  if (verb === "GET" && path === "/_schemas") return { kind: "schemas" };

  return { kind: "not-found" };
}
