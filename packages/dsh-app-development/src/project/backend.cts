import path from "node:path";
import {
  loadBackendContract,
  validateBackendContract,
  type BackendManifestConfig,
} from "../app-package-api.cjs";
import {
  collectProjectTree,
  normalizeArchiveRelativePath,
  readVerifiedFile,
  resolveProjectDirectory,
  type CollectedProjectFile,
  type ProjectFileReadHooks,
} from "./files.cjs";

export interface ProjectBackendConfig extends BackendManifestConfig {
  root?: string;
  include?: string[];
}

export async function validateAndCollectBackend(options: {
  projectDir: string;
  config?: ProjectBackendConfig;
  platformVersion: string;
  fileHooks?: ProjectFileReadHooks;
}): Promise<CollectedProjectFile[]> {
  if (options.config === undefined) return [];
  validateBackendConfig(options.config);
  const rootName = options.config.root ?? "backend";

  if (!options.config.include?.length) {
    await collectProjectTree({
      projectDir: options.projectDir,
      configuredPath: rootName,
      label: "backend root",
      required: true,
      hooks: options.fileHooks,
    });
  } else {
    await resolveProjectDirectory({
      projectDir: options.projectDir,
      configuredPath: rootName,
      label: "backend root",
      required: false,
    });
  }

  const contract = loadBackendContract(options.projectDir, options.config);
  validateBackendContract(contract, { requireSecurity: requiresSecurity(options.platformVersion) });
  const normalizedRoot = normalizeArchiveRelativePath(rootName, "backend root");
  const files: CollectedProjectFile[] = [];
  for (const file of contract.files) {
    const projectRelative = normalizeArchiveRelativePath(file.relativePath, "backend file");
    const rootPrefix = `${normalizedRoot}/`;
    const relativePath = projectRelative.startsWith(rootPrefix)
      ? projectRelative.slice(rootPrefix.length)
      : projectRelative;
    files.push({
      absolutePath: file.absolutePath,
      relativePath,
      content: await readVerifiedFile(options.projectDir, file.absolutePath, `backend file ${projectRelative}`, options.fileHooks),
    });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function validateBackendConfig(config: ProjectBackendConfig): void {
  if (config.root !== undefined && (typeof config.root !== "string" || !config.root.trim())) {
    throw new Error("manifest backend.root must be a non-empty string");
  }
  if (config.include !== undefined
    && (!Array.isArray(config.include) || config.include.some((item) => typeof item !== "string" || !item.trim()))) {
    throw new Error("manifest backend.include must be an array of non-empty strings");
  }
  for (const pattern of config.include ?? []) {
    const normalized = pattern.replaceAll("\\", "/");
    if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`manifest backend.include must stay inside the project: ${pattern}`);
    }
  }
}

function requiresSecurity(range: string): boolean {
  const minimum = minimumVersion(range);
  return minimum[0] > 1 || minimum[0] === 1 && minimum[1] >= 1;
}

function minimumVersion(range: string): [number, number, number] {
  const value = range.trim().startsWith("^")
    ? range.trim().slice(1)
    : range.trim().slice(2).split(/[ ,<]/, 1)[0];
  const [major = 0, minor = 0, patch = 0] = value.split(".").map(Number);
  return [major, minor, patch];
}
