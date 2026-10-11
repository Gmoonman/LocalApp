import type { Database } from "sql.js";
export interface SubscriptionPersistence { database(): Database; flush(): void }

export type SubscriptionLevel = "all" | "important" | "muted";

const ALLOWED_LEVELS = new Set<SubscriptionLevel>(["all", "important", "muted"]);

export interface SubscriptionRecord {
  user_id: string;
  app_owner: string;
  app_name: string;
  level: SubscriptionLevel;
  created_at: string;
}

function assertLevel(level: string): asserts level is SubscriptionLevel {
  if (!ALLOWED_LEVELS.has(level as SubscriptionLevel)) {
    throw new Error(`Invalid subscription level: ${level}. Allowed: all, important, muted`);
  }
}

export class SubscriptionStore {
  constructor(private readonly persistence: SubscriptionPersistence) {}
  /**
   * 创建或更新订阅。level 必须是 all/important/muted。
   * 同一 (user_id, app_owner, app_name) 仅保留一份，重复 upsert 等于改 level。
   */
  upsertSubscription(
    userId: string,
    appOwner: string,
    appName: string,
    level: SubscriptionLevel,
  ): void {
    assertLevel(level);
    const db = this.persistence.database();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO subscriptions (user_id, app_owner, app_name, level, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, app_owner, app_name) DO UPDATE SET level = excluded.level`,
      [userId, appOwner, appName, level, now],
    );
    this.persistence.flush();
  }

  /**
   * 退订。不存在时静默返回。
   */
  deleteSubscription(userId: string, appOwner: string, appName: string): void {
    const db = this.persistence.database();
    db.run(
      `DELETE FROM subscriptions WHERE user_id = ? AND app_owner = ? AND app_name = ?`,
      [userId, appOwner, appName],
    );
    if (db.getRowsModified() > 0) this.persistence.flush();
  }

  /**
   * 列出某 user 的全部订阅。
   */
  listSubscriptionsByUser(userId: string): SubscriptionRecord[] {
    const db = this.persistence.database();
    const stmt = db.prepare(
      `SELECT user_id, app_owner, app_name, level, created_at
       FROM subscriptions WHERE user_id = ?
       ORDER BY app_owner, app_name`,
    );
    stmt.bind([userId]);
    const rows: SubscriptionRecord[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as SubscriptionRecord);
    }
    stmt.free();
    return rows;
  }

  /**
   * 查询某 user 对某 app 的订阅状态。未订阅返回 null。
   */
  getSubscriptionStatus(
    userId: string,
    appOwner: string,
    appName: string,
  ): { level: SubscriptionLevel } | null {
    const db = this.persistence.database();
    const stmt = db.prepare(
      `SELECT level FROM subscriptions WHERE user_id = ? AND app_owner = ? AND app_name = ?`,
    );
    stmt.bind([userId, appOwner, appName]);
    let level: SubscriptionLevel | null = null;
    if (stmt.step()) {
      const row = stmt.getAsObject() as { level: SubscriptionLevel };
      level = row.level;
    }
    stmt.free();
    return level === null ? null : { level };
  }

}
