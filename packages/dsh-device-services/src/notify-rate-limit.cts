/**
 * 滑动窗口速率限制器。
 *
 * 每个 key（如 app 标识）维护一份时间戳列表；每次 check 时淘汰窗口外的旧记录，
 * 然后判断在剩余窗口内是否还有容量。返回是否允许，以及需等待多少秒后重试。
 *
 * 设计：内存 Map + 滑动窗口。适用于单实例 server。多实例场景需替换为 Redis 等共享存储。
 */
export interface RateLimitConfig {
  minuteLimit: number;
  hourLimit: number;
  /** 注入时钟，便于测试 */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 仅在 allowed=false 时有意义：建议重试等待秒数 */
  retryAfterSec: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export class SlidingWindowRateLimiter {
  private minuteLimit: number;
  private hourLimit: number;
  private now: () => number;
  /** 每个 key 维护一份时间戳数组（按时间升序） */
  private hits = new Map<string, number[]>();

  constructor(config: RateLimitConfig) {
    this.minuteLimit = config.minuteLimit;
    this.hourLimit = config.hourLimit;
    this.now = config.now ?? (() => Date.now());
  }

  /**
   * 检查并消费一次配额（成功时记录当前时间戳）。
   */
  check(key: string): RateLimitResult {
    const now = this.now();
    const timestamps = this.hits.get(key) ?? [];

    // 淘汰 1 小时外的旧记录
    const hourCutoff = now - HOUR_MS;
    const recent = timestamps.filter((t) => t > hourCutoff);

    // 小时窗口检查
    if (recent.length >= this.hourLimit) {
      const oldest = recent[0];
      const retryAfterSec = Math.ceil((oldest + HOUR_MS - now) / 1000);
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSec };
    }

    // 分钟窗口检查
    const minuteCutoff = now - MINUTE_MS;
    const inMinute = recent.filter((t) => t > minuteCutoff);
    if (inMinute.length >= this.minuteLimit) {
      const oldest = inMinute[0];
      const retryAfterSec = Math.ceil((oldest + MINUTE_MS - now) / 1000);
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSec };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSec: 0 };
  }

  /**
   * 重置某 key 的计数（用于测试或权限变更后清理）。
   */
  reset(key: string): void {
    this.hits.delete(key);
  }
}

let globalLimiter: SlidingWindowRateLimiter | null = null;

/**
 * 进程级单例：默认 100/hr + 10/min。
 * 业务代码通过此函数访问，便于在测试中替换。
 */
export function getNotifyRateLimiter(): SlidingWindowRateLimiter {
  if (!globalLimiter) {
    globalLimiter = new SlidingWindowRateLimiter({ minuteLimit: 10, hourLimit: 100 });
  }
  return globalLimiter;
}

/** 测试用：替换全局 limiter */
export function setNotifyRateLimiter(limiter: SlidingWindowRateLimiter | null): void {
  globalLimiter = limiter;
}
