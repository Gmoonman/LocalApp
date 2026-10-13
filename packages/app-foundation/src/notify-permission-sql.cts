import type { NotifyPermission } from "./models.cjs";

/**
 * 标识符白名单：字母/数字/下划线，且必须以字母或下划线开头。
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 检测 where 子句是否含 SQL 注入风险特征：
 * - 分号（语句分隔符）
 * - 行注释 `--` 或块注释 `/* ... *\/`
 * - DML/DDL 关键字（UNION/INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE）
 *
 * 仅允许基础比较运算符与字面量。
 */
const FORBIDDEN_KEYWORDS = /\b(UNION|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|ATTACH|DETACH|PRAGMA)\b/i;
const FORBIDDEN_PATTERNS = [
  /;/,                // 语句分隔符
  /--/,               // 行注释
  /\/\*/,             // 块注释起始
  /\*\//,             // 块注释结束
];

/**
 * 校验 manifest.notify.permission 配置是否安全。
 *
 * 安全要求：
 * - table 与 userColumn 必须是合规标识符
 * - where（可选）不得含分号、注释、DML/DDL 关键字
 *
 * 返回 true 表示配置可安全用于 SQL 构造；false 表示应回退到 Level 1/2。
 */
export function validateNotifyPermissionConfig(permission: NotifyPermission): boolean {
  if (typeof permission.table !== "string" || !SAFE_IDENTIFIER.test(permission.table)) {
    return false;
  }
  if (permission.userColumn !== undefined && permission.userColumn !== null) {
    if (typeof permission.userColumn !== "string" || !SAFE_IDENTIFIER.test(permission.userColumn)) {
      return false;
    }
  }
  if (permission.where !== undefined && permission.where !== null) {
    if (typeof permission.where !== "string") return false;
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(permission.where)) return false;
    }
    if (FORBIDDEN_KEYWORDS.test(permission.where)) return false;
  }
  return true;
}

/**
 * 构造 Level 3 权限校验 SQL。
 *
 * 调用方必须先用 validateNotifyPermissionConfig 校验配置；本函数不做安全检查。
 *
 * 模板：`SELECT 1 FROM {table} WHERE {userColumn} = ? [AND ({where})] LIMIT 1`
 * 绑定参数：[userId]
 */
export function buildPermissionSql(permission: NotifyPermission): string {
  const userColumn = permission.userColumn ?? "user_id";
  let sql = `SELECT 1 FROM ${permission.table} WHERE ${userColumn} = ?`;
  if (permission.where) {
    sql += ` AND (${permission.where})`;
  }
  sql += " LIMIT 1";
  return sql;
}
