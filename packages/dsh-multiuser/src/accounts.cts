import { randomBytes } from "node:crypto";
import { apiKeyStorageValue } from "./api-keys.cjs";
import type { GroupDatabase } from "./groups.cjs";
export interface AccountDatabase extends GroupDatabase { run(sql: string, values?: Array<string | number | null>): unknown; getRowsModified(): number }
export interface AccountPersistence { database(): AccountDatabase; flush(): void; atomic<T>(mutation: (database: AccountDatabase) => T): T }
export interface UserRecord {
  id: string;
  name: string;
  provider: string;
  role: "admin" | "user";
  createdAt: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  mustChangePassword: boolean;
}
export interface UserRow {
  id: string;
  name: string;
  password: string;
  provider: string;
  role: string;
  created_at: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  must_change_password: number;
  auth_version: number;
  auth_generation: string;
}
export interface AuthSessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}
function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    role: (row.role === "admin" ? "admin" : "user") as "admin" | "user",
    createdAt: row.created_at,
    displayName: row.display_name ?? null,
    avatarUrl: row.avatar_url ?? null,
    bio: row.bio ?? null,
    mustChangePassword: row.must_change_password === 1,
  };
}

function authSessionFromRow(row: Record<string, unknown>): AuthSessionRecord {
  return {
    tokenHash: String(row.token_hash),
    userId: String(row.user_id),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
    expiresAt: String(row.expires_at),
  };
}
export class AccountStore {
  constructor(private readonly persistence: AccountPersistence) {}
  countAdministrators(): number {
    const stmt = this.persistence.database().prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'");
    stmt.step();
    const count = Number(stmt.getAsObject().cnt);
    stmt.free();
    return count;
  }
  createUser(id: string, name: string, passwordHash: string, provider = "local"): UserRecord {
    const d = this.persistence.database();
    const existing = d.prepare("SELECT id FROM users WHERE id = ?");
    existing.bind([id]);
    const exists = existing.step();
    existing.free();
    if (exists) throw new Error("USER_EXISTS");

    const createdAt = new Date().toISOString();
    d.run(
      "INSERT INTO users (id, name, password, provider, role, auth_generation, created_at) VALUES (?, ?, ?, ?, 'user', ?, ?)",
      [id, name, passwordHash, provider, randomBytes(16).toString("hex"), createdAt],
    );
    // Auto-join "everyone" group
    const everyoneStmt = d.prepare("SELECT id FROM groups WHERE name = 'everyone'");
    if (everyoneStmt.step()) {
      const groupRow = everyoneStmt.getAsObject() as { id: string };
      d.run("INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)", [groupRow.id, id, createdAt]);
    }
    everyoneStmt.free();
    this.persistence.flush();
    return { id, name, provider, role: "user", createdAt, displayName: null, avatarUrl: null, bio: null, mustChangePassword: false };
  }

  createInitialAdmin(
    id: string,
    name: string,
    passwordHash: string,
    bootstrapApiKey?: string,
  ): UserRecord {
    const d = this.persistence.database();
    const createdAt = new Date().toISOString();
    let committed = false;
    d.run("BEGIN");
    try {
      const countStmt = d.prepare("SELECT COUNT(*) AS total FROM users");
      countStmt.step();
      const { total } = countStmt.getAsObject() as { total: number };
      countStmt.free();
      if (total !== 0) throw new Error("SETUP_ALREADY_COMPLETED");

      d.run(
        "INSERT INTO users (id, name, password, provider, role, auth_generation, created_at) VALUES (?, ?, ?, 'local', 'admin', ?, ?)",
        [id, name, passwordHash, randomBytes(16).toString("hex"), createdAt],
      );
      const groupId = randomBytes(10).toString("hex");
      d.run(
        "INSERT INTO groups (id, name, description, creator_id, system, created_at) VALUES (?, 'everyone', 'All users', ?, 1, ?)",
        [groupId, id, createdAt],
      );
      d.run("INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)", [groupId, id, createdAt]);
      if (bootstrapApiKey) {
        d.run("INSERT INTO api_keys (key, user_id, created_at) VALUES (?, ?, ?)", [
          apiKeyStorageValue(bootstrapApiKey),
          id,
          createdAt,
        ]);
      }
      d.run("COMMIT");
      committed = true;
      this.persistence.flush();
    } catch (error) {
      if (!committed) d.run("ROLLBACK");
      throw error;
    }

    return {
      id,
      name,
      provider: "local",
      role: "admin",
      createdAt,
      displayName: null,
      avatarUrl: null,
      bio: null,
      mustChangePassword: false,
    };
  }

