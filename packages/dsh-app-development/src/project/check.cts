import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  PLATFORM_CAPABILITIES,
  validateMigrationFilenames,
} from "../app-package-api.cjs";
import { lifecycleError } from "../project-errors.cjs";
import { validateAndCollectBackend, type ProjectBackendConfig } from "./backend.cjs";
import { collectProjectTree, readProjectJson, type ProjectFileReadHooks } from "./files.cjs";
import { isValidProjectName } from "./manifest.cjs";

export const CHECK_PHASES = ["project", "capabilities", "migrations", "backend", "tests", "build", "dist"] as const;
export type CheckPhase = typeof CHECK_PHASES[number];
export type CheckPhaseStatus = "not-run" | "passed" | "failed" | "skipped";

export interface CheckPhaseResult {
  phase: CheckPhase;
  status: CheckPhaseStatus;
}

export interface CheckDiagnostic {
  code: string;
  severity: "error" | "warning";
  phase: CheckPhase;
  message: string;
  file?: string;
  suggestion?: string;
}

export interface CheckReport {
  schemaVersion: 1;
  success: boolean;
  failedPhase?: CheckPhase;
  phases: CheckPhaseResult[];
  diagnostics: CheckDiagnostic[];
  project: { name?: string; packageManager?: PackageManager };
}

export interface ProjectCommandInvocation {
  command: PackageManager;
  args: string[];
  cwd: string;
  phase: "tests" | "build";
  signal?: AbortSignal;
}

export interface ProjectCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProjectCommandRunner = (invocation: ProjectCommandInvocation) => Promise<ProjectCommandResult>;
export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface CheckProjectOptions {
  projectDir: string;
  run?: ProjectCommandRunner;
  fileHooks?: ProjectFileReadHooks;
  signal?: AbortSignal;
}

export interface ValidatedProjectManifest {
  raw: Record<string, unknown>;
  name: string;
  distDir: string;
  platformVersion: string;
  backend?: ProjectBackendConfig;
  requires?: {
    content?: { mimeTypes: string[]; maxBytes?: number; inlinePreview: string[] };
    backend?: string;
    identity: string[];
    primitives: string[];
  };
}

const RESERVED_NAMES = new Set(["api", "serve", "health", "cli", "keys", "upload", "pages", "schemas"]);

