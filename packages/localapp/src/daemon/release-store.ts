import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants, lstatSync, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import path from "node:path";
import { lifecycleError } from "../errors.js";
import type { RuntimeLayout } from "./runtime-layout.js";

export interface ReleaseArtifactFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ReleaseArtifactManifest {
  schemaVersion: 2;
  name: "@patodo/localapp";
  version: string;
  nodeMajor: number;
  entrypoint: string;
  bootstrapEntrypoint: string;
  files: ReleaseArtifactFile[];
  artifactDigest: string;
  bundleDigest?: string;
  serverBundleDigest?: string;
  serverEntrypoint?: string;
  protocolVersions: { deviceAction: number; notificationDelivery: number; peerSync: number };
  nativeAdapters: Array<{
    target: string;
    signing: { mode: "adhoc" | "release" };
    assets: Array<{ path: string; sha256: string }>;
  }>;
}

export interface CurrentRelease {
  version: string;
  artifactDigest: string;
  releasePath: string;
  entrypoint: string;
  bootstrapEntrypoint: string;
}

export interface PublishReleaseOptions {
  sourceDirectory: string;
  layout: RuntimeLayout;
  lockTimeoutMs?: number;
}

interface InspectedArtifact {
  manifest: ReleaseArtifactManifest;
  files: Map<string, Buffer>;
  manifestBytes: Buffer;
}

const DIGEST = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;

export async function verifyReleaseArtifact(directory: string): Promise<ReleaseArtifactManifest> {
  return (await inspectReleaseArtifact(path.resolve(directory), false)).manifest;
}

export async function publishRelease(options: PublishReleaseOptions): Promise<CurrentRelease> {
  const sourceDirectory = path.resolve(options.sourceDirectory);
  const inspected = await inspectReleaseArtifact(sourceDirectory);
  await ensurePrivateDirectories(options.layout);
  return withReleaseLock(options.layout, options.lockTimeoutMs ?? 5_000, async () => {
    const releaseName = `${inspected.manifest.version}-${inspected.manifest.artifactDigest}`;
    const releasePath = path.join(options.layout.releasesDir, releaseName);
    const existing = await lstatOptional(releasePath);
    if (existing === undefined) {
      await publishImmutableDirectory(releasePath, inspected, options.layout.releasesDir);
    } else {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw invalidArtifact();
      const verified = await inspectReleaseArtifact(releasePath);
      if (verified.manifest.artifactDigest !== inspected.manifest.artifactDigest) throw invalidArtifact();
    }
    const current: CurrentRelease = {
      version: inspected.manifest.version,
      artifactDigest: inspected.manifest.artifactDigest,
      releasePath,
      entrypoint: inspected.manifest.entrypoint,
      bootstrapEntrypoint: inspected.manifest.bootstrapEntrypoint,
    };
    const launcherBytes = await readRegularFile(path.join(releasePath, ...inspected.manifest.bootstrapEntrypoint.split("/")));
    await ensureStableLauncher(options.layout.launcherPath, launcherBytes);
    await writeAtomic(options.layout.currentManifestPath, Buffer.from(`${JSON.stringify(current, null, 2)}\n`), 0o600);
    return current;
  });
}

