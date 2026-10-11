import { expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { closeAllConnections, closeConnectionsUnderDirectory, closeIdleConnections, execRawSql, getConnection, runDbTransaction, withDbQueue } from "../app-db.js";

async function fixture(run: (file: string) => Promise<void>) {
  const parent = path.resolve(__dirname, "../../../../../tmp/database-maintenance");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "run-"));
  try {
    const file = path.join(root, "app.db");
    await getConnection(file); execRawSql(file, "CREATE TABLE records (value TEXT)");
    await run(file);
  } finally { vi.restoreAllMocks(); closeAllConnections(); await fs.rm(root, { recursive: true, force: true }); }
}

it("releases an opening connection even without a database queue", async () => fixture(async file => {
  const opening = getConnection(path.join(path.dirname(file), "opening.db"));
  await closeConnectionsUnderDirectory(path.dirname(file));
  const connection = await opening;
  expect(() => connection.exec("SELECT 1")).toThrow();
}));

it("shares concurrent opens of the same database", async () => fixture(async file => {
  const otherFile = path.join(path.dirname(file), "concurrent.db");
  const [first, second] = await Promise.all([getConnection(otherFile), getConnection(otherFile)]);
  expect(first).toBe(second);
}));

it("does not evict a connection held by an active database queue", async () => fixture(async file => {
  const connection = await getConnection(file);
  await withDbQueue(file, async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    closeIdleConnections();
    expect(connection.exec("SELECT 1")[0].values).toEqual([[1]]);
  });
  closeIdleConnections();
  expect(() => connection.exec("SELECT 1")).toThrow();
}));

it("preserves rollback when idle maintenance runs inside a transaction", async () => fixture(async file => {
  await expect(runDbTransaction(file, () => {
    execRawSql(file, "INSERT INTO records VALUES ('uncommitted')");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    closeIdleConnections();
    throw new Error("requested rollback");
  })).rejects.toThrow("requested rollback");
  const reopened = await getConnection(file);
  expect(reopened.exec("SELECT value FROM records")).toEqual([]);
}));

it("drains owned connections without closing a sibling directory", async () => fixture(async file => {
  const root = path.dirname(file);
  const sibling = root + "-other";
  await fs.mkdir(sibling, { recursive: true });
  try {
    const connection = await getConnection(file);
    const other = await getConnection(path.join(sibling, "other.db"));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const writing = withDbQueue(file, async () => { entered(); await held; execRawSql(file, "INSERT INTO records VALUES ('saved')"); });
    await started;
    let closed = false;
    const closing = closeConnectionsUnderDirectory(root).then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(connection.exec("SELECT 1")[0].values).toEqual([[1]]);
    release(); await writing; await closing;
    expect(() => connection.exec("SELECT 1")).toThrow();
    expect(other.exec("SELECT 1")[0].values).toEqual([[1]]);
    expect((await getConnection(file)).exec("SELECT value FROM records")[0].values).toEqual([["saved"]]);
  } finally { closeAllConnections(); await fs.rm(sibling, { recursive: true, force: true }); }
}));

it("releases the configured directory when its Cordis platform plugin stops", async () => fixture(async file => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { default: Platform } = await import("@localapp/dsh-app-platform");
  const ctx = new Context(); const app = Fastify();
  try {
    await ctx.plugin(Platform, { owner: () => undefined, application: () => undefined, canAccess: () => false });
    const connection = await getConnection(file);
    execRawSql(file, "INSERT INTO records VALUES ('plugin-data')");
    ctx.localappApps.registerDatabaseMaintenance(app, path.dirname(file));
    await ctx.fiber.dispose();
    expect(() => connection.exec("SELECT 1")).toThrow();
    expect((await getConnection(file)).exec("SELECT value FROM records")[0].values).toEqual([["plugin-data"]]);
  } finally { await app.close(); await ctx.fiber.dispose(); }
}));

it("drains a queued operation that has not opened its database yet", async () => fixture(async file => {
  const lateFile = path.join(path.dirname(file), "late.db");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let connection: Awaited<ReturnType<typeof getConnection>> | undefined;
  const writing = withDbQueue(lateFile, async () => {
    entered(); await held;
    connection = await getConnection(lateFile);
    execRawSql(lateFile, "CREATE TABLE late_records (value TEXT); INSERT INTO late_records VALUES ('saved')");
  });
  await started;
  let closed = false;
  const closing = closeConnectionsUnderDirectory(path.dirname(file)).then(() => { closed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
  } finally { release(); await writing; await closing; }
  expect(() => connection!.exec("SELECT 1")).toThrow();
  expect((await getConnection(lateFile)).exec("SELECT value FROM late_records")[0].values).toEqual([["saved"]]);
}));