export async function checkProject(options: CheckProjectOptions): Promise<CheckReport> {
  throwIfCheckAborted(options.signal);
  const projectDir = path.resolve(options.projectDir);
  const report = createReport();
  let manifest: ValidatedProjectManifest;
  try {
    manifest = await loadAndValidateProjectManifest(projectDir, options.fileHooks);
    throwIfCheckAborted(options.signal);
    report.project.name = manifest.name;
    pass(report, "project");
  } catch (error) {
    fail(report, "project", diagnosticForProjectError(error));
    return report;
  }

  const capabilityDiagnostics = validateCapabilities(manifest);
  if (capabilityDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    report.diagnostics.push(...capabilityDiagnostics);
    markFailed(report, "capabilities");
    return report;
  }
  report.diagnostics.push(...capabilityDiagnostics);
  pass(report, "capabilities");

  try {
    const migrations = await collectProjectTree({
      projectDir,
      configuredPath: "migrations",
      label: "migrations",
      required: false,
      hooks: options.fileHooks,
    });
    throwIfCheckAborted(options.signal);
    const validation = validateMigrationFilenames(migrations
      .filter((file) => file.relativePath.endsWith(".sql"))
      .map((file) => file.relativePath));
    if (!validation.valid) throw new Error(validation.errors.join("\n"));
    pass(report, "migrations");
  } catch (error) {
    fail(report, "migrations", errorDiagnostic("MIGRATION_VALIDATION_FAILED", "migrations", safeMessage(error), "migrations"));
    return report;
  }

  try {
    await validateAndCollectBackend({
      projectDir,
      config: manifest.backend,
      platformVersion: manifest.platformVersion,
      fileHooks: options.fileHooks,
    });
    throwIfCheckAborted(options.signal);
    pass(report, "backend");
  } catch (error) {
    fail(report, "backend", errorDiagnostic("BACKEND_CONTRACT_INVALID", "backend", safeMessage(error)));
    return report;
  }

  let packageJson: Record<string, unknown>;
  try {
    packageJson = await readProjectJson(projectDir, "package.json", options.fileHooks);
    report.project.packageManager = await detectPackageManager(projectDir, packageJson);
    throwIfCheckAborted(options.signal);
  } catch (error) {
    fail(report, "tests", errorDiagnostic("PACKAGE_JSON_INVALID", "tests", safeMessage(error), "package.json"));
    return report;
  }
  const scripts = readScripts(packageJson);
  const runner = options.run ?? runProjectCommand;
  if (scripts.test === undefined) {
    skip(report, "tests");
  } else {
    let result: ProjectCommandResult;
    try {
      result = await runScript(runner, report.project.packageManager, projectDir, "test", "tests", options.signal);
      throwIfCheckAborted(options.signal);
    } catch {
      throwIfCheckAborted(options.signal);
      fail(report, "tests", errorDiagnostic("APP_TEST_FAILED", "tests", "Could not run project test script"));
      return report;
    }
    if (result.exitCode !== 0) {
      fail(report, "tests", errorDiagnostic("APP_TEST_FAILED", "tests", `Project test script failed with exit code ${result.exitCode}`));
      return report;
    }
    pass(report, "tests");
  }

  if (scripts.build === undefined) {
    skip(report, "build");
  } else {
    let result: ProjectCommandResult;
    try {
      result = await runScript(runner, report.project.packageManager, projectDir, "build", "build", options.signal);
      throwIfCheckAborted(options.signal);
    } catch {
      throwIfCheckAborted(options.signal);
      fail(report, "build", errorDiagnostic("BUILD_FAILED", "build", "Could not run project build script"));
      return report;
    }
    if (result.exitCode !== 0) {
      fail(report, "build", errorDiagnostic("BUILD_FAILED", "build", `Project build script failed with exit code ${result.exitCode}`));
      return report;
    }
    pass(report, "build");
  }

  try {
    const dist = await collectProjectTree({
      projectDir,
      configuredPath: manifest.distDir,
      label: "distDir",
      required: true,
      hooks: options.fileHooks,
    });
    throwIfCheckAborted(options.signal);
    if (!dist.some((file) => file.relativePath === "index.html")) {
      throw new Error(`${manifest.distDir}/index.html is required`);
    }
    pass(report, "dist");
  } catch (error) {
    fail(report, "dist", errorDiagnostic("DIST_INVALID", "dist", safeMessage(error), `${manifest.distDir}/index.html`));
  }
  return report;
}

export async function loadAndValidateProjectManifest(
  projectDir: string,
  fileHooks?: ProjectFileReadHooks,
): Promise<ValidatedProjectManifest> {
  const raw = await readProjectJson(projectDir, "manifest.json", fileHooks);
  if (typeof raw.name !== "string" || !isValidProjectName(raw.name) || RESERVED_NAMES.has(raw.name)) {
    throw lifecycleError("PROJECT_NAME_INVALID", "manifest name is invalid");
  }
  const distDir = raw.distDir === undefined ? "dist" : requireString(raw.distDir, "manifest distDir");
  validateRelativeDirectory(distDir, "manifest distDir");
  const platformVersion = requireString(raw.platformVersion, "manifest platformVersion");
  const range = parsePlatformRange(platformVersion);
  const current = parseVersion(PLATFORM_CAPABILITIES.platformVersion);
  if (!range(current)) {
    throw lifecycleError("PLATFORM_VERSION_UNSUPPORTED", `Current platform does not satisfy manifest platformVersion`);
  }
  const backend = parseBackend(raw.backend);
  const requires = parseRequirements(raw.requires);
  return { raw, name: raw.name, distDir, platformVersion, backend, requires };
}