export async function readCurrentRelease(layout: RuntimeLayout): Promise<CurrentRelease> {
  let value: unknown;
  try {
    value = JSON.parse((await readRegularFile(layout.currentManifestPath)).toString("utf8"));
  } catch {
    throw lifecycleError("release_current_invalid", "The current LocalApp release manifest is missing or invalid");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["version", "artifactDigest", "releasePath", "entrypoint", "bootstrapEntrypoint"])
    || typeof value.version !== "string" || !VERSION.test(value.version)
    || typeof value.artifactDigest !== "string" || !DIGEST.test(value.artifactDigest)
    || typeof value.releasePath !== "string" || typeof value.entrypoint !== "string"
    || typeof value.bootstrapEntrypoint !== "string") {
    throw lifecycleError("release_current_invalid", "The current LocalApp release manifest is missing or invalid");
  }
  const expectedPath = path.join(layout.releasesDir, `${value.version}-${value.artifactDigest}`);
  if (path.resolve(value.releasePath) !== path.resolve(expectedPath)
    || !isSafeRelativeFile(value.entrypoint) || !isSafeRelativeFile(value.bootstrapEntrypoint)) {
    throw lifecycleError("release_current_invalid", "The current LocalApp release manifest is missing or invalid");
  }
  return {
    version: value.version,
    artifactDigest: value.artifactDigest,
    releasePath: expectedPath,
    entrypoint: value.entrypoint,
    bootstrapEntrypoint: value.bootstrapEntrypoint,
  };
}

async function inspectReleaseArtifact(directory: string, retainFiles = true): Promise<InspectedArtifact> {
  try {
    const root = await fs.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw invalidArtifact();
    const manifestPath = path.join(directory, ".localapp-artifact.json");
    const manifestBytes = await readRegularFile(manifestPath);
    const manifest = parseArtifactManifest(JSON.parse(manifestBytes.toString("utf8")));
    const observed = await listArtifactFiles(directory);
    const expected = new Set(manifest.files.map((file) => file.path));
    if (observed.size !== expected.size || [...observed].some((relativePath) => !expected.has(relativePath))) {
      throw invalidArtifact();
    }
    const files = new Map<string, Buffer>();
    let checked = 0;
    await forEachConcurrent(manifest.files, async (entry) => {
      const filePath = path.join(directory, ...entry.path.split("/"));
      const bytes = retainFiles ? await readRegularFile(filePath) : readRegularFileSync(filePath);
      if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) throw invalidArtifact();
      if (retainFiles || entry.path === "runtime/native/adapter-manifest.json") files.set(entry.path, bytes);
      // Avoid hundreds of thousands of thread-pool round trips on startup,
      // while letting control requests run between bounded verification batches.
      if (!retainFiles && ++checked % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    });
    validatePackedNativeManifest(manifest, files);
    return { manifest, files, manifestBytes };
  } catch (error) {
    if (isErrorCode(error, "release_artifact_invalid")) throw error;
    throw invalidArtifact();
  }
}

