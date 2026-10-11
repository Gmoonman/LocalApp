import type { SubscriptionLevel } from "./subscriptions.cjs";

export type NotifyPriority = "normal" | "high";

/**
 * 等级 × 优先级路由矩阵：
 *
 * | level      | normal | high |
 * |------------|--------|------|
 * | all        | 推送   | 推送 |
 * | important  | 不推送 | 推送 |
 * | muted      | 不推送 | 不推送 |
 *
 * 推送与否仅影响 WS 实时推送；入库（写 inbox）始终发生，
 * 用户可主动通过收件箱页面查看所有订阅通知。
 *
 * 设计原则：用户主权优先于发布者紧急程度——
 * muted 即使 high 也不应突破。
 */
export function shouldPushToSubscriber(level: SubscriptionLevel, priority: NotifyPriority): boolean {
  switch (level) {
    case "all":
      return true;
    case "important":
      return priority === "high";
    case "muted":
      return false;
    default:
      return false;
  }
}
