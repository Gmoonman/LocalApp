import { randomBytes } from "node:crypto";
import type { Database, Statement } from "sql.js";
import { shouldPushToSubscriber, type NotifyPriority } from "./notify-routing.cjs";
import { validateRelativeUrl } from "./notify-payload.cjs";
import type { SubscriptionLevel } from "./subscriptions.cjs";

import type { NotificationRecord, DeliveryNotification, CommittedNotification } from "./notification-types.cjs";
export type { NotificationRecord, DeliveryNotification, CommittedNotification } from "./notification-types.cjs";

export interface DeliveryPage {
  items: DeliveryNotification[];
  nextSequence: number;
  snapshotHighWater: number;
  hasMore: boolean;
  omittedCount: number;
}

export interface ListDeliveryOptions {
  afterSequence: number;
  limit: number;
  since?: string;
}

interface DeliveryRow {
  id: string;
  user_id: string;
  app_owner: string;
  app_name: string;
  title: string;
  body: string | null;
  url: string | null;
  priority: string;
  created_at: string;
  delivery_seq: number;
  delivery_eligible: number;
}

interface PreparedNotificationRecord {
  userId: string;
  appOwner: string;
  appName: string;
  title: string;
  body: string | null;
  url: string | null;
  priority: NotifyPriority;
  data: string | null;
}

const DELIVERY_SELECT = `
  id, user_id, app_owner, app_name, title, body, url, priority, created_at,
  delivery_seq, delivery_eligible
`;

export interface NotificationDeliveryPersistence { database(): Database; flush(): void }
export const MAX_NOTIFICATION_DELIVERY_SEQUENCE = Number.MAX_SAFE_INTEGER;
export class NotificationDeliveryStore {
  private notificationCommitInProgress = false;
  constructor(private readonly persistence: NotificationDeliveryPersistence) {}
  getNotificationDeliveryHighWater(): number {
    const statement = this.persistence.database().prepare(
      "SELECT high_water FROM notification_delivery_state WHERE singleton = 1",
    );
    if (!statement.step()) {
      statement.free();
      throw new Error("Notification delivery state is missing");
    }
    const highWater = Number((statement.getAsObject() as { high_water: number }).high_water);
    statement.free();
    if (!Number.isSafeInteger(highWater) || highWater < 0) {
      throw new Error("Notification delivery high-water is invalid");
    }
    return highWater;
  }

