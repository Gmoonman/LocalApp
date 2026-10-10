import type {
  BusinessMetadata,
  RecordAccessPolicy,
  RecordAccessPolicyInput,
  RecordAccess,
} from "./models.cjs";

export type RecordAction = "read" | "create" | "update" | "delete";

export interface VisitorContext {
  id: string | null;
  name: string | null;
}

export function normalizeRecordAccessPolicy(
  policy: RecordAccessPolicyInput | undefined,
  business?: Pick<BusinessMetadata, "ownerField">,
): RecordAccessPolicy | undefined {
  if (!policy) return undefined;
  if (typeof policy !== "string") return policy;

  if (policy === "any") return undefined;
  if (policy === "authenticated") return { mode: "authenticated" };
  if (policy === "owner") {
    return { mode: "ownerField", field: business?.ownerField ?? "created_by" };
  }
  return undefined;
}

/**
 * 判断单条记录是否满足访问策略。
 * - 未声明 policy 时一律放行
 * - 页面所有者（visitor.id === ownerId）始终放行，除非显式声明更严格策略
 * - mode=authenticated 仅校验登录状态
 * - mode=ownerField/assigneeField/aclField 要求 record[field] 等于 visitor.id
 * - when 中的字段值必须在允许集合内
 */
export function checkRecordPolicy(
  policy: RecordAccessPolicyInput | undefined,
  record: Record<string, unknown>,
  visitor: VisitorContext,
  ownerId: string,
  business?: Pick<BusinessMetadata, "ownerField">,
): boolean {
  const normalizedPolicy = normalizeRecordAccessPolicy(policy, business);
  if (!normalizedPolicy) return true;
  if (visitor.id !== null && visitor.id === ownerId) return true;

  if (normalizedPolicy.mode === "authenticated") {
    return visitor.id !== null;
  }

  const field = normalizedPolicy.field;
  if (!field) return true;

  if (visitor.id === null) return false;
  const recordValue = record[field];
  if (recordValue === undefined || recordValue === null) return false;
  if (String(recordValue) !== String(visitor.id)) return false;

  if (normalizedPolicy.when) {
    for (const [key, allowed] of Object.entries(normalizedPolicy.when)) {
      if (!Array.isArray(allowed)) continue;
      if (!allowed.includes(record[key])) return false;
    }
  }
  return true;
}

/**
 * 把列表 read 策略翻译为追加到 filters 的字段。
 * 返回 null 表示不需要追加过滤（页面所有者、未声明 read 策略、authenticated mode 等）。
 * 返回 'deny-empty' 表示该 visitor 无法看到任何记录（匿名但策略要求 ownerField）。
 * 返回对象表示追加的过滤字段。
 */
export type RecordReadFilterResult =
  | { kind: "none" }
  | { kind: "empty" }
  | { kind: "filter"; field: string; value: string };

export function buildRecordReadFilter(
  policy: RecordAccessPolicyInput | undefined,
  visitor: VisitorContext,
  ownerId: string,
  business?: Pick<BusinessMetadata, "ownerField">,
): RecordReadFilterResult {
  const normalizedPolicy = normalizeRecordAccessPolicy(policy, business);
  if (!normalizedPolicy) return { kind: "none" };
  if (visitor.id !== null && visitor.id === ownerId) return { kind: "none" };

  if (normalizedPolicy.mode === "authenticated") {
    if (visitor.id === null) return { kind: "empty" };
    return { kind: "none" };
  }

  const field = normalizedPolicy.field;
  if (!field) return { kind: "none" };
  if (visitor.id === null) return { kind: "empty" };
  return { kind: "filter", field, value: visitor.id };
}

export function pickRecordPolicy(
  recordAccess: RecordAccess | undefined,
  action: RecordAction,
  business?: Pick<BusinessMetadata, "ownerField">,
): RecordAccessPolicy | undefined {
  if (!recordAccess) return undefined;
  return normalizeRecordAccessPolicy(recordAccess[action], business);
}
