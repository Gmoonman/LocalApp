import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { validateName } from "./validate-name.cjs";

export const APP_PACKAGE_SCHEMA_VERSION = 1;
export const MAX_APP_PACKAGE_ENTRIES = 10_000;
export const MAX_APP_PACKAGE_ENTRY_BYTES = 128 * 1024 * 1024;
export const MAX_APP_PACKAGE_BYTES = 512 * 1024 * 1024;

const METADATA_PATHS = new Set(["package.json", "checksums.json"]);
const FIXED_ARCHIVE_DATE = new Date("1980-01-01T00:00:00.000Z");

export interface AppPackageMetadata {
  schemaVersion: number;
  appId: string;
  version: string;
  platformVersion: string;
}

export interface PackageEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface InspectedAppPackage {
  packagePath: string;
  name: string;
  version: string;
  digest: string;
  manifest: Record<string, unknown>;
  entries: readonly PackageEntry[];
  metadata: AppPackageMetadata;
}

export interface PortablePackageFile {
  path: string;
  content: Buffer;
}

export class AppPackageValidationError extends Error {
  readonly code = "APP_PACKAGE_INVALID";

  constructor(message: string, public readonly path?: string) {
    super(message);
    this.name = "AppPackageValidationError";
  }
}

type ActualEntry = PackageEntry & { metadataBytes?: Buffer };
type ArchiveWriter = NodeJS.ReadWriteStream & {
  append(source: Buffer | Readable, data: { name: string; date: Date; mode: number }): ArchiveWriter;
  finalize(): Promise<void>;
  abort(): void;
};