export async function detectPackageManager(projectDir: string, packageJson?: Record<string, unknown>): Promise<PackageManager> {
  const declared = packageJson?.packageManager;
  if (declared !== undefined) {
    if (typeof declared !== "string") throw new Error("package.json packageManager must be a string");
    const manager = declared.split("@", 1)[0];
    if (isPackageManager(manager)) return manager;
    throw new Error(`Unsupported package manager: ${manager}`);
  }
  const locks: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
  ];
  for (const [filename, manager] of locks) {
    if (await fs.access(path.join(projectDir, filename)).then(() => true, () => false)) return manager;
  }
  return "npm";
}

export async function runProjectCommand(invocation: ProjectCommandInvocation): Promise<ProjectCommandResult> {
  // Node refuses to spawn .cmd/.bat shims without a shell since the
  // CVE-2024-27980 fix; the arguments are fixed internal values, so a shell
  // spawn on win32 carries no injection surface.
  const isWindows = process.platform === "win32";
  const command = isWindows ? `${invocation.command}.cmd` : invocation.command;
  return new Promise((resolve, reject) => {
    const child = spawn(command, invocation.args, {
      cwd: invocation.cwd,
      shell: isWindows,
      stdio: "ignore",
      windowsHide: true,
      signal: invocation.signal,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ exitCode: code ?? 1, stdout: "", stderr: "" }));
  });
}

function createReport(): CheckReport {
  return {
    schemaVersion: 1,
    success: true,
    phases: CHECK_PHASES.map((phase) => ({ phase, status: "not-run" })),
    diagnostics: [],
    project: {},
  };
}

function pass(report: CheckReport, phase: CheckPhase): void {
  setStatus(report, phase, "passed");
}

function skip(report: CheckReport, phase: CheckPhase): void {
  setStatus(report, phase, "skipped");
}

function fail(report: CheckReport, phase: CheckPhase, diagnostic: CheckDiagnostic): void {
  report.diagnostics.push(diagnostic);
  markFailed(report, phase);
}

function markFailed(report: CheckReport, phase: CheckPhase): void {
  report.success = false;
  report.failedPhase = phase;
  setStatus(report, phase, "failed");
}

function setStatus(report: CheckReport, phase: CheckPhase, status: CheckPhaseStatus): void {
  const result = report.phases.find((item) => item.phase === phase);
  if (result !== undefined) result.status = status;
}

function errorDiagnostic(code: string, phase: CheckPhase, message: string, file?: string): CheckDiagnostic {
  return { code, severity: "error", phase, message, ...(file === undefined ? {} : { file }) };
}

function diagnosticForProjectError(error: unknown): CheckDiagnostic {
  const code = error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "PROJECT_MANIFEST_INVALID";
  return errorDiagnostic(code, "project", safeMessage(error), "manifest.json");
}

