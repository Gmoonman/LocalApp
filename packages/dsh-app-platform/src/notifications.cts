import type { Database } from "sql.js";
import type { NotificationRecord, CommittedNotification } from "./notification-types.cjs";
export interface NotificationPersistence {
  database(): Database;
  flush(): void;
  commitNotificationBatch(records: NotificationRecord[]): CommittedNotification[];
  sendToUser(userId: string, message: { type: string; data: unknown }): void;
}
export type { NotificationRecord } from "./notification-types.cjs";
export type PersistedNotification = CommittedNotification;

export interface InboxItem {
  id: string;
  user_id: string;
  app_owner: string;
  app_name: string;
  title: string;
  body: string | null;
  url: string | null;
  priority: string;
  data: string | null;
  created_at: string;
  read_at: string | null;
  deleted_at: string | null;
}

export interface InboxPage {
  items: InboxItem[];
  cursor: string | null;
}

const INBOX_COLUMNS = `
  id, user_id, app_owner, app_name, title, body, url, priority, data,
  created_at, read_at, deleted_at
`;

export class NotificationStore {
  constructor(private readonly host: NotificationPersistence) {}
  /**
   * 列出某 user 已订阅 (app_owner, app_name) 的订阅关系。
   *
   * Task 13 会扩展为完整订阅 CRUD；此处仅为 notify 持久化提供读取接口。
   */
  listSubscribers(appOwner: string, appName: string): string[] {
    const db = this.host.database();
    const stmt = db.prepare(
      "SELECT user_id FROM subscriptions WHERE app_owner = ? AND app_name = ? ORDER BY user_id",
    );
    stmt.bind([appOwner, appName]);
    const userIds: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { user_id: string };
      userIds.push(row.user_id);
    }
    stmt.free();
    return userIds;
  }

  /**
   * 批量写入通知：每个 recipient 一行。
   *
   * 返回写入的 (id, userId) 列表，顺序与 recipients 一致。
   */
  persistNotifications(
    records: NotificationRecord[],
  ): PersistedNotification[] {
    const committed = this.host.commitNotificationBatch(records);
    for (const notification of committed) {
      if (!notification.eligible) continue;
      this.host.sendToUser(notification.userId, {
        type: "notify:notification",
        data: notification.delivery,
      });
    }
    return committed;
  }

  /**
   * 解析接收者列表：
   * - 若 to 字段提供：仅保留已订阅且在 to 中的 user
   * - 若 to 缺省：广播给所有订阅者
   */
  resolveRecipients(
    appOwner: string,
    appName: string,
    to: string[] | undefined,
  ): string[] {
    const subscribers = this.listSubscribers(appOwner, appName);
    if (!to || to.length === 0) return subscribers;
    const subSet = new Set(subscribers);
    return to.filter((uid) => subSet.has(uid));
  }

  /**
   * 游标分页查询某 user 的收件箱。
   *
   * - 仅返回未软删除（deleted_at IS NULL）的通知
   * - 按 created_at DESC 排序
   * - cursor 为上一页最后一条的 created_at（同 created_at 时按 id DESC 兜底）
   *
   * 返回 { items, cursor }；cursor 为 null 表示无下一页。
   */
  listInbox(
    userId: string,
    options: { limit?: number; cursor?: string; unreadOnly?: boolean } = {},
  ): InboxPage {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const db = this.host.database();

    const conditions = ["user_id = ?", "deleted_at IS NULL"];
    const params = [userId];
    if (options.unreadOnly) {
      conditions.push("read_at IS NULL");
    }
    if (options.cursor) {
      const decoded = Buffer.from(options.cursor, "base64").toString("utf-8");
      const [createdAt, id] = decoded.split("|");
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(createdAt, createdAt, id);
    }
    params.push(String(limit + 1));
    const sql = `SELECT ${INBOX_COLUMNS} FROM notifications
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY created_at DESC, id DESC LIMIT ?`;

    const stmt = db.prepare(sql);
    stmt.bind(params);
    const items: InboxItem[] = [];
    while (stmt.step()) {
      items.push(stmt.getAsObject() as unknown as InboxItem);
    }
    stmt.free();

    let nextCursor: string | null = null;
    if (items.length > limit) {
      const last = items[limit - 1];
      nextCursor = Buffer.from(`${last.created_at}|${last.id}`).toString("base64");
      items.length = limit;
    }
    return { items, cursor: nextCursor };
  }

  /**
   * 未读计数：read_at IS NULL 且 deleted_at IS NULL
   */
  getUnreadCount(userId: string): number {
    const db = this.host.database();
    const stmt = db.prepare(
      `SELECT COUNT(*) as cnt FROM notifications
       WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL`,
    );
    stmt.bind([userId]);
    let count = 0;
    if (stmt.step()) {
      count = (stmt.getAsObject() as { cnt: number }).cnt;
    }
    stmt.free();
    return count;
  }

  /**
   * 标记单条已读。返回更新后的行（含 read_at），未找到返回 null。
   */
  markRead(userId: string, notificationId: string): InboxItem | null {
    const db = this.host.database();
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `UPDATE notifications SET read_at = ?
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    );
    stmt.bind([now, notificationId, userId]);
    stmt.step();
    const changed = db.getRowsModified() > 0;
    stmt.free();

    if (changed) this.host.flush();

    return this.getInboxItem(userId, notificationId);
  }

  /**
   * 软删除。返回是否成功。
   */
  softDelete(userId: string, notificationId: string): boolean {
    const db = this.host.database();
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `UPDATE notifications SET deleted_at = ?
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    );
    stmt.bind([now, notificationId, userId]);
    stmt.step();
    const changes = db.getRowsModified();
    stmt.free();
    if (changes > 0) this.host.flush();
    return changes > 0;
  }

  /**
   * 批量标记某 user 全部未读为已读。
   */
  markAllRead(userId: string): number {
    const db = this.host.database();
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `UPDATE notifications SET read_at = ?
       WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL`,
    );
    stmt.bind([now, userId]);
    stmt.step();
    const changes = db.getRowsModified();
    stmt.free();
    if (changes > 0) this.host.flush();
    return changes;
  }

  /**
   * 内部辅助：查询单条通知（含归属校验，软删除返回 null）。
   */
  getInboxItem(userId: string, notificationId: string): InboxItem | null {
    const db = this.host.database();
    const stmt = db.prepare(
      `SELECT ${INBOX_COLUMNS} FROM notifications WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    );
    stmt.bind([notificationId, userId]);
    let item: InboxItem | null = null;
    if (stmt.step()) {
      item = stmt.getAsObject() as unknown as InboxItem;
    }
    stmt.free();
    return item;
  }

  /**
   * 列出某 user 未读通知（最多 limit 条），用于 WS 建链时推送 notify:missed。
   */
  getUnreadInboxItems(userId: string, limit: number): InboxItem[] {
    const db = this.host.database();
    const stmt = db.prepare(
      `SELECT ${INBOX_COLUMNS} FROM notifications
       WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    );
    stmt.bind([userId, String(limit)]);
    const items: InboxItem[] = [];
    while (stmt.step()) {
      items.push(stmt.getAsObject() as unknown as InboxItem);
    }
    stmt.free();
    return items;
  }

}