function parseArtifactManifest(value: unknown): ReleaseArtifactManifest {
  if (!isRecord(value)) throw invalidArtifact();
  const allowed = new Set([
    "schemaVersion", "name", "version", "nodeMajor", "entrypoint", "bootstrapEntrypoint",
    "files", "artifactDigest", "bundleDigest", "serverBundleDigest",
    "serverEntrypoint", "protocolVersions", "nativeAdapters",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || value.schemaVersion !== 2 || value.name !== "@patodo/localapp"
    || typeof value.version !== "string" || !VERSION.test(value.version)
    || value.nodeMajor !== 24
    || typeof value.entrypoint !== "string" || !isSafeRelativeFile(value.entrypoint)
    || typeof value.bootstrapEntrypoint !== "string" || !isSafeRelativeFile(value.bootstrapEntrypoint)
    || !Array.isArray(value.files) || value.files.length === 0
    || typeof value.artifactDigest !== "string" || !DIGEST.test(value.artifactDigest)
    || (value.bundleDigest !== undefined && (typeof value.bundleDigest !== "string" || !DIGEST.test(value.bundleDigest)))
    || (value.serverBundleDigest !== undefined && (typeof value.serverBundleDigest !== "string" || !DIGEST.test(value.serverBundleDigest)))
    || (value.serverEntrypoint !== undefined && (typeof value.serverEntrypoint !== "string" || !isSafeRelativeFile(value.serverEntrypoint)))
    || value.protocolVersions === undefined || value.nativeAdapters === undefined) {
    throw invalidArtifact();
  }
  const protocolVersions = parseProtocolVersions(value.protocolVersions);
  const nativeAdapters = parseNativeAdapters(value.nativeAdapters);
  const files = value.files.map(parseArtifactFile);
  if (nativeAdapters.some((adapter) => adapter.assets.some((asset) => {
    const packed = files.find((file) => file.path === `runtime/native/${asset.path}`);
    return packed === undefined || packed.sha256 !== asset.sha256;
  }))) throw invalidArtifact();
  const canonical = [...files].sort(compareArtifactFiles);
  if (canonical.some((entry, index) => entry.path !== files[index]?.path)
    || new Set(files.map((entry) => entry.path)).size !== files.length
    || !files.some((entry) => entry.path === value.entrypoint)
    || !files.some((entry) => entry.path === value.bootstrapEntrypoint)
    || (typeof value.serverEntrypoint === "string" && !files.some((entry) => entry.path === value.serverEntrypoint))) throw invalidArtifact();
  const digestDescriptor = {
    schemaVersion: 2 as const,
    name: "@patodo/localapp" as const,
    version: value.version,
    nodeMajor: 24,
    entrypoint: value.entrypoint,
    bootstrapEntrypoint: value.bootstrapEntrypoint,
    files,
    ...(typeof value.bundleDigest === "string" ? { bundleDigest: value.bundleDigest } : {}),
    ...(typeof value.serverBundleDigest === "string" ? { serverBundleDigest: value.serverBundleDigest } : {}),
    ...(typeof value.serverEntrypoint === "string" ? { serverEntrypoint: value.serverEntrypoint } : {}),
    protocolVersions: value.protocolVersions,
    nativeAdapters: value.nativeAdapters,
  };
  if (sha256(Buffer.from(JSON.stringify(digestDescriptor))) !== value.artifactDigest) throw invalidArtifact();
  const descriptor = {
    schemaVersion: 2 as const,
    name: "@patodo/localapp" as const,
    version: value.version,
    nodeMajor: 24,
    entrypoint: value.entrypoint,
    bootstrapEntrypoint: value.bootstrapEntrypoint,
    files,
    ...(typeof value.bundleDigest === "string" ? { bundleDigest: value.bundleDigest } : {}),
    ...(typeof value.serverBundleDigest === "string" ? { serverBundleDigest: value.serverBundleDigest } : {}),
    ...(typeof value.serverEntrypoint === "string" ? { serverEntrypoint: value.serverEntrypoint } : {}),
    protocolVersions,
    nativeAdapters,
  };
  return { ...descriptor, artifactDigest: value.artifactDigest };
}

function parseProtocolVersions(value: unknown): { deviceAction: number; notificationDelivery: number; peerSync: number } {
  if (!isRecord(value) || !hasExactKeys(value, ["deviceAction", "notificationDelivery", "peerSync"])
    || value.deviceAction !== 2 || value.notificationDelivery !== 2 || value.peerSync !== 1) throw invalidArtifact();
  return { deviceAction: 2, notificationDelivery: 2, peerSync: 1 };
}

function parseNativeAdapters(value: unknown): ReleaseArtifactManifest["nativeAdapters"] {
  if (!Array.isArray(value) || value.length === 0) throw invalidArtifact();
  const adapters = value.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["target", "signing", "assets"])
      || typeof entry.target !== "string" || !/^(?:darwin|linux|win32)-(?:arm64|x64)$/.test(entry.target)
      || !isRecord(entry.signing) || !hasExactKeys(entry.signing, ["mode"])
      || (entry.signing.mode !== "adhoc" && entry.signing.mode !== "release")
      || !Array.isArray(entry.assets) || entry.assets.length === 0) throw invalidArtifact();
    const assets = entry.assets.map((asset) => {
      if (!isRecord(asset) || !hasExactKeys(asset, ["path", "sha256"])
        || typeof asset.path !== "string" || !isSafeRelativeFile(asset.path) || !asset.path.startsWith(`${entry.target}/`)
        || typeof asset.sha256 !== "string" || !DIGEST.test(asset.sha256)) throw invalidArtifact();
      return { path: asset.path, sha256: asset.sha256 };
    });
    if (new Set(assets.map((asset) => asset.path)).size !== assets.length) throw invalidArtifact();
    if (requiredNativeAssets(entry.target).some((required) => !assets.some((asset) => asset.path === required))) throw invalidArtifact();
    return { target: entry.target, signing: { mode: entry.signing.mode }, assets } as const;
  });
  adapters.sort((left, right) => left.target.localeCompare(right.target));
  if (new Set(adapters.map((adapter) => adapter.target)).size !== adapters.length) throw invalidArtifact();
  return adapters;
}

