import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocalAppPackage } from "./build-package.mjs";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagingDirectory = path.join(packageDirectory, ".localapp-pack");

await fs.rm(path.join(packageDirectory, "bin"), { recursive: true, force: true });
await fs.rm(path.join(packageDirectory, ".localapp-artifact.json"), { force: true });
await fs.rm(path.join(packageDirectory, "template"), { recursive: true, force: true });
await fs.rm(path.join(packageDirectory, "runtime"), { recursive: true, force: true });
await fs.rm(path.join(packageDirectory, "plugins"), { recursive: true, force: true });
const artifact = await buildLocalAppPackage({ outputDirectory: stagingDirectory });
await fs.cp(path.join(artifact.outputDirectory, "bin"), path.join(packageDirectory, "bin"), { recursive: true });
await fs.cp(path.join(artifact.outputDirectory, "template"), path.join(packageDirectory, "template"), { recursive: true });
await fs.cp(path.join(artifact.outputDirectory, "runtime"), path.join(packageDirectory, "runtime"), { recursive: true });
await fs.cp(path.join(artifact.outputDirectory, "plugins"), path.join(packageDirectory, "plugins"), { recursive: true });
await fs.copyFile(artifact.manifestPath, path.join(packageDirectory, ".localapp-artifact.json"));
