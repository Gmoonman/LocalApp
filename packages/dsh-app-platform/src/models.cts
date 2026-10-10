/** 访问控制级别 */
export type AccessLevel = "public" | "authenticated" | "owner" | "acl";

/** 页面级访问策略 */
export interface PageAccess {
  level: AccessLevel;
  acl?: string[];
}

/** 路由级访问策略（per-method） */
export interface RouteAccess {
  read?: AccessLevel;
  create?: AccessLevel;
  update?: AccessLevel;
  delete?: AccessLevel;
  acl?: string[];
}

/** 页面实体 */
export interface Page {
  name: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  currentVersion: number;
  currentAppVersion?: string;
  metadata: Record<string, unknown>;
  pageAccess?: PageAccess;
}

/** 页面版本 */
export interface Version {
  version: number;
  appVersion: string;
  digest: string;
  createdAt: string;
  fileCount: number;
  totalSize: number;
}

/** Schema 字段类型 */
export type FieldType = "string" | "number" | "boolean" | "timestamp" | "auto_increment";

/** 字段默认值来源（服务端在创建记录时填充） */
export type DefaultFromSource = "currentUser.id" | "currentUser.name";

/** Schema 字段约束 */
export interface FieldConstraints {
  required?: boolean;
  unique?: boolean;
  defaultValue?: unknown;
  /** 由服务端基于当前访问者填充，覆盖请求体伪造值 */
  defaultFrom?: DefaultFromSource;
  /** 字段允许值集合，校验失败返回 400 */
  enum?: unknown[];
}

/** Schema 字段定义 */
export interface SchemaField {
  type: FieldType;
  constraints?: FieldConstraints;
}

/** 记录级访问策略模式 */
export type RecordAccessMode = "ownerField" | "assigneeField" | "aclField" | "authenticated";

/**
 * 记录级访问策略：基于记录字段、当前用户和状态条件判断 read/update/delete。
 * - ownerField/assigneeField/aclField 要求 `field` 指定记录中存储访问者 ID 的字段
 * - authenticated 仅校验登录状态（页面级访问控制通常已处理）
 * - when 限制策略仅在记录的指定字段值位于允许集合时生效
 */
export interface RecordAccessPolicy {
  mode: RecordAccessMode;
  field?: string;
  when?: Record<string, unknown[]>;
}

export type RecordAccessShortcut = "owner" | "authenticated" | "any";
export type RecordAccessPolicyInput = RecordAccessPolicy | RecordAccessShortcut;

/** 记录级访问控制集合 */
export interface RecordAccess {
  read?: RecordAccessPolicyInput;
  create?: RecordAccessPolicyInput;
  update?: RecordAccessPolicyInput;
  delete?: RecordAccessPolicyInput;
}

/**
 * Transition 的 set 字段允许的服务端来源。
 * - "now" 写入当前 ISO 时间
 * - "currentUser.id" 写入当前用户 ID
 * - "currentUser.name" 写入当前用户显示名
 * 其他值按字面量写入
 */
export type TransitionSetValue = "now" | "currentUser.id" | "currentUser.name" | string | number | boolean | null;

/** 状态流转 transition 定义 */
export interface TransitionDef {
  name: string;
  label?: string;
  from: unknown[];
  to: unknown;
  access?: RecordAccessPolicyInput;
  set?: Record<string, TransitionSetValue>;
}

/** 业务模型元数据，挂在 schema 上作为业务建模契约 */
export interface BusinessMetadata {
  kind?: string;
  ownerField?: string;
  assigneeField?: string;
  aclField?: string;
  statusField?: string;
  initialStatus?: unknown;
  statuses?: unknown[];
  defaultFields?: Record<string, { defaultFrom?: DefaultFromSource; defaultValue?: unknown }>;
  enums?: Record<string, unknown[]>;
  recordAccess?: RecordAccess;
  transitions?: TransitionDef[];
}

/** 数据 Schema */
export interface DataSchema {
  name: string;
  pageName: string;
  fields: Record<string, SchemaField>;
  createdAt: string;
  updatedAt: string;
  routeAccess?: RouteAccess;
  business?: BusinessMetadata;
}

/** DB 模式 */
export type DbMode = "crud" | "sql";

/** DB 默认访问策略 */
export interface ManifestDbAccess {
  read?: AccessLevel;
  create?: AccessLevel;
  update?: AccessLevel;
  delete?: AccessLevel;
}

/** manifest.json db 配置 */
export interface ManifestDb {
  mode: DbMode;
  sqlAccess?: AccessLevel;
  dangerouslyAllowFrontendSql?: boolean;
  defaultAccess?: ManifestDbAccess;
}

/** 页面 Shell 配置 */
export interface ShellConfig {
  navbar?: boolean;
}

/** manifest.notify.permission 自定义查询配置（Level 3） */
export interface NotifyPermission {
  table: string;
  userColumn?: string;
  where?: string;
}

/** manifest.notify 配置（控制 app 通知能力开关与权限模型） */
export interface NotifyConfig {
  enabled: boolean;
  permission?: NotifyPermission;
}

/** 用户实体 */
export interface User {
  id: string;
  name: string;
  provider: string;
  role: "admin" | "user";
  createdAt: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
}
