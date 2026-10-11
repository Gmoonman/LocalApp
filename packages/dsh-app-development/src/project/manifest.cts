import fs from "node:fs/promises";
import path from "node:path";

export interface ProjectManifest {
  name: string;
  description: string;
  distDir: "dist";
  db: { mode: "crud"; sqlAccess: "authenticated" };
  backend: { root: "backend" };
  requires: { backend: "named-sql"; identity: ["currentUser", "pageOwner"]; primitives: [] };
  platformVersion: "^1.2";
}

export async function writeProjectManifest(projectDirectory: string, name: string, description?: string): Promise<ProjectManifest> {
  const manifest: ProjectManifest = {
    name,
    description: description ?? "",
    distDir: "dist",
    db: { mode: "crud", sqlAccess: "authenticated" },
    backend: { root: "backend" },
    requires: { backend: "named-sql", identity: ["currentUser", "pageOwner"], primitives: [] },
    platformVersion: "^1.2",
  };
  await fs.writeFile(path.join(projectDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function isValidProjectName(name: string): boolean {
  return /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(name) && !name.includes("--");
}
