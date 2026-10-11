import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import path from "node:path";
import { BOOTSTRAP_USER_ID } from "../../src/lib/meta-sqlite.js";
import { execRawSql, getConnection } from "../../src/lib/app-db.js";
import { readPageMeta } from "../../src/plugins/storage.js";
import { createTestPage, createTestServer, getAppUrl, getTestApiKey } from "./helpers.js";

const RESOURCE_SCHEMA_URL = "https://localapp.dev/schemas/backend/resource-schema.schema.json";
const MUTATIONS_SCHEMA_URL = "https://localapp.dev/schemas/backend/mutations.schema.json";

describe("collaboration commit API", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let dataDir: string;
  let stop: () => Promise<void>;
  const apiKey = getTestApiKey();
  const owner = BOOTSTRAP_USER_ID;

  beforeAll(async () => {
    const server = await createTestServer();
    app = server.app;
    baseUrl = getAppUrl(app);
    dataDir = server.dataDir;
    stop = server.stop;
  });

  afterAll(async () => { await stop(); });

  async function setupPage(pageName: string, mutationAccess: "public" | "authenticated" = "public") {
    await createTestPage(app, owner, pageName);
    const migration = [
      "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);",
      "INSERT INTO tasks (id, title) VALUES ('task-1', 'Original');",
    ].join("\n");
    const manifest = {
      name: pageName,
      distDir: "dist",
      backend: { root: "backend" },
      collaboration: {
        enabled: true,
        resources: {
          tasks: {
            mode: "record-versioned",
            mutation: "tasks.updateCollaborative",
            history: true,
          },
        },
      },
    };
    const schema = {
      $schema: RESOURCE_SCHEMA_URL,
      name: "tasks",
      fields: { title: { type: "string" } },
    };
    const mutations = {
      $schema: MUTATIONS_SCHEMA_URL,
      mutations: {
        "tasks.updateCollaborative": {
          kind: "mutation",
          sql: "UPDATE tasks SET title = :title WHERE id = :id",
          params: {
            id: { type: "string", required: true },
            title: { type: "string", required: true },
          },
          access: mutationAccess,
        },
      },
    };
    const upload = multipart([
      field("name", pageName),
      file("manifest", "manifest.json", JSON.stringify(manifest), "application/json"),
      field("filepath_0", "index.html"),
      file("files", "index.html", "<html><body>collab</body></html>", "text/html"),
      field("backendFilepath_0", "backend/resources/tasks/schema.json"),
      file("backendFiles", "schema.json", JSON.stringify(schema), "application/json"),
      field("backendFilepath_1", "backend/resources/tasks/mutations.json"),
      file("backendFiles", "mutations.json", JSON.stringify(mutations), "application/json"),
      ...migrationFile("001_create_tasks.sql", migration),
    ]);
    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": upload.contentType },
      body: upload.body,
    });
    expect(uploadRes.status).toBe(200);
    await getConnection(appDb(pageName));
  }

  async function commit(pageName: string, body: Record<string, unknown>) {
    return fetch(`${baseUrl}/serve/${owner}/${pageName}/api/collaboration/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function readCommittedEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<any> {
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const { value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(/event: collab:operation_committed\ndata: (.+)\n\n/);
      if (match) {
        await reader.cancel();
        return JSON.parse(match[1]);
      }
    }
    await reader.cancel();
    throw new Error(`No committed event received. Buffer: ${buffer}`);
  }

  function appDb(pageName: string) {
    return path.join(dataDir, owner, pageName, "app.db");
  }

  function readTitle(pageName: string): string {
    const rows = execRawSql(appDb(pageName), "SELECT title FROM tasks WHERE id = ?", ["task-1"]).rows ?? [];
    return String(rows[0]?.title);
  }

  function readRevision(pageName: string): number | undefined {
    try {
      const rows = execRawSql(appDb(pageName), "SELECT revision FROM _localapp_record_revisions WHERE resource = ? AND record_id = ?", ["tasks", "task-1"]).rows ?? [];
      const value = rows[0]?.revision;
      return typeof value === "number" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function readLogCount(pageName: string): number {
    try {
      const rows = execRawSql(appDb(pageName), "SELECT COUNT(*) AS count FROM _localapp_operation_log WHERE resource = ? AND record_id = ?", ["tasks", "task-1"]).rows ?? [];
      const value = rows[0]?.count;
      return typeof value === "number" ? value : 0;
    } catch {
      return 0;
    }
  }

  it("isolates verification collaboration events from the formal application", async () => {
    const pageName = "collab-event-isolation";
    await setupPage(pageName);
    const created = await fetch(`${baseUrl}/api/verification/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ owner, app: pageName, version: readPageMeta(dataDir, owner, pageName)!.currentVersion, identity: "owner", ttlSeconds: 60 }),
    });
    expect(created.status).toBe(201);
    const session = await created.json() as any;
    const opened = await fetch(session.data.openUrl, { redirect: "manual" });
    const cookies = opened.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const abort = new AbortController();
    let liveText = "";
    let verificationText = "";
    const read = async (response: Response, append: (chunk: string) => void) => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      try { while (true) { const next = await reader.read(); if (next.done) break; append(decoder.decode(next.value)); } }
      catch (error) { if (!abort.signal.aborted) throw error; }
      finally { reader.releaseLock(); }
    };
    const url = `${baseUrl}/serve/${owner}/${pageName}/api/collaboration/events`;
    const live = await fetch(url, { signal: abort.signal });
    const verification = await fetch(url, { signal: abort.signal, headers: { Cookie: cookies } });
    const reads = [read(live, chunk => { liveText += chunk; }), read(verification, chunk => { verificationText += chunk; })];
    try {
      const result = await fetch(`${baseUrl}/serve/${owner}/${pageName}/api/collaboration/commit`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: cookies },
        body: JSON.stringify({ resource: "tasks", recordId: "task-1", baseRevision: 0, operationId: "verification-only", params: { id: "task-1", title: "Isolated" } }),
      });
      const resultBody = await result.json();
      expect(result.status, JSON.stringify(resultBody)).toBe(200);
      await expect.poll(() => verificationText).toContain("verification-only");
      expect(liveText).not.toContain("verification-only");
      expect(readTitle(pageName)).toBe("Original");
    } finally { abort.abort(); await Promise.all(reads); }
  });

  it("baseRevision 匹配时执行声明 mutation、推进 revision、写 operation log", async () => {
    const pageName = "collab-commit-ok";
    await setupPage(pageName);

    const res = await commit(pageName, {
      resource: "tasks",
      recordId: "task-1",
      baseRevision: 0,
      operationId: "op-ok",
      params: { id: "task-1", title: "Updated" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, data: { revision: 1, operationId: "op-ok" } });
    expect(readTitle(pageName)).toBe("Updated");
    expect(readRevision(pageName)).toBe(1);
    expect(readLogCount(pageName)).toBe(1);
  });

  it("baseRevision 不匹配时返回 revision_conflict 且不执行写入", async () => {
    const pageName = "collab-commit-conflict";
    await setupPage(pageName);
    await commit(pageName, {
      resource: "tasks",
      recordId: "task-1",
      baseRevision: 0,
      operationId: "op-first",
      params: { id: "task-1", title: "First" },
    });

    const res = await commit(pageName, {
      resource: "tasks",
      recordId: "task-1",
      baseRevision: 0,
      operationId: "op-stale",
      params: { id: "task-1", title: "Stale" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false,
      code: "revision_conflict",
      data: { serverRevision: 1 },
    });
    expect(readTitle(pageName)).toBe("First");
    expect(readRevision(pageName)).toBe(1);
    expect(readLogCount(pageName)).toBe(1);
  });

  it("拒绝客户端 SQL 和未声明 resource", async () => {
    const pageName = "collab-commit-security";
    await setupPage(pageName);

    const sqlRes = await commit(pageName, {
      resource: "tasks",
      recordId: "task-1",
      baseRevision: 0,
      operationId: "op-sql",
      sql: "DROP TABLE tasks",
      params: { id: "task-1", title: "Unsafe" },
    });
    expect(sqlRes.status).toBe(400);
    expect((await sqlRes.json()).error).toMatch(/sql|not allowed/i);

    const resourceRes = await commit(pageName, {
      resource: "notes",
      recordId: "note-1",
      baseRevision: 0,
      operationId: "op-resource",
      params: { id: "note-1", title: "Nope" },
    });
    expect(resourceRes.status).toBe(403);
    expect(readTitle(pageName)).toBe("Original");
    expect(readRevision(pageName)).toBeUndefined();
    expect(readLogCount(pageName)).toBe(0);
  });

  it("named mutation 失败时不推进 revision 且不写成功 log", async () => {
    const pageName = "collab-commit-mutation-fail";
    await setupPage(pageName);

    const res = await commit(pageName, {
      resource: "tasks",
      recordId: "task-1",
      baseRevision: 0,
      operationId: "op-fail",
      params: { id: "task-1" },
    });

    expect(res.status).toBe(400);
    expect(readTitle(pageName)).toBe("Original");
    expect(readRevision(pageName)).toBeUndefined();
    expect(readLogCount(pageName)).toBe(0);
  });

  it("undo 转换成写 operation 时仍按当前用户重新授权", async () => {
    const pageName = "collab-commit-undo-auth";
    await setupPage(pageName, "authenticated");

    const res = await commit(pageName, {
      resource: "tasks",
      recordId: "task-1",
      baseRevision: 0,
      operationId: "op-undo",
      operationKind: "undo",
      params: { id: "task-1", title: "Undo title" },
    });

    expect(res.status).toBe(401);
    expect(readTitle(pageName)).toBe("Original");
    expect(readRevision(pageName)).toBeUndefined();
    expect(readLogCount(pageName)).toBe(0);
  });

  it("提交成功后向同 app/resource 订阅者广播 committed event", async () => {
    const pageName = "collab-commit-event";
    await setupPage(pageName);
    const events = await fetch(`${baseUrl}/serve/${owner}/${pageName}/api/collaboration/events?resource=tasks`);
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");

    const res = await commit(pageName, {
      resource: "tasks",
      recordId: "task-1",
      baseRevision: 0,
      operationId: "op-event",
      params: { id: "task-1", title: "Evented" },
    });
    expect(res.status).toBe(200);

    await expect(readCommittedEvent(reader)).resolves.toMatchObject({
      type: "collab:operation_committed",
      data: {
        appOwner: owner,
        appName: pageName,
        resource: "tasks",
        recordId: "task-1",
        revision: 1,
        operationId: "op-event",
      },
    });
  });

  it("冲突或 mutation 失败时不广播 committed event", async () => {
    const pageName = "collab-commit-no-event";
    await setupPage(pageName);
    const events = await fetch(`${baseUrl}/serve/${owner}/${pageName}/api/collaboration/events?resource=tasks`);
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    await reader.read();

    const res = await commit(pageName, {
      resource: "tasks",
      recordId: "task-1",
      baseRevision: 0,
      operationId: "op-no-event",
      params: { id: "task-1" },
    });
    expect(res.status).toBe(400);

    const race = await Promise.race([
      reader.read().then((chunk) => ({ chunk })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 150)),
    ]);
    await reader.cancel();
    expect(race).toEqual({ timeout: true });
  });
});

function multipart(parts: string[]): { body: string; contentType: string } {
  const boundary = `----CollaborationCommit${Date.now()}${Math.random()}`;
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

function migrationFile(filename: string, content: string): string[] {
  const checksum = crypto.createHash("sha256").update(content).digest("hex");
  return [
    field(`migrationChecksum_${filename}`, checksum),
    file(`migration_${filename}`, filename, content, "application/sql"),
  ];
}