function requiredNativeAssets(target: string): string[] {
  if (target.startsWith("darwin-")) return [
    `${target}/LocalAppBridge.app/Contents/Info.plist`,
    `${target}/LocalAppBridge.app/Contents/MacOS/LocalAppBridge`,
    `${target}/LocalAppBridge.app/Contents/Resources/localapp-native-ipc-client.mjs`,
  ];
  if (target.startsWith("linux-")) return [`${target}/localapp-notifications`, `${target}/localapp-native-ipc-client.mjs`];
  return [`${target}/localapp-native.exe`, `${target}/localapp-native-ipc-client.mjs`];
}

function validatePackedNativeManifest(manifest: ReleaseArtifactManifest, files: Map<string, Buffer>): void {
  const bytes = files.get("runtime/native/adapter-manifest.json");
  if (bytes === undefined) throw invalidArtifact();
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw invalidArtifact(); }
  let adapters: ReleaseArtifactManifest["nativeAdapters"];
  if (isRecord(value) && hasExactKeys(value, ["schemaVersion", "target", "signing", "assets"]) && value.schemaVersion === 1) {
    const { schemaVersion: _schemaVersion, ...entry } = value;
    adapters = parseNativeAdapters([entry]);
  } else if (isRecord(value) && hasExactKeys(value, ["schemaVersion", "adapters"]) && value.schemaVersion === 2) {
    adapters = parseNativeAdapters(value.adapters);
  } else {
    throw invalidArtifact();
  }
  if (JSON.stringify(adapters) !== JSON.stringify(manifest.nativeAdapters)) throw invalidArtifact();
}

function parseArtifactFile(value: unknown): ReleaseArtifactFile {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "size", "sha256"])
    || typeof value.path !== "string" || !isSafeRelativeFile(value.path) || value.path === ".localapp-artifact.json"
    || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0
    || typeof value.sha256 !== "string" || !DIGEST.test(value.sha256)) throw invalidArtifact();
  return { path: value.path, size: value.size, sha256: value.sha256 };
}

async function listArtifactFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relativePath === ".localapp-artifact.json") continue;
      if (!isSafeRelativeFile(relativePath)) throw invalidArtifact();
      if (entry.isSymbolicLink()) throw invalidArtifact();
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relativePath);
      else if (entry.isFile()) files.add(relativePath);
      else throw invalidArtifact();
    }
  };
  await visit(root, "");
  return files;
}

