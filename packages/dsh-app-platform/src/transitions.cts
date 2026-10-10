import type {
  BusinessMetadata,
  DataSchema,
  TransitionDef,
  RecordAccessPolicyInput,
} from "./models.cjs";
import type { VisitorContext } from "./record-access.cjs";
import { checkRecordPolicy } from "./record-access.cjs";

/**
 * 校验业务元数据中的 transitions 定义。
 * 返回非空字符串表示校验失败（用于 400 响应）。
 *
 * 校验项：
 * - statusField 必须存在于 schema 字段中
 * - 每个 transition 必须有 name 和 to
 * - transition.name 必须唯一
 */
export function validateTransitions(
  fields: Record<string, unknown>,
  business: BusinessMetadata | undefined,
): string | null {
  if (!business) return null;
  if (!Array.isArray(business.transitions) || business.transitions.length === 0) return null;

  if (!business.statusField) {
    return "business.statusField is required when transitions are declared";
  }
  if (!(business.statusField in fields)) {
    return `business.statusField '${business.statusField}' does not exist in schema fields`;
  }

  const seen = new Set<string>();
  for (const t of business.transitions) {
    if (!t.name || typeof t.name !== "string") {
      return "transition.name is required and must be a string";
    }
    if (seen.has(t.name)) {
      return `transition name '${t.name}' is duplicated`;
    }
    seen.add(t.name);
    if (t.to === undefined || t.to === null || t.to === "") {
      return `transition '${t.name}' is missing 'to' field`;
    }
    if (!Array.isArray(t.from)) {
      return `transition '${t.name}' is missing or has invalid 'from' (must be array)`;
    }
  }
  return null;
}

/**
 * 计算当前记录可执行的 transition 列表。
 * 一个 transition 可执行当且仅当：
 * - 记录当前状态在 transition.from 集合中
 * - 当前访问者满足 transition.access 策略（页面所有者始终通过）
 */
export function listAvailableTransitions(
  schema: DataSchema,
  record: Record<string, unknown>,
  visitor: VisitorContext,
  ownerId: string,
): Array<TransitionDef & { label?: string }> {
  const transitions = schema.business?.transitions;
  if (!transitions || transitions.length === 0) return [];

  const statusField = schema.business?.statusField;
  if (!statusField) return [];

  const currentStatus = record[statusField];
  const result: Array<TransitionDef & { label?: string }> = [];

  for (const t of transitions) {
    if (!Array.isArray(t.from)) continue;
    if (!t.from.includes(currentStatus)) continue;
    if (!canExecuteTransition(t, record, visitor, ownerId, schema.business)) continue;
    result.push(t);
  }
  return result;
}

/**
 * 判断当前访问者能否执行指定 transition。
 * - transition 无 access 策略：默认要求登录
 * - 否则按策略语义判断（复用 checkRecordPolicy）
 */
export function canExecuteTransition(
  transition: TransitionDef,
  record: Record<string, unknown>,
  visitor: VisitorContext,
  ownerId: string,
  business?: BusinessMetadata,
): boolean {
  const policy: RecordAccessPolicyInput = transition.access ?? { mode: "authenticated" };
  return checkRecordPolicy(policy, record, visitor, ownerId, business);
}

/**
 * 根据 transition 的 from/to 和 set 规则计算写入字段。
 * 调用前应已确认 currentStatus ∈ transition.from。
 *
 * - 写入 statusField = transition.to
 * - 遍历 transition.set：
 *   - "now" → 当前 ISO 时间
 *   - "currentUser.id" → visitor.id（visitor 必须登录）
 *   - "currentUser.name" → visitor.name ?? visitor.id
 *   - 其他字面量按原值写入
 *
 * 返回 { ok: true, data } 或 { ok: false, statusCode, error }。
 */
export function computeTransitionWrites(
  schema: DataSchema,
  transition: TransitionDef,
  visitor: VisitorContext,
  payload: Record<string, unknown> | undefined,
  options?: { now?: () => string },
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; statusCode: number; error: string } {
  const statusField = schema.business?.statusField;
  const writes: Record<string, unknown> = { ...(payload ?? {}) };

  if (statusField) {
    writes[statusField] = transition.to;
  }

  if (transition.set) {
    for (const [key, src] of Object.entries(transition.set)) {
      if (src === "now") {
        writes[key] = options?.now ? options.now() : new Date().toISOString();
      } else if (src === "currentUser.id") {
        if (visitor.id === null) {
          return {
            ok: false,
            statusCode: 401,
            error: `Authentication required: transition '${transition.name}' writes current user to '${key}'`,
          };
        }
        writes[key] = visitor.id;
      } else if (src === "currentUser.name") {
        if (visitor.id === null) {
          return {
            ok: false,
            statusCode: 401,
            error: `Authentication required: transition '${transition.name}' writes current user to '${key}'`,
          };
        }
        writes[key] = visitor.name ?? visitor.id;
      } else {
        writes[key] = src;
      }
    }
  }

  return { ok: true, data: writes };
}

/**
 * 在 schema 中按名称查找 transition。返回 undefined 表示不存在。
 */
export function findTransition(
  schema: DataSchema,
  name: string,
): TransitionDef | undefined {
  const transitions = schema.business?.transitions;
  if (!transitions) return undefined;
  return transitions.find((t) => t.name === name);
}
