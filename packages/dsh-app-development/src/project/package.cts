import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { Writable } from "node:stream";
import {
  APP_PACKAGE_SCHEMA_VERSION,
  inspectAppPackage,
  writeAppPackageToStream,
  type PortablePackageFile,
} from "../app-package-api.cjs";
import { lifecycleError } from "../project-errors.cjs";
import { validateAndCollectBackend } from "./backend.cjs";
import { checkProject, loadAndValidateProjectManifest, type ProjectCommandRunner } from "./check.cjs";
import {
  capturePreparedTemporary,
  collectProjectTree,
  preparePackageOutput,
  readProjectJson,
  resolveSafePackageOutput,
  type ProjectFileReadHooks,
} from "./files.cjs";

export interface BuildApplicationPackageOptions {
  projectDir: string;
  outputPath?: string;
  versionOverride?: string;
  overwrite?: boolean;
  run?: ProjectCommandRunner;
  fileHooks?: ProjectFileReadHooks;
  outputHooks?: PackageOutputHooks;
  packageOperations?: Partial<PackageOperations>;
  signal?: AbortSignal;
}

export interface PackageOperations {
  writePackage: typeof writeAppPackageToStream;
  inspectPackage: typeof inspectAppPackage;
}

export interface PackageOutputHooks {
  beforeCandidateCreate?(): Promise<void>;
}

export interface BuildApplicationPackageResult {
  path: string;
  appId: string;
  version: string;
  sha256: string;
  size: number;
}

export async function buildApplicationPackage(options: BuildApplicationPackageOptions): Promise<BuildApplicationPackageResult> {
  throwIfPackageBuildAborted(options.signal);
  const projectDir = path.resolve(options.projectDir);
  const manifest = await loadAndValidateProjectManifest(projectDir, options.fileHooks);
  throwIfPackageBuildAborted(options.signal);
  const backendRoot = manifest.backend?.root ?? "backend";
  const output = await resolveSafePackageOutput({
    projectDir,
    outputPath: options.outputPath,
    defaultName: manifest.name,
    protectedDirectories: [manifest.distDir, "migrations", backendRoot],
    overwrite: options.overwrite === true,
  });
  throwIfPackageBuildAborted(options.signal);
  const report = await checkProject({ projectDir, run: options.run, fileHooks: options.fileHooks, signal: options.signal });
  throwIfPackageBuildAborted(options.signal);
  if (!report.success) {
    const diagnostic = report.diagnostics.find((item) => item.severity === "error");
    throw lifecycleError("project_check_failed", diagnostic?.message ?? "Project check failed");
  }

  const packageJson = await readProjectJson(projectDir, "package.json", options.fileHooks);
  throwIfPackageBuildAborted(options.signal);
  const version = options.versionOverride ?? (
    typeof packageJson.version === "string" && packageJson.version.trim()
      ? packageJson.version.trim()
      : "0.0.0"
  );
  const files = await collectCanonicalFiles(projectDir, manifest, options.fileHooks);
  throwIfPackageBuildAborted(options.signal);
  const prepared = await preparePackageOutput(output.path, options.overwrite === true);
  throwIfPackageBuildAborted(options.signal);
  const operations: PackageOperations = {
    writePackage: options.packageOperations?.writePackage ?? writeAppPackageToStream,
    inspectPackage: options.packageOperations?.inspectPackage ?? inspectAppPackage,
  };
  let candidate: AnchoredPackageCandidate | undefined;
  try {
    candidate = await createAnchoredPackageCandidate(prepared, options.outputHooks, options.signal);
    throwIfPackageBuildAborted(options.signal);
    const written = waitForHelperMessage(candidate.child, "written");
    void written.catch(() => undefined);
    const generated = await operations.writePackage({
      output: candidate.output,
      metadata: {
        schemaVersion: APP_PACKAGE_SCHEMA_VERSION,
        appId: manifest.name,
        version,
        platformVersion: manifest.platformVersion,
      },
      files,
    });
    throwIfPackageBuildAborted(options.signal);
    const helperWrite = await written;
    throwIfPackageBuildAborted(options.signal);
    if (helperWrite.digest !== generated.digest) {
      throw lifecycleError("application_package_invalid", "Application package changed while writing the candidate");
    }
    const temporaryIdentity = await capturePreparedTemporary(prepared);
    throwIfPackageBuildAborted(options.signal);
    const inspected = await operations.inspectPackage(prepared.temporaryPath);
    throwIfPackageBuildAborted(options.signal);
    if (generated.digest !== inspected.digest) {
      throw lifecycleError("application_package_invalid", "Application package changed before publication");
    }
    await commandPackageHelper(candidate.child, { action: "publish", digest: inspected.digest }, "published");
    candidate.disposeAbort();
    candidate = undefined;
    return {
      path: output.path,
      appId: inspected.metadata.appId,
      version: inspected.metadata.version,
      sha256: inspected.digest,
      size: helperWrite.size ?? temporaryIdentity.size,
    };
  } catch (error) {
    if (candidate !== undefined) await cleanupAnchoredCandidate(candidate, options.signal);
    if (error instanceof Error && "code" in error && error.code === "APP_PACKAGE_INVALID") {
      throw lifecycleError("application_package_invalid", error.message);
    }
    throw error;
  }
}

