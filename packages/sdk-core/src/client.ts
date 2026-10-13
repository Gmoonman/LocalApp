import type { User, ListResult, ListOptions, UserBasic, GroupBasic, UploadResult, ServerTime, PlatformCapabilities } from "./types.js";

export class LocalAppError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LocalAppError";
    this.status = status;
  }
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  pagination?: { offset: number; limit: number; total: number };
}

export function detectBasePath(): string {
  const resourceBase = typeof document === "undefined"
    ? undefined
    : document
      .querySelector("[data-localapp-app-resource-base]")
      ?.getAttribute("data-localapp-app-resource-base")
      ?.trim();
  if (resourceBase?.startsWith("/serve/")) {
    return `${resourceBase.replace(/\/+$/, "")}/api`;
  }

  const pathname = window.location.pathname;
  const match = pathname.match(/^(\/serve\/[^/]+\/[^/]+)/);
  return match ? `${match[1]}/api` : "/api";
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await readApiResponse<T>(res);
  assertApiOk(res, body);
  return body.data;
}

async function readApiResponse<T>(res: Response): Promise<ApiResponse<T>> {
  try {
    return await res.json();
  } catch {
    return { success: false, data: undefined as T, error: `HTTP ${res.status}` };
  }
}

function assertApiOk<T>(res: Response, body: ApiResponse<T>): void {
  if (!res.ok || body.success === false) {
    throw new LocalAppError(body.error || `HTTP ${res.status}`, res.status);
  }
}

export interface ExecResult {
  columns?: string[];
  rows?: Record<string, unknown>[];
  changes?: number;
  lastInsertRowId?: number;
}

export interface NamedMutationStep {
  name: string;
  params?: Record<string, unknown>;
}

export interface NamedMutationResultRef {
  $result: number;
  field: "changes" | "lastInsertRowId";
}

export function transactionResult(index: number, field: NamedMutationResultRef["field"]): NamedMutationResultRef {
  return { $result: index, field };
}

export type NamedQueryResult = ExecResult & {
  pagination?: { offset: number; limit: number; total: number };
};

export interface TransitionInfo {
  name: string;
  label: string;
  to: unknown;
}

export interface AvailableTransitionsOptions {
  statusField?: string;
  transitions?: Array<{ name: string; label?: string; to: unknown; from?: unknown[] }>;
}

/**
 * 根据业务元数据中的 transitions 声明和当前 record 状态本地计算可执行的 transitions。
 * 纯函数，不发网络请求。
 *
 * 平台不再提供 GET /api/<resource>/:id/transitions 端点（restrict-app-api-to-named-sql
 * 变更整体移除了 transition 服务端执行入口）。前端通过此函数本地计算，UI 据此渲染按钮。
 * 实际执行改由应用自行声明的 named mutation（如 $<resource>.<action>）承担。
 */
export function availableTransitions(
  options: AvailableTransitionsOptions | undefined,
  record: Record<string, unknown>,
): TransitionInfo[] {
  if (!options?.transitions || !options.statusField) return [];
  const current = record[options.statusField];
  return options.transitions
    .filter((t) => !Array.isArray(t.from) || t.from.includes(current))
    .map((t) => ({
      name: t.name,
      label: t.label ?? t.name,
      to: t.to,
    }));
}

