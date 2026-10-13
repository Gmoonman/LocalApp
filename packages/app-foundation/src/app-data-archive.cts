import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import type { StoredObjectInfo } from "./content-storage.cjs";
import { AppDataError } from "./app-data-errors.cjs";
import { computeSchemaFingerprint } from "./app-data-schema.cjs";

export type ArchiveLimits = {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxFileEntries: number;
};

export type AppDataArchiveManifest = {
  format: "localapp-app-data";
  formatVersion: 1;
  createdAt: string;
  application: { owner: string; name: string; version: number };
  sourceApplication?: { owner: string; name: string };
  database: { path: "database/app.db"; size: number; sha256: string; schemaFingerprint: string };
  files: Array<{ path: string; objectKey: string; sourceObjectKey?: string; contentType?: string; size: number; sha256: string }>;
};

type ExtractedEntry = { path: string; size: number; sha256: string };
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
type ArchiveWriter = NodeJS.ReadWriteStream & {
  append(source: Buffer | Readable, data: { name: string; date: Date; mode: number }): ArchiveWriter;
  finalize(): Promise<void>;
  abort(): ArchiveWriter;
  on(event: "entry", listener: (entry: { name: string }) => void): ArchiveWriter;
  on(event: "error", listener: (error: Error) => void): ArchiveWriter;
  off(event: "entry", listener: (entry: { name: string }) => void): ArchiveWriter;
  off(event: "error", listener: (error: Error) => void): ArchiveWriter;
};

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function appObjectKeyAllowed(key: string, owner: string, appName: string): boolean {
  if (key.startsWith("/") || key.includes("\\") || path.posix.normalize(key) !== key || key.split("/").some((segment) => segment === "." || segment === "..")) {
    return false;
  }
  return key.startsWith(`${owner}/${appName}/`) || key.startsWith(`issues/${owner}/${appName}/`);
}

function rebaseAppObjectKey(key: string, source: { owner: string; name: string }, target: { owner: string; name: string }): string {
  const appPrefix = `${source.owner}/${source.name}/`;
  const issuePrefix = `issues/${source.owner}/${source.name}/`;
  if (key.startsWith(appPrefix)) return `${target.owner}/${target.name}/${key.slice(appPrefix.length)}`;
  if (key.startsWith(issuePrefix)) return `issues/${target.owner}/${target.name}/${key.slice(issuePrefix.length)}`;
  throw new AppDataError("APP_ARCHIVE_OBJECT_KEY_INVALID", `Object key is outside the application namespace: ${key}`);
}

function waitForArchiveEntry(archive: ArchiveWriter, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: { name: string }) => {
      if (entry.name !== name) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
    };
    archive.on("entry", onEntry);
    archive.on("error", onError);
  });
}

async function appendArchiveEntry(archive: ArchiveWriter, source: Buffer | Readable, name: string): Promise<void> {
  const completed = waitForArchiveEntry(archive, name);
  archive.append(source, { name, date: new Date(0), mode: 0o600 });
  await completed;
}

