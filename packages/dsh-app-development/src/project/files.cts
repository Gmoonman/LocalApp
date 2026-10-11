import { constants } from "node:fs";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lifecycleError } from "../project-errors.cjs";

export interface CollectedProjectFile {
  absolutePath: string;
  relativePath: string;
  content: Buffer;
}

export interface ProjectFileReadHooks {
  afterAncestorValidation?(filePath: string): Promise<void>;
  beforeOpen?(filePath: string): Promise<void>;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface DirectoryIdentity extends FileIdentity {
  path: string;
}

interface CapturedProjectFile {
  file: FileIdentity;
  ancestors: readonly DirectoryIdentity[];
}

export interface PreparedPackageOutput {
  path: string;
  temporaryPath: string;
  parent: { path: string; dev: bigint; ino: bigint };
  overwrite: boolean;
}

export async function readProjectJson(
  projectDir: string,
  filename: string,
  hooks?: ProjectFileReadHooks,
): Promise<Record<string, unknown>> {
  const filePath = path.join(projectDir, filename);
  const content = await readVerifiedFile(projectDir, filePath, filename, hooks);
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw lifecycleError("invalid_project_json", `Invalid ${filename}: ${safeErrorMessage(error)}`);
  }
  if (!isRecord(value)) throw lifecycleError("invalid_project_json", `${filename} must contain a JSON object`);
  return value;
}

export async function collectProjectTree(options: {
  projectDir: string;
  configuredPath: string;
  label: string;
  required: boolean;
  hooks?: ProjectFileReadHooks;
}): Promise<CollectedProjectFile[]> {
  const root = await resolveProjectDirectory(options);
  if (root === undefined) return [];
  const files: CollectedProjectFile[] = [];
  await collectTree(path.resolve(options.projectDir), root, root, options.label, files, options.hooks);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function assertRegularProjectFile(projectDir: string, filePath: string, label: string): Promise<void> {
  await captureRegularProjectFile(projectDir, filePath, label);
}

async function captureRegularProjectFile(
  projectDir: string,
  filePath: string,
  label: string,
  hooks?: ProjectFileReadHooks,
): Promise<CapturedProjectFile> {
  const root = path.resolve(projectDir);
  const target = path.resolve(filePath);
  if (!isInside(root, target) || target === root) throw unsafePath(`${label} must stay inside the project`);
  const ancestors = await captureDirectoryChain(root, path.dirname(target), label);
  await hooks?.afterAncestorValidation?.(target);
  const stat = await fs.lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw lifecycleError("project_file_missing", `${label} does not exist`);
    throw error;
  });
  if (stat.isSymbolicLink() || !stat.isFile()) throw unsafePath(`${label} must be a regular file without symlinks`);
  return { file: { dev: stat.dev, ino: stat.ino }, ancestors };
}

export async function readVerifiedFile(
  projectDir: string,
  filePath: string,
  label: string,
  hooks?: ProjectFileReadHooks,
): Promise<Buffer> {
  const captured = await captureRegularProjectFile(projectDir, filePath, label, hooks);
  return readValidatedRegularFile(filePath, label, captured, hooks);
}

export async function resolveProjectDirectory(options: {
  projectDir: string;
  configuredPath: string;
  label: string;
  required: boolean;
}): Promise<string | undefined> {
  const root = path.resolve(options.projectDir);
  const configured = options.configuredPath.trim();
  if (!configured || path.isAbsolute(configured)) {
    throw unsafePath(`${options.label} must be a non-empty relative path inside the project`);
  }
  const target = path.resolve(root, configured);
  if (!isInside(root, target) || target === root) {
    throw unsafePath(`${options.label} must stay inside the project and must not be the project root`);
  }
  await assertPathChainHasNoSymlinks(root, target, options.label, !options.required);
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && !options.required) return undefined;
    if (error.code === "ENOENT") throw lifecycleError("project_directory_missing", `${options.label} does not exist: ${options.configuredPath}`);
    throw error;
  });
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafePath(`${options.label} must be a directory without symlinks`);
  return target;
}

export async function resolveSafePackageOutput(options: {
  projectDir: string;
  outputPath?: string;
  defaultName: string;
  protectedDirectories: readonly string[];
  overwrite: boolean;
}): Promise<{ path: string; exists: boolean }> {
  const configured = options.outputPath ?? `${options.defaultName}.localapp`;
  const outputPath = path.resolve(options.projectDir, configured);
  if (path.extname(outputPath) !== ".localapp") {
    throw lifecycleError("invalid_package_output", "Application package output must use the .localapp extension");
  }
  for (const protectedDirectory of options.protectedDirectories) {
    const protectedPath = path.resolve(options.projectDir, protectedDirectory);
    if (isInside(protectedPath, outputPath)) {
      throw lifecycleError("invalid_package_output", "Application package output must be outside dist, migrations, and backend source directories");
    }
  }
  await assertExistingOutputChainHasNoSymlinks(outputPath);
  const stat = await fs.lstat(outputPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (stat !== undefined && (stat.isSymbolicLink() || !stat.isFile())) {
    throw unsafePath("Application package output must be a regular file without symlinks");
  }
  if (stat !== undefined && !options.overwrite) {
    throw lifecycleError("package_output_exists", "Application package output already exists; choose another path or explicitly enable overwrite");
  }
  return { path: outputPath, exists: stat !== undefined };
}

export async function preparePackageOutput(outputPath: string, overwrite: boolean): Promise<PreparedPackageOutput> {
  const parentPath = path.dirname(outputPath);
  await fs.mkdir(parentPath, { recursive: true, mode: 0o700 });
  await assertExistingOutputChainHasNoSymlinks(parentPath);
  const parentStat = await fs.lstat(parentPath, { bigint: true });
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw unsafePath("Application package output parent must be a directory without symlinks");
  }
  const outputStat = await fs.lstat(outputPath, { bigint: true }).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (outputStat !== undefined && (outputStat.isSymbolicLink() || !outputStat.isFile())) {
    throw unsafePath("Application package output must be a regular file without symlinks");
  }
  if (outputStat !== undefined && !overwrite) throw packageOutputExists();
  return {
    path: outputPath,
    temporaryPath: path.join(parentPath, `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`),
    parent: { path: parentPath, dev: parentStat.dev, ino: parentStat.ino },
    overwrite,
  };
}

