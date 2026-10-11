import type { NotifyConfig, NotifyPermission } from "./models.cjs";

/**
 * 校验 manifest.notify 配置。
 *
 * 非法值返回 null（视为 notify 关闭，不写入 meta.json），调用方记录警告。
 * 合法值返回归一化后的 NotifyConfig。
 *
 * 校验规则：
 * - enabled 必须是 boolean
 * - permission 可选；存在时 table 必填且为 string
 * - permission.userColumn / where 可选，存在时必须为 string
 */
export function validateNotifyConfig(input: unknown): NotifyConfig | null {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.enabled !== "boolean") {
    return null;
  }

  const config: NotifyConfig = { enabled: obj.enabled };

  // Accept object or null/undefined (Rust serde serializes None as null).
  if (obj.permission !== undefined && obj.permission !== null) {
    const permission = validateNotifyPermission(obj.permission);
    if (permission === null) {
      return null;
    }
    config.permission = permission;
  }

  return config;
}

function validateNotifyPermission(input: unknown): NotifyPermission | null {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.table !== "string" || obj.table.length === 0) {
    return null;
  }

  const permission: NotifyPermission = { table: obj.table };

  // Accept string or null/undefined (Rust serde serializes None as null).
  if (obj.userColumn !== undefined && obj.userColumn !== null) {
    if (typeof obj.userColumn !== "string") {
      return null;
    }
    permission.userColumn = obj.userColumn;
  }

  if (obj.where !== undefined && obj.where !== null) {
    if (typeof obj.where !== "string") {
      return null;
    }
    permission.where = obj.where;
  }

  return permission;
}
