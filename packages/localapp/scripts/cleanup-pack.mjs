import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await Promise.all([
  fs.rm(path.join(packageDirectory, "bin"), { recursive: true, force: true }),
  fs.rm(path.join(packageDirectory, ".localapp-artifact.json"), { force: true }),
  fs.rm(path.join(packageDirectory, "template"), { recursive: true, force: true }),
  fs.rm(path.join(packageDirectory, "runtime"), { recursive: true, force: true }),
  fs.rm(path.join(packageDirectory, "plugins"), { recursive: true, force: true }),
  fs.rm(path.join(packageDirectory, ".localapp-pack"), { recursive: true, force: true }),
]);
