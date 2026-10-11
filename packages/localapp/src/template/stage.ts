import fs from "node:fs/promises";
import path from "node:path";
import { copyDirectory, TEMPLATE_EXCLUDED_NAMES } from "./copy.js";
import { postprocessTemplatePackageJson } from "./package-json.js";

export interface StageBuiltinTemplateOptions {
  repositoryRoot: string;
  outputDirectory: string;
  version: string;
}

export async function stageBuiltinTemplate({ repositoryRoot, outputDirectory, version }: StageBuiltinTemplateOptions): Promise<void> {
  const initRepository = path.join(repositoryRoot, "init-repo");
  const serverCore = path.join(repositoryRoot, "packages/server-core");
  const serverCoreEntry = path.join(serverCore, "dist/index.js");
  if (!await isFile(serverCoreEntry)) {
    throw new Error(`Server Core build output is missing at ${serverCoreEntry}; run pnpm -C packages/server-core build first`);
  }

  await fs.rm(outputDirectory, { recursive: true, force: true });
  await copyDirectory(initRepository, outputDirectory, TEMPLATE_EXCLUDED_NAMES);
  await preserveProjectGitignore(outputDirectory);
  await preserveProjectNpmrc(outputDirectory);

  await stageRuntimePackage(repositoryRoot, outputDirectory, "sdk-core", "core");
  await stageRuntimePackage(repositoryRoot, outputDirectory, "sdk-react", "react");
  await stageRuntimePackage(repositoryRoot, outputDirectory, "sdk-agent", "agent");
  await stageRuntimePackage(repositoryRoot, outputDirectory, "crdt", "crdt");
  await stageRuntimePackage(repositoryRoot, outputDirectory, "backend", "backend");

  const serverCoreDestination = path.join(outputDirectory, "runtime/server-core");
  await fs.mkdir(serverCoreDestination, { recursive: true });
  await fs.copyFile(path.join(serverCore, "package.json"), path.join(serverCoreDestination, "package.json"));
  await copyDirectory(path.join(serverCore, "dist"), path.join(serverCoreDestination, "dist"));
  await stageServerCorePlatform(repositoryRoot, serverCoreDestination);
  await fs.copyFile(
    path.join(repositoryRoot, "packages/localapp/src/template/sync-template.cjs"),
    path.join(outputDirectory, "runtime/sync-template.cjs"),
  );
  await fs.copyFile(
    path.join(repositoryRoot, "packages/localapp/src/template/sync-template-command.cjs"),
    path.join(outputDirectory, "runtime/sync-template-command.cjs"),
  );
  await fs.writeFile(path.join(outputDirectory, "runtime/version.json"), `${JSON.stringify({ cliVersion: version }, null, 2)}\n`);
  await postprocessTemplatePackageJson(outputDirectory);
}

async function stageRuntimePackage(repositoryRoot: string, outputDirectory: string, packageName: string, runtimeName: string): Promise<void> {
  await copyDirectory(
    path.join(repositoryRoot, "packages", packageName),
    path.join(outputDirectory, "runtime/sdk", runtimeName),
    TEMPLATE_EXCLUDED_NAMES,
  );
}

async function isFile(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then((stat) => stat.isFile(), () => false);
}

async function preserveProjectGitignore(outputDirectory: string): Promise<void> {
  const source = path.join(outputDirectory, ".gitignore");
  const destination = path.join(outputDirectory, "template.gitignore");
  if (await isFile(source)) await fs.rename(source, destination);
}

async function preserveProjectNpmrc(outputDirectory: string): Promise<void> {
  const source = path.join(outputDirectory, ".npmrc");
  const destination = path.join(outputDirectory, "template.npmrc");
  if (await isFile(source)) await fs.rename(source, destination);
}

// The compatibility SDK delegates to the application plugin in the monorepo.
// Generated applications must carry those implementations instead of asking npm
// for a private workspace package.
async function stageServerCorePlatform(repositoryRoot: string, destination: string): Promise<void> {
  const dist = path.join(destination, "dist");
  const platform = path.join(dist, "platform");
  await copyDirectory(path.join(repositoryRoot, "packages/dsh-app-platform/dist"), platform);
  async function rewrite(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (file === platform) continue;
      if (entry.isDirectory()) await rewrite(file);
      else if (entry.isFile() && /\.(?:js|ts)$/.test(entry.name)) {
        const original = await fs.readFile(file, "utf8");
        const updated = original.replace(/@localapp\/dsh-app-platform\/([a-z-]+)/g, (_match, module: string) => {
          const relative = path.relative(path.dirname(file), path.join(platform, `${module}.cjs`)).split(path.sep).join("/");
          return relative.startsWith(".") ? relative : `./${relative}`;
        });
        if (updated !== original) await fs.writeFile(file, updated);
      }
    }
  }
  await rewrite(dist);
  const manifestPath = path.join(destination, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  delete manifest.dependencies["@localapp/dsh-app-platform"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
