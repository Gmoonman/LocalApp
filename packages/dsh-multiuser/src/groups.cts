import { randomBytes } from "node:crypto";
export interface GroupStatement {
  bind(values: Array<string | number | null>): unknown;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): unknown;
}
export interface GroupDatabase {
  run(sql: string, values: Array<string | number | null>): unknown;
  prepare(sql: string): GroupStatement;
}
export interface GroupPersistence { database(): GroupDatabase; flush(): void }
// ── Group types ──

export interface GroupRecord {
  id: string;
  name: string;
  description: string | null;
  creatorId: string;
  system: boolean;
  createdAt: string;
}

export interface GroupWithMeta extends GroupRecord {
  memberCount: number;
  isCreator: boolean;
}

// ── Group CRUD ──

export class GroupStore {
  constructor(private readonly persistence: GroupPersistence) {}
  createGroup(name: string, description: string | undefined, creatorId: string, system = false): GroupRecord {
    const d = this.persistence.database();
    const existing = d.prepare("SELECT id FROM groups WHERE name = ?");
    existing.bind([name]);
    if (existing.step()) {
      existing.free();
      throw new Error("GROUP_NAME_EXISTS");
    }
    existing.free();

    const id = randomBytes(10).toString("hex");
    const createdAt = new Date().toISOString();
    d.run("INSERT INTO groups (id, name, description, creator_id, system, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, name, description ?? null, creatorId, system ? 1 : 0, createdAt]);
    // Creator auto-joins
    d.run("INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)", [id, creatorId, createdAt]);
    this.persistence.flush();
    return { id, name, description: description ?? null, creatorId, system, createdAt };
  }

  findGroupById(id: string): GroupRecord | null {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT id, name, description, creator_id, system, created_at FROM groups WHERE id = ?");
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as { id: string; name: string; description: string | null; creator_id: string; system: number; created_at: string };
      stmt.free();
      return { id: row.id, name: row.name, description: row.description, creatorId: row.creator_id, system: row.system === 1, createdAt: row.created_at };
    }
    stmt.free();
    return null;
  }

  findGroupByName(name: string): GroupRecord | null {
    const d = this.persistence.database();
    const stmt = d.prepare("SELECT id, name, description, creator_id, system, created_at FROM groups WHERE name = ?");
    stmt.bind([name]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as { id: string; name: string; description: string | null; creator_id: string; system: number; created_at: string };
      stmt.free();
      return { id: row.id, name: row.name, description: row.description, creatorId: row.creator_id, system: row.system === 1, createdAt: row.created_at };
    }
    stmt.free();
    return null;
  }

  listGroupsByUser(userId: string): GroupWithMeta[] {
    const d = this.persistence.database();
    const stmt = d.prepare(`
      SELECT g.id, g.name, g.description, g.creator_id, g.system, g.created_at,
             (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
      FROM groups g
      WHERE g.id IN (SELECT group_id FROM group_members WHERE user_id = ?)
      ORDER BY g.system DESC, g.created_at ASC
    `);
    stmt.bind([userId]);
    const result: GroupWithMeta[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id: string; name: string; description: string | null; creator_id: string; system: number; created_at: string; member_count: number };
      result.push({
        id: row.id, name: row.name, description: row.description,
        creatorId: row.creator_id, system: row.system === 1, createdAt: row.created_at,
        memberCount: row.member_count, isCreator: row.creator_id === userId,
      });
    }
    stmt.free();
    return result;
  }

  listSystemGroups(): GroupWithMeta[] {
    const d = this.persistence.database();
    const stmt = d.prepare(`
      SELECT g.id, g.name, g.description, g.creator_id, g.system, g.created_at,
             (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
      FROM groups g WHERE g.system = 1
      ORDER BY g.created_at ASC
    `);
    const result: GroupWithMeta[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id: string; name: string; description: string | null; creator_id: string; system: number; created_at: string; member_count: number };
      result.push({
        id: row.id, name: row.name, description: row.description,
        creatorId: row.creator_id, system: true, createdAt: row.created_at,
        memberCount: row.member_count, isCreator: false,
      });
    }
    stmt.free();
    return result;
  }

  updateGroup(id: string, name?: string, description?: string): void {
    const d = this.persistence.database();
    if (name !== undefined) {
      const existing = d.prepare("SELECT id FROM groups WHERE name = ? AND id != ?");
      existing.bind([name, id]);
      if (existing.step()) {
        existing.free();
        throw new Error("GROUP_NAME_EXISTS");
      }
      existing.free();
      d.run("UPDATE groups SET name = ? WHERE id = ?", [name, id]);
    }
    if (description !== undefined) {
      d.run("UPDATE groups SET description = ? WHERE id = ?", [description, id]);
    }
    this.persistence.flush();
  }

  deleteGroup(id: string): void {
    const d = this.persistence.database();
    d.run("DELETE FROM group_members WHERE group_id = ?", [id]);
    d.run("DELETE FROM groups WHERE id = ?", [id]);
    this.persistence.flush();
  }

  // ── Group members ──

  addGroupMembers(groupId: string, userIds: string[]): void {
    if (userIds.length === 0) return;
    const d = this.persistence.database();
    const now = new Date().toISOString();
    for (const uid of userIds) {
      d.run("INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)", [groupId, uid, now]);
    }
    this.persistence.flush();
  }

  removeGroupMembers(groupId: string, userIds: string[]): void {
    if (userIds.length === 0) return;
    const d = this.persistence.database();
    for (const uid of userIds) {
      d.run("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", [groupId, uid]);
    }
    this.persistence.flush();
  }

  getGroupMembers(groupId: string): Array<{ id: string; name: string; displayName: string | null }> {
    const d = this.persistence.database();
    const stmt = d.prepare(`
      SELECT u.id, u.name, u.display_name
      FROM group_members gm JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = ?
      ORDER BY u.name ASC
    `);
    stmt.bind([groupId]);
    const result: Array<{ id: string; name: string; displayName: string | null }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id: string; name: string; display_name: string | null };
      result.push({ id: row.id, name: row.name, displayName: row.display_name });
    }
    stmt.free();
    return result;
  }

  isUserInGroup(userId: string, groupName: string): boolean {
    const d = this.persistence.database();
    const stmt = d.prepare(`
      SELECT 1 FROM group_members gm
      JOIN groups g ON gm.group_id = g.id
      WHERE g.name = ? AND gm.user_id = ?
    `);
    stmt.bind([groupName, userId]);
    const result = stmt.step();
    stmt.free();
    return result;
  }
}