  commitNotificationBatch(records: readonly NotificationRecord[]): CommittedNotification[] {
    if (records.length === 0) return [];
    if (this.notificationCommitInProgress) {
      throw new Error("Notification delivery commit is already in progress");
    }

    const prepared = records.map((record, originalIndex) => ({
      ...this.validateRecord(record),
      originalIndex,
    })).sort((left, right) => {
      if (left.userId < right.userId) return -1;
      if (left.userId > right.userId) return 1;
      return left.originalIndex - right.originalIndex;
    });
    const db = this.persistence.database();
    const now = new Date().toISOString();
    const inserted: Array<{ id: string; userId: string }> = [];
    let previousHighWater = 0;
    let committed = false;

    this.notificationCommitInProgress = true;
    try {
      db.run("BEGIN IMMEDIATE");
      try {
        previousHighWater = this.readHighWaterInTransaction();
        if (prepared.length > MAX_NOTIFICATION_DELIVERY_SEQUENCE - previousHighWater) {
          throw new RangeError("Notification delivery sequence safe-integer range is exhausted");
        }

        const subscription = db.prepare(
          `SELECT level FROM subscriptions
           WHERE user_id = ? AND app_owner = ? AND app_name = ?`,
        );
        const insert = db.prepare(`
          INSERT INTO notifications
            (id, user_id, app_owner, app_name, title, body, url, priority, data,
             created_at, delivery_seq, delivery_eligible)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        try {
          for (let index = 0; index < prepared.length; index++) {
            const record = prepared[index];
            const sequence = previousHighWater + index + 1;
            const level = this.readSubscriptionLevel(
              subscription,
              record.userId,
              record.appOwner,
              record.appName,
            );
            const eligible = shouldPushToSubscriber(level, record.priority);
            const id = randomBytes(16).toString("hex");
            insert.run([
              id,
              record.userId,
              record.appOwner,
              record.appName,
              record.title,
              record.body,
              record.url,
              record.priority,
              record.data,
              now,
              sequence,
              eligible ? 1 : 0,
            ]);
            inserted.push({ id, userId: record.userId });
          }
        } finally {
          subscription.free();
          insert.free();
        }

        db.run(
          "UPDATE notification_delivery_state SET high_water = ? WHERE singleton = 1",
          [previousHighWater + prepared.length],
        );
        if (db.getRowsModified() !== 1) throw new Error("Notification delivery state disappeared");
        db.run("COMMIT");
        committed = true;
      } catch (error) {
        if (!committed) {
          try { db.run("ROLLBACK"); } catch { /* preserve the original transactional error */ }
        }
        throw error;
      }

      this.persistence.flush();
      return this.readCommittedRows(
        inserted,
        previousHighWater + 1,
        previousHighWater + prepared.length,
      );
    } finally {
      this.notificationCommitInProgress = false;
    }
  }

  listDeliverableNotifications(
    userId: string,
    options: ListDeliveryOptions,
  ): DeliveryPage {
    this.assertDeliveryOptions(options);
    const db = this.persistence.database();
    const snapshotHighWater = this.getNotificationDeliveryHighWater();
    const conditions = [
      "user_id = ?",
      "deleted_at IS NULL",
      "delivery_eligible = 1",
      "delivery_seq > ?",
      "delivery_seq <= ?",
    ];
    const parameters: Array<string | number> = [
      userId,
      options.afterSequence,
      snapshotHighWater,
    ];
    if (options.since !== undefined) {
      conditions.push("created_at >= ?");
      parameters.push(options.since);
    }

    const statement = db.prepare(`
      SELECT ${DELIVERY_SELECT}
      FROM notifications
      WHERE ${conditions.join(" AND ")}
      ORDER BY delivery_seq ASC
      LIMIT ?
    `);
    statement.bind([...parameters, options.limit]);
    const rows: DeliveryRow[] = [];
    while (statement.step()) rows.push(statement.getAsObject() as unknown as DeliveryRow);
    statement.free();

    if (rows.length === 0) {
      return {
        items: [],
        nextSequence: Math.max(options.afterSequence, snapshotHighWater),
        snapshotHighWater,
        hasMore: false,
        omittedCount: 0,
      };
    }

    const nextSequence = rows[rows.length - 1].delivery_seq;
    const omittedConditions = [...conditions, "delivery_seq > ?"];
    const omitted = db.prepare(`
      SELECT COUNT(*) AS count
      FROM notifications
      WHERE ${omittedConditions.join(" AND ")}
    `);
    omitted.bind([...parameters, nextSequence]);
    if (!omitted.step()) {
      omitted.free();
      throw new Error("Notification delivery omitted-count query failed");
    }
    const omittedCount = Number((omitted.getAsObject() as { count: number }).count);
    omitted.free();

    return {
      items: rows.map(this.serializeDeliveryRow),
      nextSequence,
      snapshotHighWater,
      hasMore: omittedCount > 0,
      omittedCount,
    };
  }

  private validateRecord(record: NotificationRecord): PreparedNotificationRecord {
    if (!record || typeof record !== "object") throw new TypeError("Notification record is required");
    for (const [name, value] of [
      ["userId", record.userId],
      ["appOwner", record.appOwner],
      ["appName", record.appName],
      ["title", record.title],
    ] as const) {
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`Notification ${name} must be a non-empty string`);
      }
    }
    if (record.body !== undefined && typeof record.body !== "string") {
      throw new TypeError("Notification body must be a string");
    }
    if (record.url !== undefined && !validateRelativeUrl(record.url)) {
      throw new TypeError("Notification URL must be a safe same-origin relative path");
    }
    if (record.priority !== "normal" && record.priority !== "high") {
      throw new TypeError("Notification priority must be normal or high");
    }
    let data: string | null = null;
    if (record.data !== undefined) {
      data = JSON.stringify(record.data);
      if (data === undefined) throw new TypeError("Notification data must be JSON serializable");
    }
    return {
      userId: record.userId,
      appOwner: record.appOwner,
      appName: record.appName,
      title: record.title,
      body: record.body ?? null,
      url: record.url ?? null,
      priority: record.priority,
      data,
    };
  }

  private readHighWaterInTransaction(): number {
    return this.getNotificationDeliveryHighWater();
  }

  private readSubscriptionLevel(
    statement: Statement,
    userId: string,
    appOwner: string,
    appName: string,
  ): SubscriptionLevel {
    statement.reset();
    statement.bind([userId, appOwner, appName]);
    if (!statement.step()) return "all";
    const level = String((statement.getAsObject() as { level: string }).level);
    return level === "all" || level === "important" || level === "muted" ? level : "muted";
  }

  private readCommittedRows(
    inserted: Array<{ id: string; userId: string }>,
    firstSequence: number,
    lastSequence: number,
  ): CommittedNotification[] {
    const byId = new Map(inserted.map((row) => [row.id, row.userId]));
    const statement = this.persistence.database().prepare(`
      SELECT ${DELIVERY_SELECT}
      FROM notifications
      WHERE delivery_seq BETWEEN ? AND ?
      ORDER BY delivery_seq ASC
    `);
    statement.bind([firstSequence, lastSequence]);
    const committed: CommittedNotification[] = [];
    while (statement.step()) {
      const row = statement.getAsObject() as unknown as DeliveryRow;
      const userId = byId.get(row.id);
      if (!userId) {
        statement.free();
        throw new Error("Committed notification read-back returned an unknown row");
      }
      committed.push({
        id: row.id,
        userId,
        sequence: row.delivery_seq,
        eligible: row.delivery_eligible === 1,
        delivery: this.serializeDeliveryRow(row),
      });
    }
    statement.free();
    if (committed.length !== inserted.length) {
      throw new Error("Committed notification read-back was incomplete");
    }
    return committed;
  }

  private serializeDeliveryRow(row: DeliveryRow): DeliveryNotification {
    const priority: NotifyPriority = row.priority === "high" ? "high" : "normal";
    return {
      id: row.id,
      sequence: Number(row.delivery_seq),
      app_owner: row.app_owner,
      app_name: row.app_name,
      title: row.title,
      body: row.body,
      url: row.url !== null && validateRelativeUrl(row.url) ? row.url : null,
      priority,
      created_at: row.created_at,
    };
  }

  private assertDeliveryOptions(options: ListDeliveryOptions): void {
    if (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0) {
      throw new RangeError("afterSequence must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new RangeError("limit must be between 1 and 100");
    }
    if (options.since !== undefined) {
      const parsed = new Date(options.since);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== options.since) {
        throw new RangeError("since must be a canonical UTC timestamp");
      }
    }
  }
}