export async function inspectAppPackage(filePath: string): Promise<InspectedAppPackage> {
  const packagePath = path.resolve(filePath);
  const stat = await fs.promises.stat(packagePath).catch((error: unknown) => {
    throw new AppPackageValidationError(`Cannot read application package: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!stat.isFile()) throw new AppPackageValidationError("Application package must be a regular file");
  if (stat.size > MAX_APP_PACKAGE_BYTES) {
    throw new AppPackageValidationError(`Application package exceeds ${MAX_APP_PACKAGE_BYTES} bytes`);
  }

  const [digest, actualEntries] = await Promise.all([
    sha256File(packagePath),
    readAndValidateArchive(packagePath),
  ]);
  const packageMetadata = parseJsonObject(requiredMetadata(actualEntries, "package.json"), "package.json");
  const metadata = validateMetadata(packageMetadata);
  const manifest = parseJsonObject(requiredMetadata(actualEntries, "manifest.json"), "manifest.json");
  if (manifest.name !== metadata.appId) {
    throw new AppPackageValidationError("manifest name does not match package appId", "manifest.json");
  }
  validateManifestBackendRoot(manifest, actualEntries);

  const checksumDocument = parseJsonObject(requiredMetadata(actualEntries, "checksums.json"), "checksums.json");
  const expectedEntries = validateChecksumDocument(checksumDocument);
  for (const [entryPath, actual] of actualEntries) {
    if (METADATA_PATHS.has(entryPath)) continue;
    const expected = expectedEntries.get(entryPath);
    if (!expected) throw new AppPackageValidationError(`Unexpected package file: ${entryPath}`, entryPath);
    if (expected.size !== actual.size || expected.sha256 !== actual.sha256) {
      throw new AppPackageValidationError(`Package checksum mismatch: ${entryPath}`, entryPath);
    }
  }
  for (const [entryPath, expected] of expectedEntries) {
    validatePublishablePath(entryPath, manifest);
    const actual = actualEntries.get(entryPath);
    if (!actual) throw new AppPackageValidationError(`Package file is missing: ${entryPath}`, entryPath);
    if (expected.size !== actual.size || expected.sha256 !== actual.sha256) {
      throw new AppPackageValidationError(`Package checksum mismatch: ${entryPath}`, entryPath);
    }
  }
  for (const required of ["manifest.json", "dist/index.html"]) {
    if (!expectedEntries.has(required)) {
      throw new AppPackageValidationError(`Package file is missing: ${required}`, required);
    }
  }

  return {
    packagePath,
    name: metadata.appId,
    version: metadata.version,
    digest,
    manifest,
    entries: [...expectedEntries.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([entryPath, entry]) => ({
      path: entryPath,
      size: entry.size,
      sha256: entry.sha256,
    })),
    metadata,
  };
}

export async function extractAppPackage(
  inspected: InspectedAppPackage,
  destination: string,
): Promise<void> {
  if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
    throw new AppPackageValidationError("Package extraction destination must be empty");
  }
  fs.mkdirSync(destination, { recursive: true });
  const allowed = new Map(inspected.entries.map((entry) => [entry.path, entry]));
  const zipFile = await openZip(inspected.packagePath);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      reject(asPackageError(error));
    };
    zipFile.on("error", fail);
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipFile.on("entry", (entry) => {
      void (async () => {
        assertArchiveEntry(entry);
        if (entry.fileName.endsWith("/") || METADATA_PATHS.has(entry.fileName)) {
          zipFile.readEntry();
          return;
        }
        const expected = allowed.get(entry.fileName);
        if (!expected) throw new AppPackageValidationError(`Unexpected package file: ${entry.fileName}`, entry.fileName);
        const target = safeDestination(destination, entry.fileName);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const source = await openEntry(zipFile, entry);
        const hash = crypto.createHash("sha256");
        let size = 0;
        const hashing = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(source, hashing, fs.createWriteStream(target, { flags: "wx", mode: 0o600 }));
        if (size !== expected.size || hash.digest("hex") !== expected.sha256) {
          throw new AppPackageValidationError(`Package checksum mismatch during extraction: ${entry.fileName}`, entry.fileName);
        }
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.readEntry();
  });
}

export async function writeAppPackage(input: {
  outputPath: string;
  metadata: AppPackageMetadata;
  files: readonly PortablePackageFile[];
}, operations: {
  afterOpen?(output: fs.WriteStream): void;
  afterCleanupOwnershipCheck?(): void;
} = {}): Promise<{ digest: string }> {
  const prepared = prepareAppPackage(input.metadata, input.files);
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  const output = fs.createWriteStream(input.outputPath, { flags: "wx", mode: 0o600 });
  let owned: { dev: bigint; ino: bigint } | undefined;
  output.once("open", (fd) => {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.isFile()) owned = { dev: stat.dev, ino: stat.ino };
  });
  try {
    return await writePreparedAppPackageToStream(output, prepared, () => {
      if (operations.afterOpen === undefined) return;
      if (owned !== undefined) operations.afterOpen(output);
      else output.once("open", () => operations.afterOpen?.(output));
    });
  } catch (error) {
    output.destroy();
    if (!output.closed) await once(output, "close").catch(() => undefined);
    try {
      retainFailedPackageOutput(input.outputPath, owned, operations.afterCleanupOwnershipCheck);
    } catch {
      // Cleanup observation must never replace the original writer error.
    }
    throw error;
  }
}

export async function writeAppPackageToStream(input: {
  output: Writable;
  metadata: AppPackageMetadata;
  files: readonly PortablePackageFile[];
}): Promise<{ digest: string }> {
  return writePreparedAppPackageToStream(input.output, prepareAppPackage(input.metadata, input.files));
}

interface PreparedAppPackage {
  files: readonly PortablePackageFile[];
  metadataBytes: Buffer;
  checksumBytes: Buffer;
}

function prepareAppPackage(metadata: AppPackageMetadata, inputFiles: readonly PortablePackageFile[]): PreparedAppPackage {
  validateMetadata(metadata as unknown as Record<string, unknown>);
  const files = [...inputFiles].sort((left, right) => left.path.localeCompare(right.path));
  const seen = new Set<string>();
  for (const file of files) {
    assertSafeArchivePath(file.path, false);
    if (seen.has(file.path)) throw new AppPackageValidationError(`Duplicate package file: ${file.path}`, file.path);
    seen.add(file.path);
  }
  const manifestFile = files.find((file) => file.path === "manifest.json");
  if (!manifestFile) throw new AppPackageValidationError("Package file is missing: manifest.json", "manifest.json");
  const manifest = parseJsonObject(manifestFile.content, "manifest.json");
  for (const file of files) validatePublishablePath(file.path, manifest);
  if (!seen.has("dist/index.html")) {
    throw new AppPackageValidationError("Package file is missing: dist/index.html", "dist/index.html");
  }

  const checksumFiles: Record<string, { sha256: string; size: number }> = {};
  for (const file of files) checksumFiles[file.path] = { sha256: sha256(file.content), size: file.content.length };
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata)}\n`);
  const checksumBytes = Buffer.from(`${JSON.stringify({ schemaVersion: APP_PACKAGE_SCHEMA_VERSION, files: checksumFiles })}\n`);
  return { files, metadataBytes, checksumBytes };
}

async function writePreparedAppPackageToStream(
  output: Writable,
  prepared: PreparedAppPackage,
  outputReady?: () => void,
): Promise<{ digest: string }> {
  const { ZipArchive } = await import("archiver");
  const hash = crypto.createHash("sha256");
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const archive = new ZipArchive({ zlib: { level: 9 } }) as ArchiveWriter;
  archive.on("error", (error: Error) => hashing.destroy(error));
  archive.pipe(hashing);
  const completed = pipeline(hashing, output);
  void completed.catch(() => undefined);
  outputReady?.();
  try {
    archive.append(prepared.metadataBytes, { name: "package.json", date: FIXED_ARCHIVE_DATE, mode: 0o644 });
    archive.append(prepared.checksumBytes, { name: "checksums.json", date: FIXED_ARCHIVE_DATE, mode: 0o644 });
    for (const file of prepared.files) archive.append(file.content, { name: file.path, date: FIXED_ARCHIVE_DATE, mode: 0o644 });
    await archive.finalize();
    await completed;
    return { digest: hash.digest("hex") };
  } catch (error) {
    archive.abort();
    output.destroy(error instanceof Error ? error : undefined);
    await completed.catch(() => undefined);
    throw error;
  }
}

function retainFailedPackageOutput(
  outputPath: string,
  owned: { dev: bigint; ino: bigint } | undefined,
  afterOwnershipCheck: (() => void) | undefined,
): void {
  if (owned === undefined) return;
  const current = fs.lstatSync(outputPath, { bigint: true, throwIfNoEntry: false });
  if (current?.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) {
    afterOwnershipCheck?.();
  }
  // Node has no descriptor-relative unlink. Retain the failed artifact rather
  // than let a check-then-path-unlink race delete another actor's replacement.
}

async function readAndValidateArchive(packagePath: string): Promise<Map<string, ActualEntry>> {
  const zipFile = await openZip(packagePath);
  if (zipFile.entryCount > MAX_APP_PACKAGE_ENTRIES) {
    zipFile.close();
    throw new AppPackageValidationError(`Application package contains more than ${MAX_APP_PACKAGE_ENTRIES} entries`);
  }
  const entries = new Map<string, ActualEntry>();
  const seen = new Set<string>();
  let expandedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      reject(asPackageError(error));
    };
    zipFile.on("error", fail);
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipFile.on("entry", (entry) => {
      void (async () => {
        assertArchiveEntry(entry);
        if (seen.has(entry.fileName)) {
          throw new AppPackageValidationError(`Duplicate package entry: ${entry.fileName}`, entry.fileName);
        }
        seen.add(entry.fileName);
        if (entry.uncompressedSize > MAX_APP_PACKAGE_ENTRY_BYTES) {
          throw new AppPackageValidationError(`Package entry exceeds size limit: ${entry.fileName}`, entry.fileName);
        }
        expandedBytes += entry.uncompressedSize;
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_APP_PACKAGE_BYTES) {
          throw new AppPackageValidationError("Expanded application package exceeds size limit");
        }
        if (entry.fileName.endsWith("/")) {
          zipFile.readEntry();
          return;
        }
        const source = await openEntry(zipFile, entry);
        const hash = crypto.createHash("sha256");
        const metadataChunks: Buffer[] = [];
        const capture = METADATA_PATHS.has(entry.fileName) || entry.fileName === "manifest.json";
        let size = 0;
        for await (const chunk of source) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_APP_PACKAGE_ENTRY_BYTES) {
            throw new AppPackageValidationError(`Package entry exceeds size limit: ${entry.fileName}`, entry.fileName);
          }
          hash.update(bytes);
          if (capture) metadataChunks.push(bytes);
        }
        entries.set(entry.fileName, {
          path: entry.fileName,
          size,
          sha256: hash.digest("hex"),
          ...(capture ? { metadataBytes: Buffer.concat(metadataChunks) } : {}),
        });
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.readEntry();
  });
  return entries;
}