export interface FileBundleEntry { key: string; path: string }
export interface FileBundleJob {
  id: string; state: "queued" | "running" | "completed" | "failed";
  processedFiles: number; totalFiles: number; createdAt: number; expiresAt: number;
  error?: string; failedFile?: FileBundleEntry; downloadUrl?: string;
}
export interface LocalAppClient {
  basePath: string;
  me(): Promise<User | null>;
  users(): Promise<UserBasic[]>;
  groups(): Promise<GroupBasic[]>;
  groupMembers(groupId: string): Promise<UserBasic[]>;
  time(): Promise<ServerTime>;
  capabilities(): Promise<PlatformCapabilities>;
  list<T = Record<string, unknown>>(resource: string, options?: ListOptions): Promise<ListResult<T>>;
  get<T = Record<string, unknown>>(resource: string, id: number): Promise<T | null>;
  create<T = Record<string, unknown>>(resource: string, data: Record<string, unknown>): Promise<T>;
  update<T = Record<string, unknown>>(resource: string, id: number, data: Record<string, unknown>): Promise<T>;
  delete(resource: string, id: number): Promise<void>;
  count(resource: string, filters?: Record<string, string>): Promise<number>;
  query<T = NamedQueryResult>(name: string, params?: Record<string, unknown>): Promise<T>;
  mutate<T = ExecResult>(name: string, params?: Record<string, unknown>): Promise<T>;
  transaction<T = ExecResult[]>(mutations: NamedMutationStep[]): Promise<T>;
  /**
   * @deprecated Hosted backend actions are disabled in stable LocalApp.
   * Use query(), mutate(), transaction mutation helpers, or a platform primitive instead.
   */
  action<T = unknown>(name: string, input?: unknown): Promise<T>;
  upload(file: File): Promise<UploadResult>;
  createFileBundle(files: FileBundleEntry[], options: { idempotencyKey: string }): Promise<FileBundleJob>;
  getFileBundle(id: string): Promise<FileBundleJob>;
  fileBundleDownloadUrl(id: string): string;
  downloadFileBundle(id: string): void;
}

