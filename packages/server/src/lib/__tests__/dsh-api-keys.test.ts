import { it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiKeyStore, apiKeyStorageValue } from "@localapp/dsh-multiuser/api-keys";
import { initMetaDb, closeMetaDb, getDb, flushMetaDb } from "../meta-sqlite.js";

it("preserves legacy and hashed keys across database reopen without revealing secrets in lists", async () => {
  const root = path.resolve(process.cwd(), "../../tmp/dsh-api-key-upgrade");
  await fs.mkdir(root, { recursive: true });
  await initMetaDb(root);
  try {
    const store = new ApiKeyStore({ database: getDb, flush: flushMetaDb });
    const legacy = "legacy-key-for-existing-user";
    getDb().run("INSERT INTO api_keys (key, user_id, created_at) VALUES (?, ?, ?)", [legacy, "legacy-user", "2026-01-01"]);
    flushMetaDb();
    const created = store.createApiKey("new-user");
    const rows = getDb().exec("SELECT key FROM api_keys WHERE user_id = 'new-user'");
    expect(rows[0].values[0][0]).toBe(apiKeyStorageValue(created.key));
    expect(rows[0].values[0][0]).not.toBe(created.key);
    closeMetaDb();
    await initMetaDb(root);
    expect(store.validateApiKey(legacy)).toBe("legacy-user");
    expect(store.validateApiKey(created.key)).toBe("new-user");
    expect(store.validateApiKey("invalid")).toBeNull();
    expect(store.listApiKeysByUser("legacy-user")).toEqual([{ key: `••••${legacy.slice(-8)}`, createdAt: "2026-01-01" }]);
    expect(store.listApiKeysByUser("new-user")).toEqual([{ key: `••••${created.key.slice(-8)}`, createdAt: created.createdAt }]);
  } finally {
    closeMetaDb();
    await fs.rm(root, { recursive: true, force: true });
  }
});