function validateCapabilities(manifest: ValidatedProjectManifest): CheckDiagnostic[] {
  if (manifest.requires === undefined) {
    return [{
      code: "REQUIRES_MISSING",
      severity: "warning",
      phase: "capabilities",
      message: "manifest.json does not declare requires; capability use cannot be fully verified",
      file: "manifest.json",
    }];
  }
  const diagnostics: CheckDiagnostic[] = [];
  const content = manifest.requires.content;
  if (content !== undefined) {
    for (const mimeType of content.mimeTypes) {
      if (!PLATFORM_CAPABILITIES.content.types.some((item) => item.mimeType === mimeType)) {
        diagnostics.push(errorDiagnostic("CAPABILITY_CONTENT_TYPE_UNSUPPORTED", "capabilities", `Target platform does not support content type ${mimeType}`, "manifest.json"));
      }
    }
    if (content.maxBytes !== undefined && content.maxBytes > PLATFORM_CAPABILITIES.content.upload.maxBytes) {
      diagnostics.push(errorDiagnostic("CAPABILITY_CONTENT_SIZE_EXCEEDED", "capabilities", "Required content size exceeds the target platform limit", "manifest.json"));
    }
    for (const mimeType of content.inlinePreview) {
      if (!PLATFORM_CAPABILITIES.content.types.some((item) => item.mimeType === mimeType && item.inlinePreview)) {
        diagnostics.push(errorDiagnostic("CAPABILITY_INLINE_PREVIEW_UNSUPPORTED", "capabilities", `Target platform cannot preview ${mimeType} inline`, "manifest.json"));
      }
    }
  }
  if (manifest.requires.backend !== undefined
    && (manifest.requires.backend !== "named-sql" || !PLATFORM_CAPABILITIES.backend.namedSql.enabled)) {
    diagnostics.push(errorDiagnostic("CAPABILITY_BACKEND_UNSUPPORTED", "capabilities", `Target platform does not support backend mode ${manifest.requires.backend}`, "manifest.json"));
  }
  const identities = new Map<string, boolean>([
    ["currentUser", PLATFORM_CAPABILITIES.identity.currentUser],
    ["pageOwner", PLATFORM_CAPABILITIES.identity.pageOwner],
    ["groups", PLATFORM_CAPABILITIES.identity.groups],
  ]);
  for (const identity of manifest.requires.identity) {
    if (identities.get(identity) !== true) diagnostics.push(errorDiagnostic("CAPABILITY_IDENTITY_UNSUPPORTED", "capabilities", `Target platform does not provide identity context ${identity}`, "manifest.json"));
  }
  for (const primitive of manifest.requires.primitives) {
    const supported = (primitive === "crdt" && PLATFORM_CAPABILITIES.collaboration.crdt.enabled)
      || (primitive === "editing-awareness-overlay" && PLATFORM_CAPABILITIES.collaboration.crdt.editingOverlay);
    if (!supported) {
      diagnostics.push(errorDiagnostic("CAPABILITY_PRIMITIVE_UNSUPPORTED", "capabilities", `Target platform does not declare primitive ${primitive}`, "manifest.json"));
    }
  }
  const collaboration = isRecord(manifest.raw.collaboration) ? manifest.raw.collaboration : undefined;
  const resources = isRecord(collaboration?.resources) ? collaboration.resources : undefined;
  const crdtResources = resources
    ? Object.values(resources).filter((resource) => isRecord(resource) && resource.mode === "crdt")
    : [];
  if (collaboration?.enabled === true && crdtResources.length > 0) {
    if (!manifest.requires.primitives.includes("crdt")) {
      diagnostics.push(errorDiagnostic("CAPABILITY_REQUIREMENT_MISSING", "capabilities", "CRDT collaboration must declare requires.primitives: crdt", "manifest.json"));
    }
    const usesOverlay = collaboration.overlay !== false && crdtResources.some((resource) =>
      isRecord(resource) && resource.awareness !== false && resource.overlay !== false,
    );
    if (usesOverlay && !manifest.requires.primitives.includes("editing-awareness-overlay")) {
      diagnostics.push(errorDiagnostic("CAPABILITY_REQUIREMENT_MISSING", "capabilities", "CRDT editing overlay must declare requires.primitives: editing-awareness-overlay", "manifest.json"));
    }
    const minimum = minimumPlatformVersion(manifest.platformVersion);
    if (!minimum || compareVersion(minimum, [1, 3, 0]) < 0) {
      diagnostics.push(errorDiagnostic("CAPABILITY_PLATFORM_VERSION_TOO_LOW", "capabilities", "CRDT collaboration requires platformVersion ^1.3 or a range with minimum 1.3", "manifest.json"));
    }
  }
  return diagnostics;
}

function minimumPlatformVersion(range: string): [number, number, number] | null {
  const trimmed = range.trim();
  if (trimmed.startsWith("^")) return parseVersion(trimmed.slice(1));
  const match = /^>=\s*([^\s,]+)\s*,?\s*<\s*([^\s,]+)$/.exec(trimmed);
  return match ? parseVersion(match[1]) : null;
}

function parseBackend(value: unknown): ProjectBackendConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("manifest backend must be an object");
  const root = value.root === undefined ? undefined : requireString(value.root, "manifest backend.root");
  const include = value.include === undefined ? undefined : requireStringArray(value.include, "manifest backend.include");
  return { ...(root === undefined ? {} : { root }), ...(include === undefined ? {} : { include }) };
}