export async function createDataArchive(input: {
  outputPath: string;
  databasePath: string;
  application: { owner: string; name: string; version: number };
  sourceApplication?: { owner: string; name: string };
  objects: StoredObjectInfo[];
  openObject: (key: string) => Promise<{ body: Readable; contentType?: string } | null>;
  limits: ArchiveLimits;
}): Promise<{ manifest: AppDataArchiveManifest; archiveSize: number }> {
  if (input.objects.length > input.limits.maxFileEntries) {
    throw new AppDataError("APP_ARCHIVE_LIMIT_EXCEEDED", "Application file count exceeds archive limit");
  }
  const databaseSize = fs.statSync(input.databasePath).size;
  let expandedBytes = databaseSize;
  if (expandedBytes > input.limits.maxExpandedBytes) {
    throw new AppDataError("APP_ARCHIVE_LIMIT_EXCEEDED", "Application data exceeds expanded archive limit");
  }
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  const { ZipArchive } = await import("archiver");
  const output = fs.createWriteStream(input.outputPath, { mode: 0o600 });
  const archive = new ZipArchive({ forceZip64: true, zlib: { level: 6 } }) as ArchiveWriter;
  const closed = new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(output);

  try {
  const databaseEntry = {
      path: "database/app.db" as const,
      size: databaseSize,
      sha256: await hashFile(input.databasePath),
      schemaFingerprint: await computeSchemaFingerprint(input.databasePath),
    };
    await appendArchiveEntry(archive, fs.createReadStream(input.databasePath), databaseEntry.path);

    const files: AppDataArchiveManifest["files"] = [];
    const sourceApplication = input.sourceApplication ?? input.application;
    const rebasedKeys = new Set<string>();
    for (const [index, object] of [...input.objects].sort((left, right) => left.key.localeCompare(right.key)).entries()) {
      if (!appObjectKeyAllowed(object.key, sourceApplication.owner, sourceApplication.name)) {
        throw new AppDataError("APP_ARCHIVE_OBJECT_KEY_INVALID", `Object key is outside the application namespace: ${object.key}`);
      }
      const objectKey = rebaseAppObjectKey(object.key, sourceApplication, input.application);
      if (rebasedKeys.has(objectKey)) throw new AppDataError("APP_ARCHIVE_OBJECT_KEY_INVALID", `Multiple source objects map to the same target key: ${objectKey}`);
      rebasedKeys.add(objectKey);
      expandedBytes += object.size;
      if (expandedBytes > input.limits.maxExpandedBytes) {
        throw new AppDataError("APP_ARCHIVE_LIMIT_EXCEEDED", "Application data exceeds expanded archive limit");
      }
      const stored = await input.openObject(object.key);
      if (!stored) throw new AppDataError("APP_ARCHIVE_OBJECT_MISSING", `Application file is missing: ${object.key}`);
      const entryPath = `files/${String(index + 1).padStart(6, "0")}`;
      const hash = crypto.createHash("sha256");
      let actualSize = 0;
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          actualSize += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      stored.body.pipe(hashing);
      await appendArchiveEntry(archive, hashing, entryPath);
      if (actualSize !== object.size) {
        throw new AppDataError("APP_ARCHIVE_OBJECT_SIZE_MISMATCH", `Application file changed during export: ${object.key}`);
      }
      files.push({
        path: entryPath,
        objectKey,
        ...(objectKey !== object.key ? { sourceObjectKey: object.key } : {}),
        ...(stored.contentType || object.contentType ? { contentType: stored.contentType ?? object.contentType } : {}),
        size: actualSize,
        sha256: hash.digest("hex"),
      });
    }

    const manifest: AppDataArchiveManifest = {
      format: "localapp-app-data",
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      application: input.application,
      ...(sourceApplication.owner !== input.application.owner || sourceApplication.name !== input.application.name
        ? { sourceApplication }
        : {}),
      database: databaseEntry,
      files,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    expandedBytes += manifestBytes.length;
    if (expandedBytes > input.limits.maxExpandedBytes) {
      throw new AppDataError("APP_ARCHIVE_LIMIT_EXCEEDED", "Application data exceeds expanded archive limit");
    }
    await appendArchiveEntry(archive, manifestBytes, "localapp-data.json");
    await archive.finalize();
    await closed;
    const archiveSize = fs.statSync(input.outputPath).size;
    if (archiveSize > input.limits.maxCompressedBytes) {
      throw new AppDataError("APP_ARCHIVE_LIMIT_EXCEEDED", "Compressed archive exceeds size limit");
    }
    return { manifest, archiveSize };
  } catch (caught) {
    archive.abort();
    output.destroy();
    await closed.catch(() => undefined);
    fs.rmSync(input.outputPath, { force: true });
    throw caught;
  }
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true, autoClose: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error("Cannot open ZIP archive"));
      else resolve(zipFile);
    });
  });
}

function openEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("Cannot read ZIP entry"));
      else resolve(stream);
    });
  });
}