function assertArchiveEntry(entry: yauzl.Entry): void {
  assertSafeArchivePath(entry.fileName, entry.fileName.endsWith("/"));
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new AppPackageValidationError(`Encrypted package entries are unsupported: ${entry.fileName}`, entry.fileName);
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new AppPackageValidationError(`Unsupported package compression method for ${entry.fileName}`, entry.fileName);
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000) {
    throw new AppPackageValidationError(`Symbolic links are unsupported in application packages: ${entry.fileName}`, entry.fileName);
  }
  if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    throw new AppPackageValidationError(`Unsupported package entry type: ${entry.fileName}`, entry.fileName);
  }
}

function assertSafeArchivePath(entryPath: string, allowDirectory: boolean): void {
  const candidate = allowDirectory && entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
  if (!candidate || entryPath.includes("\\") || entryPath.startsWith("/") || /^[A-Za-z]:/.test(entryPath)) {
    throw new AppPackageValidationError(`Unsafe package path: ${entryPath}`, entryPath);
  }
  const parts = candidate.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || path.posix.normalize(candidate) !== candidate) {
    throw new AppPackageValidationError(`Unsafe package path: ${entryPath}`, entryPath);
  }
}

function validatePublishablePath(entryPath: string, manifest: Record<string, unknown>): void {
  assertSafeArchivePath(entryPath, false);
  if (entryPath === "manifest.json" || entryPath.startsWith("dist/")) return;
  if (/^migrations\/[^/]+\.sql$/.test(entryPath)) return;
  const backend = manifest.backend;
  if (isRecord(backend)) {
    const root = typeof backend.root === "string" && backend.root ? backend.root : "backend";
    assertSafeArchivePath(root, false);
    if (entryPath.startsWith(`${root}/`) && entryPath.endsWith("/actions.manifest.json")) {
      throw new AppPackageValidationError(
        "Hosted actions are disabled; application packages support named SQL backend contracts only",
        entryPath,
      );
    }
    if (entryPath.startsWith(`${root}/`) && entryPath.endsWith(".json")) return;
  }
  throw new AppPackageValidationError(`Unsupported package file or backend file outside declared root: ${entryPath}`, entryPath);
}