  provisionUserWithApiKey(
    id: string,
    name: string,
    passwordHash: string,
    apiKey: string,
    provider = "local",
  ): UserRecord {
    const d = this.persistence.database();
    const existing = d.prepare("SELECT id FROM users WHERE id = ?");
    existing.bind([id]);
    const exists = existing.step();
    existing.free();
    if (exists) throw new Error("USER_EXISTS");

    const createdAt = new Date().toISOString();
    let committed = false;
    d.run("BEGIN");
    try {
      d.run(
        "INSERT INTO users (id, name, password, provider, role, must_change_password, auth_generation, created_at) VALUES (?, ?, ?, ?, 'user', 1, ?, ?)",
        [id, name, passwordHash, provider, randomBytes(16).toString("hex"), createdAt],
      );
      d.run("INSERT INTO api_keys (key, user_id, created_at) VALUES (?, ?, ?)", [
        apiKeyStorageValue(apiKey),
        id,
        createdAt,
      ]);

      const everyoneStmt = d.prepare("SELECT id FROM groups WHERE name = 'everyone'");
      if (everyoneStmt.step()) {
        const groupRow = everyoneStmt.getAsObject() as { id: string };
        d.run("INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)", [
          groupRow.id,
          id,
          createdAt,
        ]);
      }
      everyoneStmt.free();

      d.run("COMMIT");
      committed = true;
      this.persistence.flush();
    } catch (error) {
      if (!committed) d.run("ROLLBACK");
      throw error;
    }

    return {
      id,
      name,
      provider,
      role: "user",
      createdAt,
      displayName: null,
      avatarUrl: null,
      bio: null,
      mustChangePassword: true,
    };
  }

