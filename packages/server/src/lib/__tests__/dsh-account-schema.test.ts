import { it, expect } from "vitest";
import initSqlJs from "sql.js";
import { initializeAccountSchema } from "@localapp/dsh-multiuser/account-schema";
import { AccountStore } from "@localapp/dsh-multiuser/accounts";
import { createAccountServices } from "@localapp/dsh-multiuser/account-services";

it("upgrades an old account database independently and preserves existing credentials and generation", async () => {
  const sql = await initSqlJs();
  const database = new sql.Database();
  try {
    database.run("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, password TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL)");
    database.run("INSERT INTO users VALUES ('old-user', 'Existing User', 'existing-password-hash', 'local', '2025-01-01')");
    initializeAccountSchema(database);
    const store = new AccountStore({ database: () => database, flush: () => {}, atomic: mutation => mutation(database) });
    const user = store.findUserByName("Existing User");
    expect(user).toMatchObject({ id: "old-user", password: "existing-password-hash", createdAt: "2025-01-01", role: "user", authVersion: 0, mustChangePassword: false });
    expect(user?.authGeneration).toMatch(/^[0-9a-f]{32}$/);
    initializeAccountSchema(database);
    expect(store.findUserByName("Existing User")).toEqual(user);
    database.run("INSERT INTO auth_sessions VALUES ('token', 'old-user', '2026-01-01', '2026-01-01', '2026-12-01')");
    const bytes = database.export();
    const reopened = new sql.Database(bytes);
    try {
      initializeAccountSchema(reopened);
      expect(reopened.exec("SELECT token_hash FROM auth_sessions")[0].values).toEqual([["token"]]);
      expect(reopened.exec("SELECT auth_generation FROM users")[0].values).toEqual([[user?.authGeneration]]);
    } finally { reopened.close(); }
  } finally { database.close(); }
});

it("shares accounts, API keys and group membership through one plugin service set", async () => {
  const sql = await initSqlJs();
  const database = new sql.Database();
  try {
    const services = createAccountServices({ database: () => database, flush: () => {}, atomic: mutation => mutation(database) });
    services.initialize();
    services.accounts.createInitialAdmin("admin", "Admin", "admin-hash", "bootstrap-secret");
    services.accounts.provisionUserWithApiKey("member", "Member", "member-hash", "member-secret");
    expect(services.apiKeys.validateApiKey("member-secret")).toBe("member");
    expect(services.apiKeys.validateApiKey("bootstrap-secret")).toBe("admin");
    expect(services.groups.isUserInGroup("member", "everyone")).toBe(true);
    expect(services.groups.getGroupMembers(services.groups.findGroupByName("everyone")!.id).map(user => user.id)).toEqual(["admin", "member"]);
    expect(services.accounts.deleteUserById("member")).toBe(true);
    expect(services.apiKeys.validateApiKey("member-secret")).toBeNull();
    expect(services.groups.isUserInGroup("member", "everyone")).toBe(false);
    expect(services.accounts.findUserById("admin")?.role).toBe("admin");
  } finally { database.close(); }
});