interface AnchoredPackageCandidate {
  child: ChildProcess;
  output: Writable;
  disposeAbort(): void;
}

interface PackageHelperMessage {
  type: "ready" | "written" | "published" | "cleaned" | "error";
  code?: string;
  digest?: string;
  size?: number;
}

// Node exposes no portable openat-style API. A child working directory is the
// directory capability here: relative opens and renames stay anchored to the
// directory inherited at spawn, even if its pathname is replaced afterward.
const PACKAGE_OUTPUT_HELPER = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;

const config = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
process.channel?.ref?.();
const send = (message) => new Promise((resolve) => {
  if (!process.send) return resolve();
  process.send(message, () => resolve());
});
const sameParent = async () => {
  const stat = await fsp.stat(".", { bigint: true });
  return stat.isDirectory() && stat.dev === BigInt(config.dev) && stat.ino === BigInt(config.ino);
};
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (stat, expected) => stat.dev === expected.dev && stat.ino === expected.ino;
const lstatOptional = (name) => fsp.lstat(name, { bigint: true }).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
const cleanupOwned = async (name, expected) => {
  const stat = await lstatOptional(name);
  if (stat && !stat.isSymbolicLink() && stat.isFile() && sameIdentity(stat, expected)) await fsp.unlink(name);
};
const copyPinnedCandidate = async (source, destinationHandle) => {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    let written = 0;
    while (written < bytesRead) {
      const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  await destinationHandle.truncate(position);
  await destinationHandle.sync();
};
const sha256PinnedFile = async (handle, expected) => {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || !sameIdentity(before, expected) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("unsafe publication package");
  }
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (!after.isFile() || !sameIdentity(after, expected) || after.size !== before.size || BigInt(position) !== after.size) {
    throw new Error("unsafe publication package");
  }
  return hash.digest("hex");
};

