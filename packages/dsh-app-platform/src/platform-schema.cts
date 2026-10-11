import type { Database as SqlJsDatabase } from "sql.js";
import { initializeAnalyticsSchema } from "./analytics.cjs";
export const MAX_NOTIFICATION_DELIVERY_SEQUENCE = Number.MAX_SAFE_INTEGER;

function migrateNotificationDeliverySchema(database: SqlJsDatabase): void {
  const columns = new Set(
    (database.exec("PRAGMA table_info(notifications)")[0]?.values ?? []).map((row) => String(row[1])),
  );
  if (!columns.has("delivery_seq")) {
    database.run(`
      ALTER TABLE notifications ADD COLUMN delivery_seq INTEGER CHECK (
        delivery_seq IS NULL OR
        (delivery_seq > 0 AND delivery_seq <= ${MAX_NOTIFICATION_DELIVERY_SEQUENCE})
      )
    `);
  }
  if (!columns.has("delivery_eligible")) {
    database.run(`
      ALTER TABLE notifications ADD COLUMN delivery_eligible INTEGER CHECK (
        delivery_eligible IS NULL OR delivery_eligible IN (0, 1)
      )
    `);
  }

  database.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_delivery_seq
    ON notifications(delivery_seq)
    WHERE delivery_seq IS NOT NULL
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_notifications_user_delivery
    ON notifications(user_id, delivery_eligible, delivery_seq)
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS notification_delivery_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      high_water INTEGER NOT NULL CHECK (
        high_water >= 0 AND high_water <= ${MAX_NOTIFICATION_DELIVERY_SEQUENCE}
      )
    )
  `);

  const stateRows = database.exec(
    "SELECT singleton, high_water FROM notification_delivery_state ORDER BY singleton",
  )[0]?.values ?? [];
  if (stateRows.length === 0) {
    const assigned = database.exec(`
      SELECT 1 FROM notifications
      WHERE delivery_seq IS NOT NULL OR delivery_eligible IS NOT NULL
      LIMIT 1
    `)[0]?.values.length ?? 0;
    if (assigned > 0) {
      throw new Error("Notification delivery state is missing for a partial migration with assigned rows");
    }
    database.run("INSERT INTO notification_delivery_state (singleton, high_water) VALUES (1, 0)");
    return;
  }

  if (stateRows.length !== 1 || Number(stateRows[0][0]) !== 1) {
    throw new Error("Notification delivery state must contain exactly the singleton row");
  }
  const highWater = Number(stateRows[0][1]);
  if (!Number.isSafeInteger(highWater) || highWater < 0) {
    throw new Error("Notification delivery high-water is not a non-negative safe integer");
  }
  const invalidRow = database.exec(`
    SELECT 1 FROM notifications
    WHERE
      (delivery_seq IS NULL AND delivery_eligible IS NOT NULL)
      OR (delivery_seq IS NOT NULL AND delivery_eligible IS NULL)
      OR (delivery_seq IS NOT NULL AND (
        typeof(delivery_seq) != 'integer'
        OR delivery_seq <= 0
        OR delivery_seq > ${MAX_NOTIFICATION_DELIVERY_SEQUENCE}
        OR delivery_seq > ${highWater}
      ))
      OR (delivery_eligible IS NOT NULL AND delivery_eligible NOT IN (0, 1))
    LIMIT 1
  `)[0]?.values.length ?? 0;
  if (invalidRow > 0) {
    throw new Error("Notification delivery rows are inconsistent with the durable high-water");
  }
}

export function initializePlatformSchema(db: SqlJsDatabase, initializeAccounts: (database: SqlJsDatabase) => void): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      base_url TEXT NOT NULL,
      credential TEXT NOT NULL,
      accept_insecure_http INTEGER NOT NULL DEFAULT 0,
      connection_version INTEGER NOT NULL DEFAULT 1,
      verified_user_id TEXT,
      verified_user_name TEXT,
      verified_user_display_name TEXT,
      protocol_version INTEGER,
      transfer_limits TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  {
    const columns = db.prepare("PRAGMA table_info(peers)");
    const names: string[] = [];
    while (columns.step()) names.push(String((columns.getAsObject() as { name: string }).name));
    columns.free();
    if (!names.includes("connection_version")) db.run("ALTER TABLE peers ADD COLUMN connection_version INTEGER NOT NULL DEFAULT 1");
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS device_notification_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL CHECK (generation >= 0 AND generation <= ${Number.MAX_SAFE_INTEGER}),
      quiet_hours_start TEXT,
      quiet_hours_end TEXT,
      quiet_hours_timezone TEXT,
      preview TEXT NOT NULL DEFAULT 'full' CHECK (preview IN ('full', 'hidden')),
      native_permission TEXT NOT NULL DEFAULT 'unknown' CHECK (native_permission IN ('not-determined', 'granted', 'denied', 'unsupported', 'unknown')),
      daemon_version TEXT,
      adapter_version TEXT,
      native_updated_at TEXT
    )
  `);
  {
    const columns = db.prepare("PRAGMA table_info(device_notification_state)");
    const names: string[] = [];
    while (columns.step()) names.push(String((columns.getAsObject() as { name: string }).name));
    columns.free();
    if (!names.includes("generation")) db.run(`ALTER TABLE device_notification_state ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= ${Number.MAX_SAFE_INTEGER})`);
    if (!names.includes("quiet_hours_start")) db.run("ALTER TABLE device_notification_state ADD COLUMN quiet_hours_start TEXT");
    if (!names.includes("quiet_hours_end")) db.run("ALTER TABLE device_notification_state ADD COLUMN quiet_hours_end TEXT");
    if (!names.includes("quiet_hours_timezone")) db.run("ALTER TABLE device_notification_state ADD COLUMN quiet_hours_timezone TEXT");
    if (!names.includes("preview")) db.run("ALTER TABLE device_notification_state ADD COLUMN preview TEXT NOT NULL DEFAULT 'full'");
    if (!names.includes("native_permission")) db.run("ALTER TABLE device_notification_state ADD COLUMN native_permission TEXT NOT NULL DEFAULT 'unknown'");
    if (!names.includes("daemon_version")) db.run("ALTER TABLE device_notification_state ADD COLUMN daemon_version TEXT");
    if (!names.includes("adapter_version")) db.run("ALTER TABLE device_notification_state ADD COLUMN adapter_version TEXT");
    if (!names.includes("native_updated_at")) db.run("ALTER TABLE device_notification_state ADD COLUMN native_updated_at TEXT");
  }
  db.run("INSERT OR IGNORE INTO device_notification_state (singleton, generation) VALUES (1, 0)");
  db.run(`
    CREATE TABLE IF NOT EXISTS device_notification_sources (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('local', 'peer')),
      target_user_id TEXT NOT NULL,
      peer_id TEXT,
      peer_connection_version INTEGER,
      source_origin TEXT NOT NULL,
      source_label TEXT NOT NULL CHECK (length(source_label) BETWEEN 1 AND 80),
      account_label TEXT NOT NULL CHECK (length(account_label) BETWEEN 1 AND 80),
      desired_enabled INTEGER NOT NULL CHECK (desired_enabled IN (0, 1)),
      encrypted_credential TEXT,
      revocation_key TEXT,
      config_generation INTEGER NOT NULL CHECK (config_generation > 0),
      status_generation INTEGER,
      status_state TEXT NOT NULL CHECK (status_state IN ('disabled', 'pending', 'connecting', 'connected', 'error')),
      status_cursor INTEGER CHECK (status_cursor IS NULL OR (status_cursor >= 0 AND status_cursor <= ${Number.MAX_SAFE_INTEGER})),
      status_last_event_at TEXT,
      status_error_code TEXT,
      status_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (kind = 'local' AND peer_id IS NULL AND peer_connection_version IS NULL)
        OR (kind = 'peer' AND peer_id IS NOT NULL AND peer_connection_version IS NOT NULL)
      )
    )
  `);
  db.run("DROP INDEX IF EXISTS idx_device_notification_source_singleton");
  db.run(`
    DELETE FROM device_notification_sources AS duplicate
    WHERE EXISTS (
      SELECT 1 FROM device_notification_sources AS canonical
      WHERE canonical.owner_user_id = duplicate.owner_user_id
        AND canonical.kind = duplicate.kind
        AND canonical.target_user_id = duplicate.target_user_id
        AND (
          canonical.desired_enabled > duplicate.desired_enabled
          OR (canonical.desired_enabled = duplicate.desired_enabled AND canonical.created_at < duplicate.created_at)
          OR (canonical.desired_enabled = duplicate.desired_enabled AND canonical.created_at = duplicate.created_at AND canonical.id < duplicate.id)
        )
    )
  `);
  if (db.getRowsModified() > 0) {
    db.run("UPDATE device_notification_state SET generation = generation + 1 WHERE singleton = 1");
  }
  db.run(`
    CREATE UNIQUE INDEX idx_device_notification_source_singleton
    ON device_notification_sources(owner_user_id, kind, target_user_id)
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_device_notification_sources_owner ON device_notification_sources(owner_user_id, created_at, id)");
  db.run(`
    CREATE TABLE IF NOT EXISTS device_notification_test_commands (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'completed')),
      result TEXT CHECK (result IS NULL OR result IN ('shown', 'denied', 'unsupported', 'failed')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_device_notification_test_pending ON device_notification_test_commands(state, created_at, id)");

  initializeAnalyticsSchema(db);

  db.run(`
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      page_path TEXT NOT NULL,
      page_name TEXT,
      owner_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, page_path)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT NOT NULL,
      app_owner TEXT NOT NULL,
      app_name TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, app_owner, app_name)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      app_owner TEXT NOT NULL,
      app_name TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      url TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      deleted_at TEXT,
      delivery_seq INTEGER CHECK (
        delivery_seq IS NULL OR
        (delivery_seq > 0 AND delivery_seq <= ${MAX_NOTIFICATION_DELIVERY_SEQUENCE})
      ),
      delivery_eligible INTEGER CHECK (
        delivery_eligible IS NULL OR delivery_eligible IN (0, 1)
      )
    )
  `);
  migrateNotificationDeliverySchema(db);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_app ON notifications(app_owner, app_name)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS saved_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, title)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_saved_replies_user ON saved_replies(user_id, updated_at DESC, id DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS desktop_actions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      server_origin TEXT NOT NULL,
      app_owner TEXT NOT NULL,
      app_name TEXT NOT NULL,
      app_version TEXT,
      publisher_user_id TEXT NOT NULL,
      publisher_display_name TEXT,
      title TEXT NOT NULL,
      description TEXT,
      script TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      input_json TEXT NOT NULL,
      timeout_seconds INTEGER NOT NULL,
      nonce TEXT NOT NULL,
      installation_id TEXT,
      status TEXT NOT NULL,
      result_json TEXT,
      error_message TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT
    )
  `);
  const desktopActionColumns = new Set(
    (db.exec("PRAGMA table_info(desktop_actions)")[0]?.values ?? []).map((row) => String(row[1])),
  );
  if (!desktopActionColumns.has("permissions_json")) {
    db.run("ALTER TABLE desktop_actions ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!desktopActionColumns.has("permissions_digest")) {
    db.run("ALTER TABLE desktop_actions ADD COLUMN permissions_digest TEXT NOT NULL DEFAULT ''");
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_desktop_actions_user_pending ON desktop_actions(user_id, status, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_desktop_actions_expiry ON desktop_actions(status, expires_at)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      sync_id TEXT NOT NULL,
      with_data INTEGER NOT NULL DEFAULT 0,
      app_version TEXT,
      package_digest TEXT,
      package_size INTEGER,
      status TEXT NOT NULL,
      history_json TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  const syncJobColumns = db.exec("PRAGMA table_info(sync_jobs)")[0]?.values.map((row) => String(row[1])) ?? [];
  if (!syncJobColumns.includes("data_digest")) db.run("ALTER TABLE sync_jobs ADD COLUMN data_digest TEXT");
  if (!syncJobColumns.includes("data_size")) db.run("ALTER TABLE sync_jobs ADD COLUMN data_size INTEGER");
  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_jobs_owner ON sync_jobs(owner_id, created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs(status)`);

  initializeAccounts(db);

  db.run("DROP TRIGGER IF EXISTS invalidate_device_notification_peer_update");
  db.run(`
    CREATE TRIGGER invalidate_device_notification_peer_update
    AFTER UPDATE OF base_url, credential, accept_insecure_http, connection_version, verified_user_id, verified_user_name, verified_at ON peers
    WHEN EXISTS (
      SELECT 1 FROM device_notification_sources
      WHERE peer_id = OLD.id AND desired_enabled = 1
        AND (
          OLD.base_url IS NOT NEW.base_url
          OR OLD.credential IS NOT NEW.credential
          OR OLD.accept_insecure_http IS NOT NEW.accept_insecure_http
          OR OLD.connection_version IS NOT NEW.connection_version
          OR target_user_id IS NOT NEW.verified_user_id
          OR NEW.verified_user_name IS NULL
          OR NEW.verified_at IS NULL
        )
    )
    BEGIN
      UPDATE device_notification_state SET generation = generation + 1 WHERE singleton = 1;
      UPDATE device_notification_sources
      SET desired_enabled = 0,
          config_generation = (SELECT generation FROM device_notification_state WHERE singleton = 1),
          status_generation = NULL,
          status_state = 'disabled',
          status_cursor = NULL,
          status_last_event_at = NULL,
          status_error_code = 'PEER_CONFIGURATION_CHANGED',
          status_error_message = 'Peer configuration changed',
          updated_at = NEW.updated_at
      WHERE peer_id = OLD.id AND desired_enabled = 1
        AND (
          OLD.base_url IS NOT NEW.base_url
          OR OLD.credential IS NOT NEW.credential
          OR OLD.accept_insecure_http IS NOT NEW.accept_insecure_http
          OR OLD.connection_version IS NOT NEW.connection_version
          OR target_user_id IS NOT NEW.verified_user_id
          OR NEW.verified_user_name IS NULL
          OR NEW.verified_at IS NULL
        );
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS invalidate_device_notification_peer_delete
    BEFORE DELETE ON peers
    WHEN EXISTS (SELECT 1 FROM device_notification_sources WHERE peer_id = OLD.id)
    BEGIN
      UPDATE device_notification_state SET generation = generation + 1 WHERE singleton = 1;
      UPDATE device_notification_sources
      SET desired_enabled = 0,
          config_generation = (SELECT generation FROM device_notification_state WHERE singleton = 1),
          status_generation = NULL,
          status_state = 'disabled',
          status_cursor = NULL,
          status_last_event_at = NULL,
          status_error_code = 'PEER_DELETED',
          status_error_message = 'Peer was deleted',
          updated_at = datetime('now')
      WHERE peer_id = OLD.id;
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS delete_device_notification_sources_with_user
    BEFORE DELETE ON users
    WHEN EXISTS (SELECT 1 FROM device_notification_sources WHERE owner_user_id = OLD.id)
    BEGIN
      UPDATE device_notification_state SET generation = generation + 1 WHERE singleton = 1;
      DELETE FROM device_notification_sources WHERE owner_user_id = OLD.id;
    END
  `);

}
