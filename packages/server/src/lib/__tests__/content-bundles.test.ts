import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import {
  ContentBundles,
  validateBundleFiles,
  recordFileUploader,
  canExportFile,
} from "../../../../dsh-app-platform/dist/content-bundles.cjs";
const root = path.resolve("../../tmp/content-bundle-tests");
fs.mkdirSync(root, { recursive: true });
let service: ContentBundles | undefined;
let dir: string;
afterEach(async () => {
  await service?.close();
  service = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
function start(
  open = (key: string) =>
    Promise.resolve({ body: Readable.from([Buffer.from(key)]) }),
  limits?: any,
) {
  dir = fs.mkdtempSync(path.join(root, "case-"));
  service = new ContentBundles(dir, open, limits);
  return service;
}
const file = { key: "a".repeat(20) + ".pdf", path: "附件/凭证.pdf" };
async function wait(id: string) {
  for (let i = 0; i < 500; i++) {
    const job = service!.get(id, "owner/app", "user");
    if (job.state === "completed" || job.state === "failed") return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("timeout");
}
function entries(
  zip: string,
): Promise<Array<{ name: string; method: number; body: Buffer }>> {
  return new Promise((resolve, reject) => {
    yauzl.open(zip, { lazyEntries: true }, (err, z) => {
      if (err || !z) return reject(err);
      const result: any[] = [];
      z.on("error", reject);
      z.on("entry", (e) => {
        z.openReadStream(e, (err, s) => {
          if (err || !s) return reject(err);
          const chunks: Buffer[] = [];
          s.on("data", (b) => chunks.push(b));
          s.on("end", () => {
            result.push({
              name: e.fileName,
              method: e.compressionMethod,
              body: Buffer.concat(chunks),
            });
            z.readEntry();
          });
          s.on("error", reject);
        });
      });
      z.on("end", () => resolve(result));
      z.readEntry();
    });
  });
}
describe("server file bundles", () => {
  it.each([
    "../secret",
    "/absolute",
    "C:/file",
    "a\\b",
    "a//b",
    "a/./b",
    "a/../b",
    "a\u0000b",
  ])("rejects unsafe ZIP path %s", (name) =>
    expect(() => validateBundleFiles([{ ...file, path: name }])).toThrow(),
  );
  it("rejects URLs, server paths, oversized lists and conflicting paths", () => {
    for (const key of [
      "https://example.com/a",
      "/etc/passwd",
      "other/app/" + file.key,
    ])
      expect(() => validateBundleFiles([{ ...file, key }])).toThrow();
    expect(() => validateBundleFiles(Array(1001).fill(file))).toThrow();
    for (const p of ["附件/凭证.PDF", "附件/凭证.pdf/child"])
      expect(() => validateBundleFiles([file, { ...file, path: p }])).toThrow();
  });
  it("streams Excel and 300 attachments into one ZIP with exact names and STORE compression", async () => {
    start();
    const files = [
      { key: "b".repeat(20) + ".xlsx", path: "汇总/导出.xlsx" },
      ...Array.from({ length: 300 }, (_, i) => ({
        ...file,
        path: `附件/${i}.pdf`,
      })),
    ];
    const job = service!.create(
      "owner/app",
      "user",
      files,
      "export-1",
      () => true,
    );
    expect(await wait(job.id)).toMatchObject({
      state: "completed",
      processedFiles: 301,
      totalFiles: 301,
    });
    const zip = await entries(
      service!.download(job.id, "owner/app", "user", () => true),
    );
    expect(zip.map((e) => e.name)).toEqual(files.map((f) => f.path));
    expect(zip.every((e) => e.method === 0)).toBe(true);
    expect(zip[0].body.toString()).toBe("owner/app/" + files[0].key);
  });
  it("blocks guessed keys and task access from another user or application", () => {
    start();
    expect(() =>
      service!.create("owner/app", "user", [file], "denied", () => false),
    ).toThrow("无权");
    const job = service!.create("owner/app", "user", [file], "ok", () => true);
    expect(() => service!.get(job.id, "owner/app", "other")).toThrow();
    expect(() => service!.get(job.id, "other/app", "user")).toThrow();
  });
  it("requires uploader identity for nonowners, with legacy files only available to owner", () => {
    start();
    expect(canExportFile(dir, file.key, "user", "owner")).toBe(false);
    recordFileUploader(dir, file.key, "user");
    expect(canExportFile(dir, file.key, "user", "owner")).toBe(true);
    expect(canExportFile(dir, file.key, "other", "owner")).toBe(false);
    expect(canExportFile(dir, file.key, "owner", "owner")).toBe(true);
  });
  it("deduplicates retries and rejects conflicting idempotency keys", () => {
    start();
    const job = service!.create(
      "owner/app",
      "user",
      [file],
      "retry",
      () => true,
    );
    expect(
      service!.create("owner/app", "user", [file], "retry", () => true).id,
    ).toBe(job.id);
    expect(() =>
      service!.create(
        "owner/app",
        "user",
        [{ ...file, path: "other.pdf" }],
        "retry",
        () => true,
      ),
    ).toThrow("不同");
  });
  it("fails the whole ZIP with the exact missing file, never a partial download", async () => {
    start(async () => null as any);
    const job = service!.create(
      "owner/app",
      "user",
      [file],
      "missing",
      () => true,
    );
    expect(await wait(job.id)).toMatchObject({
      state: "failed",
      processedFiles: 0,
      failedFile: file,
    });
    expect(() =>
      service!.download(job.id, "owner/app", "user", () => true),
    ).toThrow("尚未完成");
    expect(fs.existsSync(path.join(dir, job.id + ".part"))).toBe(false);
  });
  it("enforces streamed byte limits", async () => {
    start(undefined, {
      maxBytes: 1,
      maxActive: 1,
      maxPending: 2,
      ttlMs: 10000,
    });
    const job = service!.create(
      "owner/app",
      "user",
      [file],
      "size",
      () => true,
    );
    expect(await wait(job.id)).toMatchObject({
      state: "failed",
      failedFile: file,
    });
  });
  it("enforces queue limits, restores metadata and rechecks download permission", async () => {
    start(undefined, {
      maxBytes: 1000,
      maxActive: 1,
      maxPending: 1,
      ttlMs: 10000,
    });
    const job = service!.create(
      "owner/app",
      "user",
      [file],
      "persist",
      () => true,
    );
    expect(() =>
      service!.create("owner/app", "user", [file], "extra", () => true),
    ).toThrow("过多");
    await wait(job.id);
    expect(() =>
      service!.download(job.id, "owner/app", "user", () => false),
    ).toThrow("权限");
    await service!.close();
    service = new ContentBundles(dir, async () => null);
    expect(service.get(job.id, "owner/app", "user").state).toBe("completed");
  });
  it("cleans expired files and metadata", async () => {
    start(undefined, {
      maxBytes: 1000,
      maxActive: 1,
      maxPending: 1,
      ttlMs: 100,
    });
    const job = service!.create(
      "owner/app",
      "user",
      [file],
      "expire",
      () => true,
    );
    await wait(job.id);
    await new Promise((r) => setTimeout(r, 110));
    expect(() => service!.get(job.id, "owner/app", "user")).toThrow("过期");
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("restart and stream failure behavior", () => {
  it("marks interrupted jobs failed rather than leaving them running forever", async () => {
    start();
    const id = "12345678-1234-1234-1234-123456789012";
    fs.writeFileSync(
      path.join(dir, id + ".json"),
      JSON.stringify({
        id,
        user: "user",
        scope: "owner/app",
        files: [file],
        fingerprint: "x",
        idempotencyKey: "interrupted",
        state: "running",
        processedFiles: 0,
        totalFiles: 1,
        createdAt: Date.now(),
        expiresAt: Date.now() + 10000,
      }),
    );
    await service!.close();
    service = new ContentBundles(dir, async () => null);
    expect(service.get(id, "owner/app", "user")).toMatchObject({
      state: "failed",
    });
  });
  it("does not silently skip a failing input stream", async () => {
    start(async () => ({
      body: Readable.from(
        (async function* () {
          yield Buffer.from("partial");
          throw Error("storage disconnected");
        })(),
      ),
    }));
    const job = service!.create(
      "owner/app",
      "user",
      [file],
      "stream-error",
      () => true,
    );
    expect(await wait(job.id)).toMatchObject({
      state: "failed",
      processedFiles: 0,
      failedFile: file,
    });
    expect(fs.existsSync(path.join(dir, job.id + ".zip"))).toBe(false);
  });
  it("limits concurrent running jobs", async () => {
    let peak = 0,
      active = 0;
    start(
      async () => ({
        body: Readable.from(
          (async function* () {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 20));
            yield Buffer.from("data");
            active--;
          })(),
        ),
      }),
      { maxBytes: 1000, maxActive: 1, maxPending: 5, ttlMs: 10000 },
    );
    const jobs = Array.from({ length: 3 }, (_, i) =>
      service!.create("owner/app", "user", [file], "job-" + i, () => true),
    );
    await Promise.all(jobs.map((j) => wait(j.id)));
    expect(peak).toBe(1);
  });
});

it("enforces total retained ZIP size and frees failed partial output quota", async () => {
  let attempt = 0;
  start(
    async () => ({
      body: Readable.from([Buffer.alloc(++attempt === 1 ? 500 : 1)]),
    }),
    {
      maxBytes: 1000,
      maxActive: 1,
      maxPending: 2,
      ttlMs: 10000,
      maxStoredBytes: 400,
    },
  );
  const first = service!.create(
    "owner/app",
    "user",
    [file],
    "quota-1",
    () => true,
  );
  expect(await wait(first.id)).toMatchObject({
    state: "failed",
    failedFile: file,
  });
  const second = service!.create(
    "owner/app",
    "user",
    [file],
    "quota-2",
    () => true,
  );
  expect(await wait(second.id)).toMatchObject({ state: "completed" });
});
