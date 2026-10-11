import { createHash, randomBytes } from "node:crypto";
import type { GroupDatabase } from "./groups.cjs";
export interface ApiKeyPersistence { database(): GroupDatabase; flush(): void }
export interface ApiKeyRecord {
  key: string;
  userId: string;
  createdAt: string;
}

const API_KEY_HASH_PREFIX = "sha256:";

export function apiKeyStorageValue(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return `${API_KEY_HASH_PREFIX}${digest}:${key.slice(-8)}`;
}

function maskStoredApiKey(storedKey: string): string {
  const suffix = storedKey.startsWith(API_KEY_HASH_PREFIX)
    ? storedKey.slice(storedKey.lastIndexOf(":") + 1)
    : storedKey.slice(-8);
  return `••••${suffix}`;
}

export class ApiKeyStore {
  constructor(private readonly persistence: ApiKeyPersistence) {}
  validateApiKey(key: string): string | null {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT user_id FROM api_keys WHERE key = ? OR key = ?");
    stmt.bind([key, apiKeyStorageValue(key)]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as { user_id: string };
      stmt.free();
      return row.user_id;
    }
    stmt.free();
    return null;
  }

  createApiKey(userId: string): ApiKeyRecord {
    const d = this.persistence.database();
    const key = randomBytes(24).toString("hex");
    const createdAt = new Date().toISOString();
    d.run("INSERT INTO api_keys (key, user_id, created_at) VALUES (?, ?, ?)", [
      apiKeyStorageValue(key),
      userId,
      createdAt,
    ]);
    this.persistence.flush();
    return { key, userId, createdAt };
  }

  listApiKeysByUser(userId: string): Array<{ key: string; createdAt: string }> {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT key, created_at FROM api_keys WHERE user_id = ?");
    stmt.bind([userId]);
    const results: Array<{ key: string; createdAt: string }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { key: string; created_at: string };
      results.push({
        key: maskStoredApiKey(row.key),
        createdAt: row.created_at,
      });
    }
    stmt.free();
    return results;
  }

}