export async function capturePreparedTemporary(
  prepared: PreparedPackageOutput,
): Promise<{ dev: bigint; ino: bigint; size: number }> {
  await verifyPreparedParent(prepared);
  const stat = await fs.lstat(prepared.temporaryPath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) throw unsafePath("Application package temporary output is unsafe");
  return { dev: stat.dev, ino: stat.ino, size: Number(stat.size) };
}

export function normalizeArchiveRelativePath(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/").split("/").filter((part) => part !== "" && part !== ".").join("/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw unsafePath(`${label} contains an unsafe package path`);
  }
  return normalized;
}

function asyncReaddir(directory: string) {
  return fs.readdir(directory, { withFileTypes: true });
}

async function collectTree(
  projectDir: string,
  root: string,
  current: string,
  label: string,
  files: CollectedProjectFile[],
  hooks?: ProjectFileReadHooks,
): Promise<void> {
  const entries = (await asyncReaddir(current)).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, "/");
    const stat = await fs.lstat(absolutePath, { bigint: true });
    if (stat.isSymbolicLink()) throw unsafePath(`${label} must not contain symlinks: ${relativePath}`);
    if (stat.isDirectory()) {
      await collectTree(projectDir, root, absolutePath, label, files, hooks);
    } else if (stat.isFile()) {
      files.push({
        absolutePath,
        relativePath,
        content: await readVerifiedFile(projectDir, absolutePath, `${label} file ${relativePath}`, hooks),
      });
    } else {
      throw unsafePath(`${label} must contain only regular files and directories: ${relativePath}`);
    }
  }
}

async function readValidatedRegularFile(
  filePath: string,
  label: string,
  expected: CapturedProjectFile,
  hooks?: ProjectFileReadHooks,
): Promise<Buffer> {
  await hooks?.beforeOpen?.(filePath);
  const flags = process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number"
    ? constants.O_RDONLY | constants.O_NOFOLLOW
    : "r";
  const handle = await fs.open(filePath, flags).catch(() => {
    throw unsafePath(`${label} changed before it could be opened safely`);
  });
  try {
    const opened = await handle.stat({ bigint: true });
    await verifyDirectoryChain(expected.ancestors, label);
    const current = await fs.lstat(filePath, { bigint: true }).catch(() => undefined);
    if (current === undefined || current.isSymbolicLink() || !current.isFile()
      || current.dev !== expected.file.dev || current.ino !== expected.file.ino
      || !opened.isFile() || opened.dev !== expected.file.dev || opened.ino !== expected.file.ino) {
      throw unsafePath(`${label} changed before it could be read safely`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function captureDirectoryChain(root: string, target: string, label: string): Promise<DirectoryIdentity[]> {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw unsafePath(`${label} escaped the project`);
  const directories = [root];
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    directories.push(current);
  }
  const identities: DirectoryIdentity[] = [];
  for (const directory of directories) {
    const stat = await fs.lstat(directory, { bigint: true }).catch(() => undefined);
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unsafePath(`${label} must not contain symlinks`);
    }
    identities.push({ path: directory, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

async function verifyDirectoryChain(expected: readonly DirectoryIdentity[], label: string): Promise<void> {
  for (const directory of expected) {
    const stat = await fs.lstat(directory.path, { bigint: true }).catch(() => undefined);
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()
      || stat.dev !== directory.dev || stat.ino !== directory.ino) {
      throw unsafePath(`${label} changed before it could be read safely`);
    }
  }
}

async function assertPathChainHasNoSymlinks(root: string, target: string, label: string, allowMissingTail = false): Promise<void> {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw unsafePath(`${label} escaped the project`);
  let current = root;
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw unsafePath("Project directory must not be symlinked");
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (allowMissingTail && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) throw unsafePath(`${label} must not contain symlinks`);
  }
}

async function assertExistingOutputChainHasNoSymlinks(outputPath: string): Promise<void> {
  const parsed = path.parse(outputPath);
  const components = outputPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) throw unsafePath("Application package output path must not contain symlinks");
  }
}

async function verifyPreparedParent(prepared: PreparedPackageOutput): Promise<void> {
  await assertExistingOutputChainHasNoSymlinks(prepared.parent.path);
  const stat = await fs.lstat(prepared.parent.path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || stat.dev !== prepared.parent.dev || stat.ino !== prepared.parent.ino) {
    throw unsafePath("Application package output parent changed during publication");
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function unsafePath(message: string) {
  return lifecycleError("unsafe_project_path", message);
}

function packageOutputExists() {
  return lifecycleError("package_output_exists", "Application package output already exists; choose another path or explicitly enable overwrite");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof SyntaxError ? "malformed JSON" : error instanceof Error ? error.message : "unknown error";
}