function parseRequirements(value: unknown): ValidatedProjectManifest["requires"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("manifest requires must be an object");
  let content: NonNullable<ValidatedProjectManifest["requires"]>["content"];
  if (value.content !== undefined) {
    if (!isRecord(value.content)) throw new Error("manifest requires.content must be an object");
    const maxBytes = value.content.maxBytes;
    if (maxBytes !== undefined && (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
      throw new Error("manifest requires.content.maxBytes must be a positive integer");
    }
    content = {
      mimeTypes: value.content.mimeTypes === undefined ? [] : requireStringArray(value.content.mimeTypes, "manifest requires.content.mimeTypes"),
      ...(maxBytes === undefined ? {} : { maxBytes }),
      inlinePreview: value.content.inlinePreview === undefined ? [] : requireStringArray(value.content.inlinePreview, "manifest requires.content.inlinePreview"),
    };
  }
  return {
    ...(content === undefined ? {} : { content }),
    ...(value.backend === undefined ? {} : { backend: requireString(value.backend, "manifest requires.backend") }),
    identity: value.identity === undefined ? [] : requireStringArray(value.identity, "manifest requires.identity"),
    primitives: value.primitives === undefined ? [] : requireStringArray(value.primitives, "manifest requires.primitives"),
  };
}

function parsePlatformRange(range: string): (version: [number, number, number]) => boolean {
  const trimmed = range.trim();
  if (trimmed.startsWith("^")) {
    const minimum = parseVersion(trimmed.slice(1));
    const maximum: [number, number, number] = minimum[0] > 0
      ? [minimum[0] + 1, 0, 0]
      : minimum[1] > 0 ? [0, minimum[1] + 1, 0] : [0, 0, minimum[2] + 1];
    return (version) => compareVersion(version, minimum) >= 0 && compareVersion(version, maximum) < 0;
  }
  const match = /^>=\s*([^\s,]+)\s*,?\s*<\s*([^\s,]+)$/.exec(trimmed);
  if (match !== null) {
    const minimum = parseVersion(match[1]);
    const maximum = parseVersion(match[2]);
    return (version) => compareVersion(version, minimum) >= 0 && compareVersion(version, maximum) < 0;
  }
  throw lifecycleError("PLATFORM_VERSION_INVALID", "manifest platformVersion must use a supported range such as ^1.2 or >=1.2 <2.0");
}

function parseVersion(value: string): [number, number, number] {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (match === null) throw lifecycleError("PLATFORM_VERSION_INVALID", "manifest platformVersion contains an invalid semantic version");
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function validateRelativeDirectory(value: string, label: string): void {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..") || normalized.split("/").filter((part) => part && part !== ".").length === 0) {
    throw new Error(`${label} must be a relative directory inside the project`);
  }
}

function readScripts(packageJson: Record<string, unknown>): Record<string, string | undefined> {
  if (packageJson.scripts === undefined) return {};
  if (!isRecord(packageJson.scripts)) throw new Error("package.json scripts must be an object");
  const result: Record<string, string | undefined> = {};
  for (const name of ["test", "build"]) {
    const value = packageJson.scripts[name];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error(`package.json scripts.${name} must be a non-empty string`);
    result[name] = value as string | undefined;
  }
  return result;
}

function runScript(
  runner: ProjectCommandRunner,
  manager: PackageManager | undefined,
  cwd: string,
  script: "test" | "build",
  phase: "tests" | "build",
  signal?: AbortSignal,
): Promise<ProjectCommandResult> {
  if (manager === undefined) throw new Error("Package manager detection did not complete");
  return runner({ command: manager, args: ["run", script], cwd, phase, ...(signal === undefined ? {} : { signal }) });
}

function throwIfCheckAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Project validation aborted");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} must be an array of non-empty strings`);
  return value as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPackageManager(value: string): value is PackageManager {
  return value === "pnpm" || value === "npm" || value === "yarn" || value === "bun";
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Project validation failed";
}