function assertEntryPath(name: string): void {
  if (name.includes("\\") || name.startsWith("/") || name.endsWith("/") || path.posix.normalize(name) !== name || name.split("/").includes("..")) {
    throw new AppDataError("APP_ARCHIVE_INVALID_PATH", `Invalid archive entry path: ${name}`);
  }
  if (name !== "localapp-data.json" && name !== "database/app.db" && !/^files\/\d{6}$/.test(name)) {
    throw new AppDataError("APP_ARCHIVE_INVALID_PATH", `Unexpected archive entry path: ${name}`);
  }
}

function stagingPath(stagingDir: string, entryName: string): string {
  const root = path.resolve(stagingDir);
  const resolved = path.resolve(root, entryName);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new AppDataError("APP_ARCHIVE_INVALID_PATH", `Invalid archive entry path: ${entryName}`);
  }
  return resolved;
}

async function extractEntries(zipFile: yauzl.ZipFile, stagingDir: string, limits: ArchiveLimits): Promise<Map<string, ExtractedEntry>> {
  const extracted = new Map<string, ExtractedEntry>();
  let expandedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const fail = (caught: unknown) => {
      zipFile.close();
      reject(caught);
    };
    zipFile.on("error", (error) => {
      const message = error.message.toLowerCase();
      fail(message.includes("invalid relative path")
        ? new AppDataError("APP_ARCHIVE_INVALID_PATH", error.message)
        : new AppDataError("APP_ARCHIVE_INVALID", error.message));
    });
    zipFile.on("end", resolve);
    zipFile.on("entry", (entry) => {
      void (async () => {
        assertEntryPath(entry.fileName);
        if (extracted.has(entry.fileName)) {
          throw new AppDataError("APP_ARCHIVE_DUPLICATE_ENTRY", `Duplicate archive entry: ${entry.fileName}`);
        }
        if (extracted.size >= limits.maxFileEntries + 2) {
          throw new AppDataError("APP_ARCHIVE_LIMIT_EXCEEDED", "Archive contains too many entries");
        }
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > limits.maxExpandedBytes) {
          throw new AppDataError("APP_ARCHIVE_LIMIT_EXCEEDED", "Expanded archive exceeds size limit");
        }
        const destination = stagingPath(stagingDir, entry.fileName);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const hash = crypto.createHash("sha256");
        let actualSize = 0;
        const hashing = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            actualSize += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        const source = await openEntry(zipFile, entry);
        await pipeline(source, hashing, fs.createWriteStream(destination, { mode: 0o600 }));
        extracted.set(entry.fileName, { path: destination, size: actualSize, sha256: hash.digest("hex") });
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.readEntry();
  });
  return extracted;
}

function parseManifest(filePath: string): AppDataArchiveManifest {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new AppDataError("APP_ARCHIVE_MANIFEST_INVALID", "Archive manifest is not valid JSON");
  }
  if (!value || typeof value !== "object") throw new AppDataError("APP_ARCHIVE_MANIFEST_INVALID", "Archive manifest is invalid");
  const manifest = value as AppDataArchiveManifest;
  if (manifest.format !== "localapp-app-data" || manifest.formatVersion !== 1 || !manifest.application || !manifest.database || !Array.isArray(manifest.files)) {
    throw new AppDataError("APP_ARCHIVE_FORMAT_UNSUPPORTED", "Unsupported application data archive format");
  }
  return manifest;
}

function assertEntryMatches(entry: ExtractedEntry | undefined, expected: { size: number; sha256: string }, label: string): ExtractedEntry {
  if (!entry) throw new AppDataError("APP_ARCHIVE_ENTRY_MISSING", `Archive entry is missing: ${label}`);
  if (entry.size !== expected.size || entry.sha256 !== expected.sha256) {
    throw new AppDataError("APP_ARCHIVE_HASH_MISMATCH", `Archive entry failed integrity validation: ${label}`);
  }
  return entry;
}