export function createClient(): LocalAppClient {
  const basePath = detectBasePath();

  return {
    basePath,

    async me() {
      return request<User | null>("/api/me", { method: "GET" });
    },

    async users() {
      return request<UserBasic[]>("/api/users", { method: "GET" });
    },

    async groups() {
      const res = await fetch("/api/groups", { method: "GET" });
      const body = await readApiResponse<GroupBasic[]>(res);
      assertApiOk(res, body);
      return body.data;
    },

    async groupMembers(groupId: string) {
      const res = await fetch(`/api/groups/${groupId}`, { method: "GET" });
      const body = await readApiResponse<{ members: UserBasic[] }>(res);
      assertApiOk(res, body);
      return body.data.members;
    },

    async time() {
      return request<ServerTime>(`${basePath}/time`, { method: "GET" });
    },

    async capabilities() {
      return request<PlatformCapabilities>("/api/platform/capabilities", { method: "GET" });
    },

    async list<T = Record<string, unknown>>(resource: string, options?: ListOptions): Promise<ListResult<T>> {
      const { offset, limit, sort, order, filters } = options ?? {};
      const params: Record<string, string | number | undefined> = {
        offset: offset ?? 0,
        limit: limit ?? 50,
        sort,
        order,
        ...filters,
      };
      const named = await this.query<NamedQueryResult>(`$${resource}.list`, params);
      return {
        rows: (named.rows ?? []) as T[],
        pagination: named.pagination ?? { offset: offset ?? 0, limit: limit ?? 50, total: named.rows?.length ?? 0 },
      };
    },

    async get<T = Record<string, unknown>>(resource: string, id: number): Promise<T | null> {
      const named = await this.query<T | { rows?: T[] }>(`$${resource}.get`, { id });
      if (isRowsResult<T>(named)) return named.rows[0] ?? null;
      return named as T;
    },

    async create<T = Record<string, unknown>>(resource: string, data: Record<string, unknown>): Promise<T> {
      const result = await this.mutate<ExecResult>(`$${resource}.create`, data);
      const insertedId = result.lastInsertRowId;
      if (typeof insertedId !== "number" || insertedId <= 0) {
        throw new LocalAppError(
          `$${resource}.create did not return a valid lastInsertRowId; declare $${resource}.get to fetch the inserted row.`,
          0,
        );
      }
      const row = await this.get<T>(resource, insertedId);
      if (row === null) {
        throw new LocalAppError(`Created ${resource} record not visible to current user (id=${insertedId}).`, 0);
      }
      return row;
    },

    async update<T = Record<string, unknown>>(resource: string, id: number, data: Record<string, unknown>): Promise<T> {
      await this.mutate<ExecResult>(`$${resource}.update`, { id, ...data });
      const row = await this.get<T>(resource, id);
      if (row === null) {
        throw new LocalAppError(`Updated ${resource} record not visible to current user (id=${id}).`, 0);
      }
      return row;
    },

    async delete(resource: string, id: number): Promise<void> {
      await this.mutate(`$${resource}.delete`, { id });
    },

    async count(resource: string, filters?: Record<string, string>): Promise<number> {
      const named = await this.query<{ count?: number; rows?: Record<string, unknown>[] }>(
        `$${resource}.count`,
        filters ?? {},
      );
      if (typeof named.count === "number") return named.count;
      const firstCount = named.rows?.[0]?.count;
      if (typeof firstCount === "number") return firstCount;
      return 0;
    },

    async query<T = NamedQueryResult>(name: string, params?: Record<string, unknown>): Promise<T> {
      return request<T>(`${basePath}/queries/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params: params ?? {} }),
      });
    },

    async mutate<T = ExecResult>(name: string, params?: Record<string, unknown>): Promise<T> {
      return request<T>(`${basePath}/mutations/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params: params ?? {} }),
      });
    },

    async transaction<T = ExecResult[]>(mutations: NamedMutationStep[]): Promise<T> {
      return request<T>(`${basePath}/mutations/_transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mutations: mutations.map((mutation) => ({
            name: mutation.name,
            params: mutation.params ?? {},
          })),
        }),
      });
    },

    async action<T = unknown>(name: string, input?: unknown): Promise<T> {
      return request<T>(`${basePath}/actions/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: input ?? {} }),
      });
    },

    async createFileBundle(files, options) {
      return request<FileBundleJob>(`${basePath}/content/bundles`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files, idempotencyKey: options.idempotencyKey }),
      });
    },
    async getFileBundle(id) {
      return request<FileBundleJob>(`${basePath}/content/bundles/${encodeURIComponent(id)}`, { method: "GET" });
    },
    fileBundleDownloadUrl(id) { return `${basePath}/content/bundles/${encodeURIComponent(id)}/download`; },
    downloadFileBundle(id) {
      const link = document.createElement("a");
      link.href = `${basePath}/content/bundles/${encodeURIComponent(id)}/download`;
      link.download = `${id}.zip`; document.body.appendChild(link); link.click(); link.remove();
    },
    async upload(file: File): Promise<UploadResult> {
      const formData = new FormData();
      formData.append("file", file);
      const uploadPath = basePath.replace(/\/api$/, "/api/content/upload");
      const res = await fetch(uploadPath, { method: "POST", body: formData });
      const body = await readApiResponse<UploadResult>(res);
      assertApiOk(res, body);
      return body.data;
    },
  };
}

function isRowsResult<T>(value: unknown): value is { rows: T[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as { rows?: unknown }).rows);
}

export function redirectToLogin(): void {
  const event = new CustomEvent("localapp:platform_request", {
    cancelable: true,
    detail: {
      type: "localapp:platform_request",
      id: `auth-login-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      capability: "auth.login",
    },
  });
  if (!window.dispatchEvent(event)) return;
  window.location.href = `/`;
}

// 注：原 listTransitions / executeTransition 方法已随服务端 transition 端点整体
// 移除（restrict-app-api-to-named-sql 变更）。前端用 availableTransitions 本地
// 计算 + mutate('$<resource>.<action>', { id, ...payload }) 执行。
//
// 原 exec(sql, params) 方法（raw SQL 入口）也同步移除——/api/db/exec 端点已删。
// 应用必须将所有数据操作声明为 named SQL，通过 query() / mutate() 调用。
