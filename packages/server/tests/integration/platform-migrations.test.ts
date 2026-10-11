import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { applyPlatformMigrationsToAllApps } from "../../src/lib/platform-migrations.js";
import { createTestServer, getAppUrl, getTestApiKey } from "./helpers.js";

describe("platform migrations", () => {
  it("applies pending platform migrations and records them in each app db", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-platform-migration-"));
    try {
      const migrationsDir = path.join(tmpDir, "platform-migrations");
      const pageDir = createApp(tmpDir, "u-1", "app-one");
      await createDb(pageDir, "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);");
      fs.mkdirSync(migrationsDir, { recursive: true });
      fs.writeFileSync(path.join(migrationsDir, "001_add_user_bio.sql"), "ALTER TABLE users ADD COLUMN bio TEXT;");

      await applyPlatformMigrationsToAllApps({ dataDir: tmpDir, migrationsDir });
      await applyPlatformMigrationsToAllApps({ dataDir: tmpDir, migrationsDir });

      const SQL = await initSqlJs();
      const db = new SQL.Database(fs.readFileSync(path.join(pageDir, "app.db")));
      const columns = db.exec("PRAGMA table_info(users)")[0]?.values.map((row) => row[1]);
      const applied = db.exec("SELECT filename FROM _localapp_applied_platform_migrations")[0]?.values;
      db.close();

      expect(columns).toContain("bio");
      expect(applied).toEqual([["001_add_user_bio.sql"]]);

      fs.writeFileSync(path.join(migrationsDir, "001_add_user_bio.sql"), "ALTER TABLE users ADD COLUMN changed_bio TEXT;");
      await applyPlatformMigrationsToAllApps({ dataDir: tmpDir, migrationsDir });
      expect(JSON.parse(fs.readFileSync(path.join(pageDir, "meta.json"), "utf8")).status).toBe("needs-migration-repair");
      const unchanged = new SQL.Database(fs.readFileSync(path.join(pageDir, "app.db")));
      try {
        const finalColumns = unchanged.exec("PRAGMA table_info(users)")[0]?.values.map(row => row[1]);
        expect(finalColumns).toContain("bio");
        expect(finalColumns).not.toContain("changed_bio");
        expect(unchanged.exec("SELECT filename FROM _localapp_applied_platform_migrations")[0]?.values).toEqual(applied);
      } finally { unchanged.close(); }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("marks app as needs-migration-repair after platform migration failure and rejects upload", async () => {
    const server = await createTestServer();
    try {
      const pageName = "platform-migration-repair";
      const pageDir = createApp(server.dataDir, "localadmin", pageName);
      await createDb(pageDir, "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);");
      const migrationsDir = path.join(server.dataDir, "platform-migrations");
      fs.mkdirSync(migrationsDir, { recursive: true });
      fs.writeFileSync(path.join(migrationsDir, "001_bad.sql"), "CREATE TABLE tasks (id INTEGER);");

      await applyPlatformMigrationsToAllApps({ dataDir: server.dataDir, migrationsDir });

      const meta = JSON.parse(fs.readFileSync(path.join(pageDir, "meta.json"), "utf8")) as { status?: string };
      expect(meta.status).toBe("needs-migration-repair");

      const upload = multipart([
        field("name", pageName),
        file("files", "index.html", "<html><body>blocked</body></html>", "text/html"),
      ]);
      const res = await fetch(`${getAppUrl(server.app)}/api/upload`, {
        method: "POST",
        headers: { "X-API-Key": getTestApiKey(), "Content-Type": upload.contentType },
        body: upload.body,
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        success: false,
        error: expect.stringContaining("needs-migration-repair"),
      });
    } finally {
      await server.stop();
    }
  });
});

function createApp(dataDir: string, userId: string, name: string): string {
  const pageDir = path.join(dataDir, userId, name);
  fs.mkdirSync(pageDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(pageDir, "meta.json"), JSON.stringify({
    name,
    userId,
    description: "",
    currentVersion: 0,
    createdAt: now,
    updatedAt: now,
    versions: [],
    metadata: {},
  }, null, 2));
  return pageDir;
}

async function createDb(pageDir: string, sql: string): Promise<void> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    db.run(sql);
    fs.writeFileSync(path.join(pageDir, "app.db"), Buffer.from(db.export()));
  } finally {
    db.close();
  }
}

function multipart(parts: string[]): { body: string; contentType: string } {
  const boundary = `----PlatformMigration${Date.now()}`;
  return {
    body: `${parts.map((part) => `--${boundary}\r\n${part}`).join("")}--${boundary}--\r\n`,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function field(name: string, value: string): string {
  return `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

function file(name: string, filename: string, content: string, contentType: string): string {
  return [
    `Content-Disposition: form-data; name="${name}"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    "",
    content,
    "",
  ].join("\r\n");
}
