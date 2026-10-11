import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BusinessMetadata, DataSchema, PageAccess, ManifestDb, RouteAccess, ShellConfig, NotifyConfig, CollaborationConfig, AppLifecycle } from "./models.cjs";
import { getDirectorySize } from "./file-utils.cjs";
import { recoverSourceManifestAndMeta } from "./app-manifest.cjs";
import type { IssueTemplateConfig } from "./issue-templates.cjs";

export interface PageMeta {
  name: string;
  userId: string;
  description: string;
  currentVersion: number;
  currentAppVersion?: string;
  previousVersion?: number;
  createdAt: string;
  updatedAt: string;
  versions: PageVersionMeta[];
  packageIdentities?: Record<string, { digest: string; version: number }>;
  metadata: Record<string, unknown>;
  pageAccess?: PageAccess;
  schemas?: DataSchema[];
  business?: Record<string, BusinessMetadata & { routeAccess?: RouteAccess }>;
  db?: ManifestDb;
  backend?: {
    root?: string;
    include?: string[];
  };
  shell?: ShellConfig;
  notify?: NotifyConfig;
  collaboration?: CollaborationConfig;
  issues?: { templates: IssueTemplateConfig[] };
  lifecycle?: AppLifecycle;
  status?: "needs-migration-repair";
}

export interface PageVersionMeta {
  version: number;
  appVersion?: string;
  digest?: string;
  packagePath?: string;
  createdAt: string;
  fileCount: number;
  totalSize: number;
  uploaderId?: string;
  uploaderDisplayName?: string;
  issues?: { templates: IssueTemplateConfig[] };
  manifest?: Record<string, unknown>;
}

export function getPageDir(dataDir: string, userId: string, name: string): string {
  return path.join(dataDir, userId, name);
}

export function getPageMetaPath(dataDir: string, userId: string, name: string): string {
  return path.join(getPageDir(dataDir, userId, name), "meta.json");
}

export function readPageMeta(dataDir: string, userId: string, name: string): PageMeta | null {
  const metaPath = getPageMetaPath(dataDir, userId, name);
  recoverSourceManifestAndMeta(path.dirname(metaPath), metaPath);
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as PageMeta;
  if (backfillLegacyVersionIdentities(path.dirname(metaPath), meta)) {
    writePageMeta(dataDir, userId, name, meta);
  }
  return meta;
}

export function writePageMeta(dataDir: string, userId: string, name: string, meta: PageMeta): void {
  const metaPath = getPageMetaPath(dataDir, userId, name);
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  const temporary = `${metaPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(meta, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporary, metaPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function resolveVersionPublisher(
  meta: PageMeta,
  versionNumber = meta.currentVersion,
): { userId: string; displayName?: string } {
  const version = meta.versions.find((entry) => entry.version === versionNumber);
  if (!version?.uploaderId) return { userId: meta.userId };

  return {
    userId: version.uploaderId,
    ...(version.uploaderDisplayName ? { displayName: version.uploaderDisplayName } : {}),
  };
}

export function getUserTotalSize(dataDir: string, userId: string): number {
  const userDir = path.join(dataDir, userId);
  if (!fs.existsSync(userDir)) return 0;
  return getDirectorySize(userDir);
}

export function readDbConfig(dataDir: string, userId: string, name: string): ManifestDb {
  const meta = readPageMeta(dataDir, userId, name);
  return meta?.db ?? { mode: "crud", sqlAccess: "owner", defaultAccess: { read: "public", create: "public", update: "public", delete: "public" } };
}

function backfillLegacyVersionIdentities(pageDir: string, meta: PageMeta): boolean {
  let changed = false;
  const identities = { ...(meta.packageIdentities ?? {}) };
  for (const version of meta.versions) {
    if (!version.appVersion) {
      version.appVersion = `legacy-${version.version}`;
      changed = true;
    }
    if (!version.digest) {
      version.digest = digestDeploymentDirectory(path.join(pageDir, "versions", `v${version.version}`));
      changed = true;
    }
    if (!identities[version.appVersion]) {
      identities[version.appVersion] = { digest: version.digest, version: version.version };
      changed = true;
    }
  }
  if (Object.keys(identities).length > 0 && JSON.stringify(meta.packageIdentities) !== JSON.stringify(identities)) {
    meta.packageIdentities = identities;
    changed = true;
  }
  if (!meta.currentAppVersion) {
    const current = meta.versions.find((version) => version.version === meta.currentVersion);
    if (current?.appVersion) {
      meta.currentAppVersion = current.appVersion;
      changed = true;
    }
  }
  return changed;
}

function digestDeploymentDirectory(directory: string): string {
  const hash = crypto.createHash("sha256");
  const visit = (current: string, relative = ""): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath, entryRelative);
      else if (entry.isFile()) {
        hash.update(entryRelative);
        hash.update("\0");
        hash.update(fs.readFileSync(entryPath));
        hash.update("\0");
      }
    }
  };
  if (fs.existsSync(directory)) visit(directory);
  else hash.update(`missing:${directory}`);
  return hash.digest("hex");
}
