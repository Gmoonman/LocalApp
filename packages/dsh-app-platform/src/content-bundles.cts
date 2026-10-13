import { PLATFORM_CAPABILITIES } from "./platform-capabilities.cjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import type { ZipArchive as ZipWriter } from "archiver" with { "resolution-mode": "import" };
import { finished } from "node:stream/promises";

export type BundleFile = { key: string; path: string };
export type BundleJob = {
  id: string;
  state: "queued" | "running" | "completed" | "failed";
  processedFiles: number;
  totalFiles: number;
  createdAt: number;
  expiresAt: number;
  error?: string;
  failedFile?: BundleFile;
};
type StoredJob = BundleJob & {
  user: string;
  scope: string;
  files: BundleFile[];
  fingerprint: string;
  idempotencyKey: string;
  objectKeys?: string[][];
};
export class BundleError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function validateBundleFiles(
  value: unknown,
  max = PLATFORM_CAPABILITIES.content.bundles.maxFiles,
): BundleFile[] {
  if (!Array.isArray(value) || !value.length || value.length > max)
    throw new BundleError(400, `文件清单必须包含 1–${max} 项`);
  const names = new Set<string>();
  return value.map((item, index) => {
    if (
      !item ||
      typeof item.key !== "string" ||
      !/^[0-9a-f]{20}\.[a-z0-9]+$/i.test(item.key)
    )
      throw new BundleError(400, `第 ${index + 1} 项必须是平台文件 key`);
    const name =
      typeof item.path === "string" ? item.path.normalize("NFC") : "";
    const parts = name.split("/");
    if (
      !name ||
      Buffer.byteLength(name) > 1024 ||
      /[\\:\x00-\x1f\x7f]/.test(name) ||
      parts.some(
        (p: string) => !p || p === "." || p === ".." || /[. ]$/.test(p),
      )
    )
      throw new BundleError(400, `ZIP 路径无效：${item.path}`);
    const canonical = name.toLowerCase();
    if (
      names.has(canonical) ||
      [...names].some(
        (n) => n.startsWith(`${canonical}/`) || canonical.startsWith(`${n}/`),
      )
    )
      throw new BundleError(400, `ZIP 路径重名或冲突：${name}`);
    names.add(canonical);
    return { key: item.key, path: name };
  });
}
export function recordFileUploader(
  pageDir: string,
  key: string,
  user: string,
): void {
  const dir = path.join(pageDir, ".content-access");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key + ".json"), JSON.stringify({ user }), {
    mode: 0o600,
  });
}
export function canExportFile(
  pageDir: string,
  key: string,
  user: string,
  owner: string,
): boolean {
  if (!/^[0-9a-f]{20}\.[a-z0-9]+$/i.test(key)) return false;
  if (user === owner) return true;
  try {
    return (
      JSON.parse(
        fs.readFileSync(
          path.join(pageDir, ".content-access", key + ".json"),
          "utf8",
        ),
      ).user === user
    );
  } catch {
    return false;
  }
}
type BundleLimits = {
  maxBytes: number;
  maxActive: number;
  maxPending: number;
  ttlMs: number;
  maxStoredBytes?: number;
};
export class ContentBundles {
  private jobs = new Map<string, StoredJob>();
  private active = 0;
  private storedBytes = 0;
  private running = new Set<Promise<void>>();
  private stopped = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private root: string,
    private open: (key: string) => Promise<{ body: Readable } | null>,
    private limits: BundleLimits = {
      maxBytes: PLATFORM_CAPABILITIES.content.bundles.maxBytes as number,
      maxActive: PLATFORM_CAPABILITIES.content.bundles.maxConcurrent as number,
      maxPending: PLATFORM_CAPABILITIES.content.bundles.maxPending as number,
      ttlMs: PLATFORM_CAPABILITIES.content.bundles.retentionSeconds * 1000,
    },
  ) {
    fs.mkdirSync(root, { recursive: true });
    for (const name of fs
      .readdirSync(root)
      .filter((n) => /^[\da-f-]+\.json$/.test(n))) {
      try {
        const job: StoredJob = JSON.parse(
          fs.readFileSync(path.join(root, name), "utf8"),
        );
        if (job.id + ".json" !== name) continue;
        if (job.state === "running" || job.state === "queued") {
          job.state = "failed";
          job.error = "服务器重启中断任务，请使用新的幂等键重试";
          fs.rmSync(path.join(root, job.id + ".part"), { force: true });
        }
        this.jobs.set(job.id, job);
        this.save(job);
      } catch {
        /* corrupt metadata is not exposed */
      }
    }
    for (const job of this.jobs.values()) {
      const file = path.join(root, job.id + ".zip");
      if (fs.existsSync(file)) this.storedBytes += fs.statSync(file).size;
    }
    this.cleanup();
    this.timer = setInterval(() => this.cleanup(), 60_000);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.running]);
  }
  private save(job: StoredJob) {
    const target = path.join(this.root, job.id + ".json");
    fs.writeFileSync(target + ".tmp", JSON.stringify(job), { mode: 0o600 });
    fs.renameSync(target + ".tmp", target);
  }
  private public(job: StoredJob): BundleJob {
    const {
      user,
      scope,
      files,
      fingerprint,
      idempotencyKey,
      objectKeys,
      ...result
    } = job;
    return result;
  }
  get(id: string, scope: string, user: string): BundleJob {
    this.cleanup();
    const job = this.jobs.get(id);
    if (!job || job.scope !== scope || job.user !== user)
      throw new BundleError(404, "打包任务不存在或已过期");
    return this.public(job);
  }
  download(
    id: string,
    scope: string,
    user: string,
    authorize: (file: BundleFile) => boolean,
  ): string {
    this.get(id, scope, user);
    const job = this.jobs.get(id)!;
    if (job.state !== "completed")
      throw new BundleError(409, "打包任务尚未完成");
    for (const file of job.files)
      if (!authorize(file))
        throw new BundleError(403, `文件读取权限已失效：${file.key}`);
    return path.join(this.root, id + ".zip");
  }
  create(
    scope: string,
    user: string,
    value: unknown,
    idempotencyKey: unknown,
    authorize: (file: BundleFile) => boolean,
    objectKeys?: string[][],
  ): BundleJob {
    if (this.stopped) throw new BundleError(503, "服务器正在停止，请稍后重试");
    this.cleanup();
    const files = validateBundleFiles(value);
    if (
      typeof idempotencyKey !== "string" ||
      !/^[\w.-]{1,128}$/.test(idempotencyKey)
    )
      throw new BundleError(400, "需要 1–128 字符的幂等键");
    for (const file of files)
      if (!authorize(file))
        throw new BundleError(403, `无权读取文件：${file.key}`);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ files, objectKeys }))
      .digest("hex");
    const old = [...this.jobs.values()].find(
      (j) =>
        j.scope === scope &&
        j.user === user &&
        j.idempotencyKey === idempotencyKey,
    );
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new BundleError(409, "同一幂等键不能用于不同文件清单");
      return this.public(old);
    }
    const pending = [...this.jobs.values()].filter(
      (j) => j.state === "queued" || j.state === "running",
    );
    if (
      pending.length >= this.limits.maxPending ||
      pending.filter((j) => j.user === user).length >= 3 ||
      this.jobs.size >= 200
    )
      throw new BundleError(429, "打包任务过多，请稍后重试");
    const now = Date.now();
    const job: StoredJob = {
      id: randomUUID(),
      user,
      scope,
      files,
      objectKeys,
      fingerprint,
      idempotencyKey,
      state: "queued",
      processedFiles: 0,
      totalFiles: files.length,
      createdAt: now,
      expiresAt: now + this.limits.ttlMs,
    };
    this.jobs.set(job.id, job);
    this.save(job);
    queueMicrotask(() => this.pump());
    return this.public(job);
  }
  private cleanup() {
    for (const [id, job] of this.jobs)
      if (job.expiresAt <= Date.now() && job.state !== "running") {
        this.jobs.delete(id);
        const archive = path.join(this.root, id + ".zip");
        if (fs.existsSync(archive))
          this.storedBytes -= fs.statSync(archive).size;
        for (const ext of [".json", ".zip", ".part"])
          fs.rmSync(path.join(this.root, id + ext), { force: true });
      }
  }
  private pump() {
    if (this.stopped) return;
    while (this.active < this.limits.maxActive) {
      const job = [...this.jobs.values()].find((j) => j.state === "queued");
      if (!job) return;
      job.state = "running";
      this.save(job);
      this.active++;
      const run = this.run(job).finally(() => {
        this.active--;
        this.running.delete(run);
        this.pump();
      });
      this.running.add(run);
      run.catch(() => {});
    }
  }
  private async openWithTimeout(key: string) {
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error("文件存储连接超时"));
      }, 60_000);
      timer.unref();
    });
    try {
      return await Promise.race([
        this.open(key).then((result) => {
          if (expired) {
            result?.body.destroy();
            return null;
          }
          return result;
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  private async run(job: StoredJob) {
    const target = path.join(this.root, job.id + ".part");
    let archive: ZipWriter | undefined;
    let output: fs.WriteStream | undefined;
    let bytes = 0;
    let writtenBytes = 0;
    const account = (chunk: Buffer) => {
      writtenBytes += chunk.length;
      this.storedBytes += chunk.length;
      if (this.storedBytes > (this.limits.maxStoredBytes ?? 8 * 1024 ** 3))
        output!.destroy(
          new Error("平台打包产物总容量超过限制，请等待过期清理后重试"),
        );
    };
    let current: BundleFile | undefined;
    try {
      const { ZipArchive } = await import("archiver");
      archive = new ZipArchive({ forceZip64: true, zlib: { level: 6 } });
      output = fs.createWriteStream(target, { mode: 0o600 });
      const complete = finished(output);
      complete.catch(() => {});
      archive.on("error", (error: Error) => output!.destroy(error));
      archive.on("warning", (error: Error) => output!.destroy(error));
      archive.on("data", account);
      archive.pipe(output);
      for (const file of job.files) {
        current = file;
        let source: { body: Readable } | null = null;
        const candidates = job.objectKeys?.[job.processedFiles] ?? [
          `${job.scope}/${file.key}`,
        ];
        for (const objectKey of candidates) {
          source = await this.openWithTimeout(objectKey);
          if (source) break;
        }
        if (!source) throw new Error("文件不存在");
        const counter = new Transform({
          transform(chunk, _encoding, done) {
            bytes += chunk.length;
            done(
              bytes > thisLimit ? new Error("文件总大小超过限制") : null,
              chunk,
            );
          },
        });
        const thisLimit = this.limits.maxBytes;
        source.body.on("error", (error) => counter.destroy(error));
        counter.on("error", (error) => output!.destroy(error));
        source.body.pipe(counter);
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => fail(new Error("文件读取超时")),
              300_000,
            );
            timeout.unref();
            const fail = (e: Error) => {
              clean();
              reject(e);
            };
            const entry = () => {
              clean();
              resolve();
            };
            const clean = () => {
              clearTimeout(timeout);
              archive!.off("entry", entry);
              output!.off("error", fail);
              counter.off("error", fail);
            };
            archive!.once("entry", entry);
            output!.once("error", fail);
            counter.once("error", fail);
            archive!.append(counter, {
              name: file.path,
              store:
                /\.(png|jpe?g|gif|webp|pdf|xlsx|docx|pptx|zip|gz|mp[34])$/i.test(
                  file.key,
                ),
            });
          });
        } finally {
          source.body.destroy();
          counter.destroy();
        }
        job.processedFiles++;
        this.save(job);
      }
      await archive.finalize();
      await complete;
      fs.renameSync(target, path.join(this.root, job.id + ".zip"));
      job.state = "completed";
    } catch (error) {
      archive?.off("data", account);
      archive?.abort();
      this.storedBytes -= writtenBytes;
      output?.destroy();
      if (output) await finished(output).catch(() => {});
      fs.rmSync(target, { force: true });
      job.state = "failed";
      job.failedFile = current;
      job.error = `${current?.key ?? "ZIP"} (${current?.path ?? ""})：${error instanceof Error ? error.message : "打包失败"}`;
    }
    archive?.off("data", account);
    this.save(job);
  }
}
