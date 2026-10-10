import type { NotifyPermission } from "../types/models.js";
import { getConnection, getDbPath } from "./app-db.js";
import { validateNotifyPermissionConfig, buildPermissionSql } from "./notify-permission-sql.js";
export { setGroupMembershipResolver, checkAccess, checkPageAccess, checkRouteAccess, checkRouteAccessWithManifest } from "@localapp/dsh-app-platform/access-control";

/**
 * Notify 端点权限校验。
 *
 * 返回值：
 * - `{ status: 200 }` 表示通过
 * - `{ status: 401 }` 表示未登录
 * - `{ status: 403 }` 表示已登录但无权限
 * - `{ status: 500 }` 表示配置/查询错误
 *
 * 优先级：owner 始终通过；否则 Level 3（manifest.permission 自定义 SQL）>
 * Level 2（_localapp_notifiers 系统约定表）> Level 1（owner-only）。
 */
export type NotifyPermissionResult =
  | { status: 200 }
  | { status: 401; error: string }
  | { status: 403; error: string }
  | { status: 500; error: string };

const NOTIFIERS_TABLE = "_localapp_notifiers";

function tableExists(db: import("sql.js").Database, tableName: string): boolean {
  const stmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  stmt.bind([tableName]);
  let exists = false;
  if (stmt.step()) exists = true;
  stmt.free();
  return exists;
}

function isUserInNotifiersTable(db: import("sql.js").Database, userId: string): boolean {
  const stmt = db.prepare(
    `SELECT 1 FROM ${NOTIFIERS_TABLE} WHERE user_id = ? LIMIT 1`,
  );
  stmt.bind([userId]);
  let exists = false;
  if (stmt.step()) exists = true;
  stmt.free();
  return exists;
}

function isUserInCustomTable(
  db: import("sql.js").Database,
  permission: NotifyPermission,
  userId: string,
): boolean {
  const sql = buildPermissionSql(permission);
  const stmt = db.prepare(sql);
  stmt.bind([userId]);
  let exists = false;
  if (stmt.step()) exists = true;
  stmt.free();
  return exists;
}

export async function checkNotifyPermission(
  visitorId: string | null | undefined,
  ownerId: string,
  pageDir: string,
  permission: NotifyPermission | undefined,
): Promise<NotifyPermissionResult> {
  if (!visitorId) {
    return { status: 401, error: "Authentication required" };
  }
  if (visitorId === ownerId) {
    return { status: 200 };
  }

  const dbPath = getDbPath(pageDir);
  const db = await getConnection(dbPath);

  // Level 3：manifest.permission 配置且通过安全校验
  if (permission && validateNotifyPermissionConfig(permission)) {
    try {
      if (isUserInCustomTable(db, permission, visitorId)) {
        return { status: 200 };
      }
      return { status: 403, error: "Notifier not authorized for this app" };
    } catch (err: any) {
      // 配置错误（如表不存在）应记录并视为 500，避免静默泄漏
      return { status: 500, error: "Notify permission query failed: " + (err?.message ?? String(err)) };
    }
  }

  // Level 2：app SQLite 含 _localapp_notifiers 系统约定表
  if (tableExists(db, NOTIFIERS_TABLE)) {
    if (isUserInNotifiersTable(db, visitorId)) {
      return { status: 200 };
    }
    return { status: 403, error: "Notifier not authorized for this app" };
  }

  // Level 1 fallback：仅 owner 允许
  return { status: 403, error: "Only the app owner can send notifications" };
}