export async function extractAndValidateDataArchive(input: {
  archivePath: string;
  stagingDir: string;
  expectedApplication: { owner: string; name: string; maxVersion?: number };
  limits: ArchiveLimits;
}): Promise<{ manifest: AppDataArchiveManifest; databasePath: string; files: Array<{ path: string; objectKey: string; contentType?: string }> }> {
  if (fs.statSync(input.archivePath).size > input.limits.maxCompressedBytes) {
    throw new AppDataError("APP_ARCHIVE_LIMIT_EXCEEDED", "Compressed archive exceeds size limit");
  }
  fs.rmSync(input.stagingDir, { recursive: true, force: true });
  fs.mkdirSync(input.stagingDir, { recursive: true });
  try {
    const extracted = await extractEntries(await openZip(input.archivePath), input.stagingDir, input.limits);
    const manifestEntry = extracted.get("localapp-data.json");
    if (!manifestEntry) throw new AppDataError("APP_ARCHIVE_ENTRY_MISSING", "Archive manifest is missing");
    if (manifestEntry.size > MAX_MANIFEST_BYTES) throw new AppDataError("APP_ARCHIVE_LIMIT_EXCEEDED", "Archive manifest exceeds size limit");
    const manifest = parseManifest(manifestEntry.path);
    if (manifest.application.owner !== input.expectedApplication.owner || manifest.application.name !== input.expectedApplication.name) {
      throw new AppDataError("APP_ARCHIVE_IDENTITY_MISMATCH", "Data archive belongs to another application");
    }
    if (manifest.database.path !== "database/app.db") {
      throw new AppDataError("APP_ARCHIVE_MANIFEST_INVALID", "Archive database path is invalid");
    }
    if (manifest.files.length > input.limits.maxFileEntries) {
      throw new AppDataError("APP_ARCHIVE_LIMIT_EXCEEDED", "Archive manifest contains too many files");
    }
    const database = assertEntryMatches(extracted.get(manifest.database.path), manifest.database, manifest.database.path);
    const expectedEntries = new Set(["localapp-data.json", manifest.database.path]);
    const objectKeys = new Set<string>();
    const filePaths = new Set<string>();
    const files = manifest.files.map((file) => {
      if (!/^files\/\d{6}$/.test(file.path) || !appObjectKeyAllowed(file.objectKey, manifest.application.owner, manifest.application.name)) {
        throw new AppDataError("APP_ARCHIVE_OBJECT_KEY_INVALID", `Archive object mapping is invalid: ${file.objectKey}`);
      }
      if (objectKeys.has(file.objectKey)) throw new AppDataError("APP_ARCHIVE_MANIFEST_INVALID", `Duplicate object key: ${file.objectKey}`);
      if (file.sourceObjectKey !== undefined) {
        const source = manifest.sourceApplication;
        if (!source || !appObjectKeyAllowed(file.sourceObjectKey, source.owner, source.name)) {
          throw new AppDataError("APP_ARCHIVE_OBJECT_KEY_INVALID", `Archive source object mapping is invalid: ${file.sourceObjectKey}`);
        }
      }
      if (filePaths.has(file.path)) throw new AppDataError("APP_ARCHIVE_MANIFEST_INVALID", `Duplicate file path: ${file.path}`);
      objectKeys.add(file.objectKey);
      filePaths.add(file.path);
      expectedEntries.add(file.path);
      const entry = assertEntryMatches(extracted.get(file.path), file, file.path);
      return {
        path: entry.path,
        objectKey: file.objectKey,
        ...(file.sourceObjectKey ? { sourceObjectKey: file.sourceObjectKey } : {}),
        ...(file.contentType ? { contentType: file.contentType } : {}),
      };
    });
    for (const entryName of extracted.keys()) {
      if (!expectedEntries.has(entryName)) throw new AppDataError("APP_ARCHIVE_UNDECLARED_ENTRY", `Archive entry is not declared: ${entryName}`);
    }
    if (await computeSchemaFingerprint(database.path) !== manifest.database.schemaFingerprint) {
      throw new AppDataError("APP_ARCHIVE_SCHEMA_FINGERPRINT_MISMATCH", "Archive database schema fingerprint does not match its manifest");
    }
    return { manifest, databasePath: database.path, files };
  } catch (caught) {
    fs.rmSync(input.stagingDir, { recursive: true, force: true });
    if (caught instanceof AppDataError) throw caught;
    throw new AppDataError("APP_ARCHIVE_INVALID", caught instanceof Error ? caught.message : String(caught));
  }
}