let candidate;
let candidateIdentity;
(async () => {
  if (!await sameParent()) {
    await send({ type: "error", code: "unsafe_project_path" });
    return;
  }
  candidate = await fsp.open(config.temporary, "wx+", 0o600);
  const candidateStat = await candidate.stat({ bigint: true });
  if (!candidateStat.isFile()) throw new Error("unsafe temporary package");
  candidateIdentity = identity(candidateStat);
  await send({ type: "ready" });
  const hash = crypto.createHash("sha256");
  let candidatePosition = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    let written = 0;
    while (written < bytes.length) {
      const result = await candidate.write(bytes, written, bytes.length - written, candidatePosition + written);
      written += result.bytesWritten;
    }
    candidatePosition += bytes.length;
  }
  await candidate.truncate(candidatePosition);
  await candidate.sync();
  const writtenStat = await candidate.stat({ bigint: true });
  if (!writtenStat.isFile() || !sameIdentity(writtenStat, candidateIdentity)) throw new Error("unsafe temporary package");
  const writtenDigest = hash.digest("hex");
  const commandPromise = new Promise((resolve) => process.once("message", resolve));
  await send({ type: "written", digest: writtenDigest, size: Number(writtenStat.size) });
  const command = await commandPromise;
  if (command.action === "cleanup") {
    await cleanupOwned(config.temporary, candidateIdentity);
    await candidate.close();
    await send({ type: "cleaned" });
    return;
  }
  if (command.action !== "publish" || command.digest !== writtenDigest || !await sameParent()) {
    await cleanupOwned(config.temporary, candidateIdentity);
    await candidate.close();
    await send({ type: "error", code: "unsafe_project_path" });
    return;
  }
  const pinned = await candidate.stat({ bigint: true });
  if (!pinned.isFile() || !sameIdentity(pinned, candidateIdentity)) throw new Error("unsafe temporary package");
  const publicationName = "." + config.target + "." + crypto.randomUUID() + ".publish";
  const publication = await fsp.open(publicationName, "wx+", 0o600);
  const publicationIdentity = identity(await publication.stat({ bigint: true }));
  try {
    await copyPinnedCandidate(candidate, publication);
    const publicationDigest = await sha256PinnedFile(publication, publicationIdentity);
    if (publicationDigest !== command.digest) {
      const error = new Error("publication package digest mismatch");
      error.code = "application_package_invalid";
      throw error;
    }
    const publicationPath = await fsp.lstat(publicationName, { bigint: true });
    if (!publicationPath.isFile() || publicationPath.isSymbolicLink() || !sameIdentity(publicationPath, publicationIdentity)) {
      throw new Error("unsafe publication package");
    }
    if (config.overwrite) {
      const target = await lstatOptional(config.target);
      if (target && (target.isSymbolicLink() || !target.isFile())) throw new Error("unsafe package target");
      await fsp.rename(publicationName, config.target);
    } else {
      await fsp.link(publicationName, config.target);
      await fsp.unlink(publicationName);
    }
    const published = await fsp.lstat(config.target, { bigint: true });
    if (!published.isFile() || published.isSymbolicLink() || !sameIdentity(published, publicationIdentity)) {
      throw new Error("unsafe published package");
    }
  } finally {
    await publication.close();
    await cleanupOwned(publicationName, publicationIdentity);
  }
  await cleanupOwned(config.temporary, candidateIdentity);
  await candidate.close();
  await send({ type: "published" });
})().catch(async (error) => {
  if (candidateIdentity) await cleanupOwned(config.temporary, candidateIdentity).catch(() => undefined);
  await candidate?.close().catch(() => undefined);
  const code = error && error.code === "EEXIST"
    ? "package_output_exists"
    : error && error.code === "application_package_invalid"
      ? "application_package_invalid"
      : "package_output_failed";
  await send({ type: "error", code });
});
`;

async function createAnchoredPackageCandidate(
  prepared: Awaited<ReturnType<typeof preparePackageOutput>>,
  hooks?: PackageOutputHooks,
  signal?: AbortSignal,
): Promise<AnchoredPackageCandidate> {
  throwIfPackageBuildAborted(signal);
  await hooks?.beforeCandidateCreate?.();
  throwIfPackageBuildAborted(signal);
  const config = Buffer.from(JSON.stringify({
    dev: prepared.parent.dev.toString(),
    ino: prepared.parent.ino.toString(),
    temporary: path.basename(prepared.temporaryPath),
    target: path.basename(prepared.path),
    overwrite: prepared.overwrite,
  })).toString("base64url");
  const child = spawn(process.execPath, ["--input-type=commonjs", "--eval", PACKAGE_OUTPUT_HELPER, config], {
    cwd: prepared.parent.path,
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore", "ipc"],
  });
  const ready = waitForHelperMessage(child, "ready");
  const output = child.stdin;
  if (output === null) throw lifecycleError("package_output_failed", "Could not create application package candidate");
  const onAbort = () => {
    if (!output.destroyed) output.destroy();
    if (child.connected) child.disconnect();
    child.kill("SIGKILL");
  };
  const disposeAbort = () => signal?.removeEventListener("abort", onAbort);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    await ready;
    throwIfPackageBuildAborted(signal);
    return { child, output, disposeAbort };
  } catch (error) {
    disposeAbort();
    if (!output.destroyed) output.destroy();
    child.kill("SIGKILL");
    throw error;
  }
}

function waitForHelperMessage(
  child: ChildProcess,
  expected: PackageHelperMessage["type"],
): Promise<PackageHelperMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (value: unknown) => {
      if (!isPackageHelperMessage(value)) return;
      if (value.type === "error") {
        cleanup();
        if (child.connected) child.disconnect();
        reject(packageHelperError(value.code));
      } else if (value.type === expected) {
        cleanup();
        resolve(value);
      }
    };
    const onError = () => {
      cleanup();
      reject(lifecycleError("package_output_failed", "Could not create application package candidate"));
    };
    const onExit = () => {
      cleanup();
      reject(lifecycleError("package_output_failed", "Application package candidate process stopped unexpectedly"));
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function commandPackageHelper(
  child: ChildProcess,
  command: { action: "publish"; digest: string } | { action: "cleanup" },
  expected: "published" | "cleaned",
): Promise<PackageHelperMessage> {
  const response = waitForHelperMessage(child, expected);
  void response.catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    child.send(command, (error) => error ? reject(error) : resolve());
  });
  const message = await response;
  child.disconnect();
  return message;
}

async function cleanupAnchoredCandidate(candidate: AnchoredPackageCandidate, signal?: AbortSignal): Promise<void> {
  candidate.disposeAbort();
  if (signal?.aborted) {
    if (!candidate.output.destroyed) candidate.output.destroy();
    if (candidate.child.connected) candidate.child.disconnect();
    candidate.child.kill("SIGKILL");
    return;
  }
  try {
    if (!candidate.output.destroyed) candidate.output.destroy();
    if (candidate.child.connected) await commandPackageHelper(candidate.child, { action: "cleanup" }, "cleaned");
  } catch {
    candidate.child.kill();
  }
}

function throwIfPackageBuildAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedPackageBuild();
}

function abortedPackageBuild(): Error {
  return new Error("Application package build aborted");
}

function isPackageHelperMessage(value: unknown): value is PackageHelperMessage {
  return isRecord(value) && typeof value.type === "string"
    && ["ready", "written", "published", "cleaned", "error"].includes(value.type);
}

function packageHelperError(code: string | undefined): Error {
  if (code === "unsafe_project_path") {
    return lifecycleError("unsafe_project_path", "Application package output parent changed before candidate creation");
  }
  if (code === "package_output_exists") {
    return lifecycleError("package_output_exists", "Application package output already exists; choose another path or explicitly enable overwrite");
  }
  if (code === "application_package_invalid") {
    return lifecycleError("application_package_invalid", "Application package changed while preparing publication");
  }
  return lifecycleError("package_output_failed", "Could not publish application package safely");
}

export async function collectCanonicalFiles(
  projectDir: string,
  manifest: Awaited<ReturnType<typeof loadAndValidateProjectManifest>>,
  fileHooks?: ProjectFileReadHooks,
): Promise<PortablePackageFile[]> {
  const canonicalManifest = structuredClone(manifest.raw);
  canonicalManifest.distDir = "dist";
  if (manifest.backend !== undefined) {
    const backend = isRecord(canonicalManifest.backend) ? canonicalManifest.backend : {};
    backend.root = "backend";
    delete backend.include;
    canonicalManifest.backend = backend;
  }
  const files: PortablePackageFile[] = [{
    path: "manifest.json",
    content: Buffer.from(`${JSON.stringify(canonicalManifest)}\n`),
  }];
  const dist = await collectProjectTree({
    projectDir,
    configuredPath: manifest.distDir,
    label: "distDir",
    required: true,
    hooks: fileHooks,
  });
  files.push(...dist.map((file) => ({ path: `dist/${file.relativePath}`, content: file.content })));
  const migrations = await collectProjectTree({
    projectDir,
    configuredPath: "migrations",
    label: "migrations",
    required: false,
    hooks: fileHooks,
  });
  files.push(...migrations
    .filter((file) => file.relativePath.endsWith(".sql"))
    .map((file) => ({ path: `migrations/${file.relativePath}`, content: file.content })));
  const backend = await validateAndCollectBackend({
    projectDir,
    config: manifest.backend,
    platformVersion: manifest.platformVersion,
    fileHooks,
  });
  files.push(...backend.map((file) => ({ path: `backend/${file.relativePath}`, content: file.content })));
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