function validateManifestBackendRoot(manifest: Record<string, unknown>, entries: Map<string, ActualEntry>): void {
  const backendPaths = [...entries.keys()].filter((entryPath) => entryPath.startsWith("backend/"));
  if (backendPaths.length === 0) return;
  const backend = manifest.backend;
  if (!isRecord(backend)) {
    throw new AppPackageValidationError("Package contains backend files but manifest does not declare a backend root", backendPaths[0]);
  }
  const root = typeof backend.root === "string" && backend.root ? backend.root : "backend";
  assertSafeArchivePath(root, false);
  for (const entryPath of backendPaths) {
    if (!entryPath.startsWith(`${root}/`)) {
      throw new AppPackageValidationError(`Backend file is outside declared root ${root}: ${entryPath}`, entryPath);
    }
  }
}

function validateMetadata(value: Record<string, unknown>): AppPackageMetadata {
  if (value.schemaVersion !== APP_PACKAGE_SCHEMA_VERSION) {
    throw new AppPackageValidationError(`Unsupported package schema version: ${String(value.schemaVersion)}`, "package.json");
  }
  if (typeof value.appId !== "string" || validateName(value.appId)) {
    throw new AppPackageValidationError("Invalid package appId", "package.json");
  }
  if (typeof value.version !== "string" || !value.version.trim()) {
    throw new AppPackageValidationError("Package version is required", "package.json");
  }
  if (typeof value.platformVersion !== "string" || !value.platformVersion.trim()) {
    throw new AppPackageValidationError("Package platformVersion is required", "package.json");
  }
  return {
    schemaVersion: APP_PACKAGE_SCHEMA_VERSION,
    appId: value.appId,
    version: value.version,
    platformVersion: value.platformVersion,
  };
}

function validateChecksumDocument(value: Record<string, unknown>): Map<string, { size: number; sha256: string }> {
  if (value.schemaVersion !== APP_PACKAGE_SCHEMA_VERSION || !isRecord(value.files)) {
    throw new AppPackageValidationError("Invalid checksums.json schema", "checksums.json");
  }
  const result = new Map<string, { size: number; sha256: string }>();
  for (const [entryPath, checksum] of Object.entries(value.files)) {
    if (!isRecord(checksum)
      || typeof checksum.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(checksum.sha256)
      || typeof checksum.size !== "number"
      || !Number.isSafeInteger(checksum.size)
      || checksum.size < 0) {
      throw new AppPackageValidationError(`Invalid checksum metadata: ${entryPath}`, entryPath);
    }
    result.set(entryPath, { sha256: checksum.sha256, size: checksum.size });
  }
  return result;
}

function requiredMetadata(entries: Map<string, ActualEntry>, entryPath: string): Buffer {
  const entry = entries.get(entryPath);
  if (!entry?.metadataBytes) throw new AppPackageValidationError(`Package file is missing: ${entryPath}`, entryPath);
  return entry.metadataBytes;
}

function parseJsonObject(bytes: Buffer, entryPath: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value)) throw new Error("must contain a JSON object");
    return value;
  } catch (error) {
    throw new AppPackageValidationError(`Invalid ${entryPath}: ${error instanceof Error ? error.message : String(error)}`, entryPath);
  }
}

function safeDestination(root: string, entryPath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, entryPath);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new AppPackageValidationError(`Unsafe package path: ${entryPath}`, entryPath);
  }
  return target;
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true, autoClose: true, strictFileNames: true }, (error, zipFile) => {
      if (error || !zipFile) reject(asPackageError(error ?? new Error("Cannot open application package")));
      else resolve(zipFile);
    });
  });
}

function openEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(asPackageError(error ?? new Error("Cannot read package entry")));
      else resolve(stream);
    });
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  }), new Transform({ transform(_chunk, _encoding, callback) { callback(); } }));
  return hash.digest("hex");
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function asPackageError(error: unknown): AppPackageValidationError {
  if (error instanceof AppPackageValidationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppPackageValidationError(message.toLowerCase().includes("invalid relative path")
    ? `Unsafe package path: ${message}`
    : `Invalid application package: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
