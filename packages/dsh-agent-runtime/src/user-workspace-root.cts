import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

function checkWorkspacePath(filename: string, kind: "directory" | "file"): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) throw new Error("Invalid user workspace path: " + filename);
}

/** Retain an existing directory while model selection stops defining storage identity. */
export class LegacyHistoryMigrationRequired extends Error {}

export function userWorkspaceRoot(dataDir: string, userId: string, applicationId: string, providerId: string, providers: string[]): string {
  const hash = (values: string[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
  const directory = path.join(dataDir, "agent");
  const associations = path.join(directory, "associations");
  checkWorkspacePath(directory, "directory");
  checkWorkspacePath(associations, "directory");
  fs.mkdirSync(associations, { recursive: true, mode: 0o700 });
  const association = path.join(associations, hash([userId, applicationId]) + ".json");
  checkWorkspacePath(association, "file");
  if (fs.existsSync(association)) {
    const stored = JSON.parse(fs.readFileSync(association, "utf8"));
    if (stored.version !== 1 || !/^[a-f0-9]{64}$/.test(stored.directory)) throw new Error("Invalid user workspace association");
    const root = path.join(directory, stored.directory);
    checkWorkspacePath(root, "directory");
    checkWorkspacePath(path.join(root, "sessions"), "directory");
    return root;
  }
  const previous = providers.map(id => hash([userId, applicationId, id])).filter(id => {
    const root = path.join(directory, id);
    checkWorkspacePath(root, "directory");
    checkWorkspacePath(path.join(root, "sessions"), "directory");
    return fs.existsSync(path.join(root, "sessions"));
  });
  const populated = previous.filter(id => fs.readdirSync(path.join(directory, id, "sessions")).length > 0);
  if (populated.length > 1) throw new LegacyHistoryMigrationRequired("Multiple legacy provider histories require migration before switching models");
  const selected = populated[0] ?? hash([userId, applicationId, providerId]);
  checkWorkspacePath(path.join(directory, selected), "directory");
  const temporary = association + "." + randomUUID();
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, directory: selected }) + "\n", { flag: "wx", mode: 0o600 });
    try { fs.linkSync(temporary, association); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another process published first. Re-read and validate its association.
      return userWorkspaceRoot(dataDir, userId, applicationId, providerId, providers);
    }
  } finally { fs.rmSync(temporary, { force: true }); }
  return path.join(directory, selected);
}