async function publishImmutableDirectory(
  releasePath: string,
  inspected: InspectedArtifact,
  releasesDirectory: string,
): Promise<void> {
  const staging = await fs.mkdtemp(path.join(releasesDirectory, ".release-stage-"));
  if (process.platform !== "win32") await fs.chmod(staging, 0o700);
  try {
    await forEachConcurrent([...inspected.files], async ([relativePath, bytes]) => {
      const destination = path.join(staging, ...relativePath.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, bytes, { flag: "wx", mode: isExecutableReleaseFile(relativePath, inspected.manifest) ? 0o700 : 0o600 });
    });
    await fs.writeFile(path.join(staging, ".localapp-artifact.json"), inspected.manifestBytes, { flag: "wx", mode: 0o600 });
    await inspectReleaseArtifact(staging);
    try {
      await fs.rename(staging, releasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      const existing = await inspectReleaseArtifact(releasePath);
      if (existing.manifest.artifactDigest !== inspected.manifest.artifactDigest) throw invalidArtifact();
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

// Bound open descriptors while checking every file and preserving the same
// before/open/after identity checks. Await all workers before staging cleanup.
async function forEachConcurrent<T>(items: readonly T[], operation: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(16, items.length) }, async () => {
    while (next < items.length) await operation(items[next++]);
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

function isExecutableReleaseFile(relativePath: string, manifest: ReleaseArtifactManifest): boolean {
  if (relativePath === manifest.entrypoint) return true;
  if (relativePath.startsWith("runtime/server/node_modules/") && /\/(?:landlock-run|rg|rg\.exe|spawn-helper)$/.test(relativePath)) return true;
  return /^runtime\/native\/[^/]+\/(?:LocalAppBridge\.app\/Contents\/(?:MacOS\/LocalAppBridge|Resources\/localapp-native-ipc-client\.mjs)|localapp-native\.exe|localapp-notifications|localapp-native-ipc-client\.mjs)$/.test(relativePath);
}

async function ensurePrivateDirectories(layout: RuntimeLayout): Promise<void> {
  validateRuntimeLayout(layout);
  await ensurePrivateDirectory(layout.supportDir);
  for (const directory of [layout.releasesDir, layout.logsDir, path.dirname(layout.launcherPath), layout.runtimeDir]) {
    await ensurePrivateDirectory(directory);
  }
}

async function withReleaseLock<T>(layout: RuntimeLayout, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(layout.runtimeDir);
  const deadline = Date.now() + timeoutMs;
  let lock: OwnedReleaseLock | undefined;
  while (lock === undefined) {
    lock = await tryCreateReleaseLock(layout);
    if (lock !== undefined) break;
    if (await reclaimDeadReleaseLock(layout.releaseLockPath)) continue;
    if (Date.now() >= deadline) throw lifecycleError("release_store_busy", "Another LocalApp release publication is still in progress");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    return await operation();
  } finally {
    await lock.handle.close();
    await unlinkOwnedPath(layout.releaseLockPath, lock.identity);
  }
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface OwnedReleaseLock {
  handle: Awaited<ReturnType<typeof fs.open>>;
  identity: FileIdentity;
}

async function tryCreateReleaseLock(layout: RuntimeLayout): Promise<OwnedReleaseLock | undefined> {
  const temporary = path.join(layout.runtimeDir, `.release-lock.${process.pid}.${crypto.randomUUID()}.next`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let identity: FileIdentity | undefined;
  let linked = false;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw lifecycleError("release_store_lock_invalid", "The LocalApp release lock could not be initialized");
    identity = { dev: stat.dev, ino: stat.ino };
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    await handle.sync();
    try {
      await fs.link(temporary, layout.releaseLockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw error;
    }
    linked = true;
    const canonical = await fs.lstat(layout.releaseLockPath, { bigint: true });
    if (!canonical.isFile() || canonical.isSymbolicLink() || canonical.dev !== identity.dev || canonical.ino !== identity.ino) {
      throw lifecycleError("release_store_lock_invalid", "The LocalApp release lock identity changed during creation");
    }
    await unlinkOwnedPath(temporary, identity);
    return { handle, identity };
  } catch (error) {
    if (linked && identity !== undefined) await unlinkOwnedPath(layout.releaseLockPath, identity).catch(() => undefined);
    linked = false;
    throw error;
  } finally {
    if (!linked || identity === undefined) {
      await handle?.close().catch(() => undefined);
      if (identity !== undefined) await unlinkOwnedPath(temporary, identity).catch(() => undefined);
      else await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function reclaimDeadReleaseLock(lockPath: string): Promise<boolean> {
  const before = await fs.lstat(lockPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (before === undefined) return true;
  if (!before.isFile() || before.isSymbolicLink() || (process.platform !== "win32" && (Number(before.mode) & 0o077) !== 0)) return false;
  let value: unknown;
  try {
    value = JSON.parse((await readRegularFile(lockPath)).toString("utf8"));
  } catch {
    return false;
  }
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "pid", "createdAt"])
    || value.schemaVersion !== 1 || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return false;
  if (processExists(value.pid)) return false;
  return unlinkOwnedPath(lockPath, { dev: before.dev, ino: before.ino });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function unlinkOwnedPath(filePath: string, identity: FileIdentity): Promise<boolean> {
  const current = await fs.lstat(filePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current === undefined || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) return false;
  await fs.unlink(filePath);
  return true;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw lifecycleError("release_path_unsafe", "A LocalApp release directory is not a private regular directory");
  }
  if (process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
    const secured = await fs.lstat(directory);
    if (!secured.isDirectory() || secured.isSymbolicLink() || (secured.mode & 0o077) !== 0) {
      throw lifecycleError("release_path_unsafe", "A LocalApp release directory is not private");
    }
  }
}

function validateRuntimeLayout(layout: RuntimeLayout): void {
  const support = path.resolve(layout.supportDir);
  const expected = [
    [layout.releasesDir, path.join(support, "releases")],
    [layout.currentManifestPath, path.join(support, "current.json")],
    [layout.launcherPath, path.join(support, "bin", "localapp-daemon-bootstrap.mjs")],
    [layout.logsDir, path.join(support, "logs")],
  ];
  if (expected.some(([actual, canonical]) => path.resolve(actual) !== path.resolve(canonical))
    || path.resolve(layout.releaseLockPath) !== path.resolve(layout.runtimeDir, "release.lock")) {
    throw lifecycleError("release_path_unsafe", "The LocalApp release layout is invalid");
  }
}

async function ensureStableLauncher(filePath: string, bytes: Buffer): Promise<void> {
  const existing = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing === undefined) {
    await writeAtomic(filePath, bytes, 0o700);
    return;
  }
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw lifecycleError("release_launcher_incompatible", "The stable LocalApp launcher is invalid");
  }
  const current = await readRegularFile(filePath);
  if (!current.equals(bytes)) {
    throw lifecycleError("release_launcher_incompatible", "The stable LocalApp launcher is incompatible with this release");
  }
  if (process.platform !== "win32") await fs.chmod(filePath, 0o700);
}

async function writeAtomic(filePath: string, bytes: Buffer, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.next`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    if (process.platform !== "win32") await fs.chmod(filePath, mode);
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

async function readRegularFile(filePath: string): Promise<Buffer> {
  const before = await fs.lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw invalidArtifact();
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw invalidArtifact();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || BigInt(bytes.byteLength) !== after.size) throw invalidArtifact();
    return bytes;
  } finally {
    await handle.close();
  }
}

function readRegularFileSync(filePath: string): Buffer {
  const before = lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw invalidArtifact();
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = openSync(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(handle, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw invalidArtifact();
    const bytes = readFileSync(handle);
    const after = fstatSync(handle, { bigint: true });
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || BigInt(bytes.byteLength) !== after.size) throw invalidArtifact();
    return bytes;
  } finally { closeSync(handle); }
}

function isSafeRelativeFile(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes("\\") && !value.startsWith("/")
    && path.posix.normalize(value) === value && !value.endsWith("/")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function compareArtifactFiles(left: ReleaseArtifactFile, right: ReleaseArtifactFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function invalidArtifact(): Error {
  return lifecycleError("release_artifact_invalid", "The LocalApp release artifact is invalid or has changed");
}

function isErrorCode(value: unknown, code: string): boolean {
  return value instanceof Error && "code" in value && value.code === code;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function lstatOptional(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  return fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
}