  findUserById(id: string): UserRecord | null {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT id, name, password, provider, role, created_at, display_name, avatar_url, bio, must_change_password FROM users WHERE id = ?");
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as unknown as UserRow;
      stmt.free();
      return toUserRecord(row);
    }
    stmt.free();
    return null;
  }

  findUserByName(name: string): (UserRecord & { password: string; authVersion: number; authGeneration: string }) | null {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT id, name, password, provider, role, created_at, display_name, avatar_url, bio, must_change_password, auth_version, auth_generation FROM users WHERE name = ?");
    stmt.bind([name]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as unknown as UserRow;
      stmt.free();
      return {
        ...toUserRecord(row),
        password: row.password,
        authVersion: row.auth_version,
        authGeneration: row.auth_generation,
      };
    }
    stmt.free();
    return null;
  }

  getUserRole(id: string): "admin" | "user" | null {
    const user = this.findUserById(id);
    return user ? user.role : null;
  }

  listUsers(page: number, limit: number): { data: UserRecord[]; total: number } {
    const d = this.persistence.database();
    const countStmt = d.prepare("SELECT COUNT(*) as total FROM users");
    countStmt.step();
    const total = (countStmt.getAsObject() as { total: number }).total;
    countStmt.free();

    const offset = (page - 1) * limit;
    const stmt = d.prepare("SELECT id, name, password, provider, role, created_at, display_name, avatar_url, bio, must_change_password FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?");
    stmt.bind([limit, offset]);
    const data: UserRecord[] = [];
    while (stmt.step()) {
      data.push(toUserRecord(stmt.getAsObject() as unknown as UserRow));
    }
    stmt.free();
    return { data, total };
  }

  listAllUsersBasic(): Array<{
    id: string;
    name: string;
    displayName: string | null;
    avatarUrl: string | null;
  }> {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT id, name, display_name, avatar_url FROM users ORDER BY created_at ASC");
    const result: Array<{ id: string; name: string; displayName: string | null; avatarUrl: string | null }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string;
        name: string;
        display_name: string | null;
        avatar_url: string | null;
      };
      result.push({ id: row.id, name: row.name, displayName: row.display_name, avatarUrl: row.avatar_url });
    }
    stmt.free();
    return result;
  }

  listAllUsersPlatform(): Array<{
    id: string;
    name: string;
    displayName: string | null;
    avatarUrl: string | null;
    role: "admin" | "user";
  }> {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT id, name, display_name, avatar_url, role FROM users ORDER BY created_at ASC");
    const result: Array<{
      id: string;
      name: string;
      displayName: string | null;
      avatarUrl: string | null;
      role: "admin" | "user";
    }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string;
        name: string;
        display_name: string | null;
        avatar_url: string | null;
        role: string;
      };
      result.push({
        id: row.id,
        name: row.name,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        role: row.role === "admin" ? "admin" : "user",
      });
    }
    stmt.free();
    return result;
  }

  updateUserProfile(id: string, displayName: string | undefined, bio: string | undefined): void {
    const d = this.persistence.database();
    if (displayName !== undefined) d.run("UPDATE users SET display_name = ? WHERE id = ?", [displayName, id]);
    if (bio !== undefined) d.run("UPDATE users SET bio = ? WHERE id = ?", [bio, id]);
    this.persistence.flush();
  }

  updateUserPassword(id: string, passwordHash: string): void {
    this.updateUserPasswordAndRevokeSessions(id, passwordHash, false);
  }

  updateUserPasswordAndRevokeSessions(
    id: string,
    passwordHash: string,
    mustChangePassword: boolean,
    expectedAuthVersion?: number,
    expectedAuthGeneration?: string,
  ): number | null {
    const d = this.persistence.database();
    let committed = false;
    d.run("BEGIN");
    try {
      if (expectedAuthVersion === undefined || expectedAuthGeneration === undefined) {
        d.run(
          "UPDATE users SET password = ?, must_change_password = ?, auth_version = auth_version + 1 WHERE id = ?",
          [passwordHash, mustChangePassword ? 1 : 0, id],
        );
      } else {
        d.run(
          "UPDATE users SET password = ?, must_change_password = ?, auth_version = auth_version + 1 WHERE id = ? AND auth_version = ? AND auth_generation = ?",
          [passwordHash, mustChangePassword ? 1 : 0, id, expectedAuthVersion, expectedAuthGeneration],
        );
      }
      if (d.getRowsModified() === 0) {
        d.run("ROLLBACK");
        return null;
      }
      d.run("DELETE FROM auth_sessions WHERE user_id = ?", [id]);
      const versionStmt = d.prepare("SELECT auth_version FROM users WHERE id = ?");
      versionStmt.bind([id]);
      versionStmt.step();
      const authVersion = Number((versionStmt.getAsObject() as { auth_version: number }).auth_version);
      versionStmt.free();
      d.run("COMMIT");
      committed = true;
      this.persistence.flush();
      return authVersion;
    } catch (error) {
      if (!committed) d.run("ROLLBACK");
      throw error;
    }
  }



  insertAuthSession(session: AuthSessionRecord): void {
    const d = this.persistence.database();
    d.run(
      "INSERT INTO auth_sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      [session.tokenHash, session.userId, session.createdAt, session.lastSeenAt, session.expiresAt],
    );
    this.persistence.flush();
  }

  insertAuthSessionForUserVersion(
    session: AuthSessionRecord,
    authVersion: number,
    authGeneration: string,
  ): boolean {
    const d = this.persistence.database();
    d.run(
      `INSERT INTO auth_sessions (token_hash, user_id, created_at, last_seen_at, expires_at)
       SELECT ?, id, ?, ?, ? FROM users WHERE id = ? AND auth_version = ? AND auth_generation = ?`,
      [
        session.tokenHash,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
        session.userId,
        authVersion,
        authGeneration,
      ],
    );
    const changed = d.getRowsModified() > 0;
    if (changed) this.persistence.flush();
    return changed;
  }

  findAuthSession(tokenHash: string): AuthSessionRecord | null {
    const stmt = this.persistence.database().prepare(
      "SELECT token_hash, user_id, created_at, last_seen_at, expires_at FROM auth_sessions WHERE token_hash = ?",
    );
    stmt.bind([tokenHash]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const session = authSessionFromRow(stmt.getAsObject());
    stmt.free();
    return session;
  }

  updateAuthSessionActivity(tokenHash: string, lastSeenAt: string, expiresAt: string): boolean {
    const d = this.persistence.database();
    d.run(
      "UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
      [lastSeenAt, expiresAt, tokenHash],
    );
    const changed = d.getRowsModified() > 0;
    if (changed) this.persistence.flush();
    return changed;
  }

  deleteAuthSession(tokenHash: string): boolean {
    const d = this.persistence.database();
    d.run("DELETE FROM auth_sessions WHERE token_hash = ?", [tokenHash]);
    const changed = d.getRowsModified() > 0;
    if (changed) this.persistence.flush();
    return changed;
  }

  deleteAuthSessionsForUser(userId: string): number {
    const d = this.persistence.database();
    d.run("DELETE FROM auth_sessions WHERE user_id = ?", [userId]);
    const changed = d.getRowsModified();
    if (changed > 0) this.persistence.flush();
    return changed;
  }

  deleteExpiredAuthSessions(now: string): number {
    const d = this.persistence.database();
    d.run("DELETE FROM auth_sessions WHERE expires_at <= ?", [now]);
    const changed = d.getRowsModified();
    if (changed > 0) this.persistence.flush();
    return changed;
  }

  updateUserAvatar(id: string, avatarUrl: string | null): void {
    const d = this.persistence.database();
    d.run("UPDATE users SET avatar_url = ? WHERE id = ?", [avatarUrl, id]);
    this.persistence.flush();
  }

  updateUserRole(id: string, role: "admin" | "user"): void {
    const d = this.persistence.database();
    d.run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
    this.persistence.flush();
  }

  findUserProvider(id: string): string | null {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT provider FROM users WHERE id = ?");
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as { provider: string };
      stmt.free();
      return row.provider;
    }
    stmt.free();
    return null;
  }

  resetUserPassword(userId: string, passwordHash: string): void {
    this.updateUserPasswordAndRevokeSessions(userId, passwordHash, true);
  }

  clearMustChangePassword(userId: string): void {
    const d = this.persistence.database();
    d.run("UPDATE users SET must_change_password = 0 WHERE id = ?", [userId]);
    this.persistence.flush();
  }

  setMustChangePassword(userId: string): void {
    const d = this.persistence.database();
    d.run("UPDATE users SET must_change_password = 1 WHERE id = ?", [userId]);
    this.persistence.flush();
  }

  deleteUserById(id: string): boolean {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT id FROM users WHERE id = ?");
    stmt.bind([id]);
    const exists = stmt.step();
    stmt.free();
    if (!exists) return false;

    this.persistence.atomic((database) => {
      database.run("DELETE FROM api_keys WHERE user_id = ?", [id]);
      database.run("DELETE FROM auth_sessions WHERE user_id = ?", [id]);
      database.run("DELETE FROM group_members WHERE user_id = ?", [id]);
      database.run("DELETE FROM users WHERE id = ?", [id]);
    });
    return true;
  }

}
