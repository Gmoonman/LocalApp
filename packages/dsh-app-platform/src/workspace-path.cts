import fs from "node:fs";
import path from "node:path";

function isConfined(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function boundaryError(relativePath: string): Error {
  return new Error(`Path crosses workspace boundary: ${relativePath}`);
}

/** Resolve a relative path while confining both lexical and real paths to a workspace. */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const realRoot = fs.realpathSync(path.resolve(workspaceRoot));
  if (path.isAbsolute(relativePath)) throw boundaryError(relativePath);

  const candidate = path.resolve(realRoot, relativePath || ".");
  if (!isConfined(realRoot, candidate)) throw boundaryError(relativePath);

  let existingAncestor = candidate;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) throw boundaryError(relativePath);
    existingAncestor = parent;
  }

  const realAncestor = fs.realpathSync(existingAncestor);
  if (!isConfined(realRoot, realAncestor)) throw boundaryError(relativePath);

  if (fs.existsSync(candidate)) {
    const realCandidate = fs.realpathSync(candidate);
    if (!isConfined(realRoot, realCandidate)) throw boundaryError(relativePath);
  }

  return candidate;
}
