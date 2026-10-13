import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, "..");
const projectDirectory = path.resolve(process.env.LOCALAPP_REPOSITORY_ROOT ?? path.resolve(packageDirectory, "../.."));
const defaultOutputDirectory = path.join(projectDirectory, "tmp/localapp-package");

/**
 * Builds the self-contained public localapp npm package directory.
 * @param {{ outputDirectory?: string }} [options]
 */
export async function buildLocalAppPackage(options = {}) {
  const outputDirectory = path.resolve(options.outputDirectory ?? process.env.LOCALAPP_PACKAGE_DIR ?? defaultOutputDirectory);
  const binDirectory = path.join(outputDirectory, "bin");
  const sourceManifest = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"));
  const releaseTargets = JSON.parse(await fs.readFile(path.join(projectDirectory, "packages/shared/release-targets.json"), "utf8"));
  const npmPackage = readNpmPackageTarget(releaseTargets);
  if (npmPackage.name !== sourceManifest.name) throw new Error("release target npm package does not match package manifest");

  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(binDirectory, { recursive: true, mode: 0o755 });
  await Promise.all([
    fs.copyFile(path.join(projectDirectory, "README.md"), path.join(outputDirectory, "README.md")),
    fs.copyFile(path.join(projectDirectory, "LICENSE"), path.join(outputDirectory, "LICENSE")),
  ]);
  await stageBuiltinTemplate({ outputDirectory, version: sourceManifest.version });
  const nativeOutputDirectory = path.join(outputDirectory, "runtime", "native");
  const prebuiltNativeAdaptersDirectory = options.prebuiltNativeAdaptersDirectory ?? process.env.LOCALAPP_PREBUILT_NATIVE_ADAPTERS_DIR;
  let nativeManifest;
  if (prebuiltNativeAdaptersDirectory) {
    const requiredTargets = releaseTargets.nativeAdapters?.map((entry) => entry.target);
    if (!Array.isArray(requiredTargets)) throw new Error("release native adapter matrix is unavailable");
    const { mergePrebuiltNativeAdapters } = await import(pathToFileURL(path.join(packageDirectory, "scripts/merge-native-adapters.mjs")).href);
    nativeManifest = await mergePrebuiltNativeAdapters({
      sourceDirectory: prebuiltNativeAdaptersDirectory,
      outputDirectory: nativeOutputDirectory,
      requiredTargets,
    });
  } else {
    const { buildNativeAdapter } = await import(pathToFileURL(path.join(packageDirectory, "scripts/build-native-adapter.mjs")).href);
    await buildNativeAdapter({ outputDirectory: nativeOutputDirectory });
    nativeManifest = JSON.parse(await fs.readFile(path.join(nativeOutputDirectory, "adapter-manifest.json"), "utf8"));
  }
  const { buildServerPackage } = await import(pathToFileURL(path.join(projectDirectory, "packages/server/scripts/build-server-package.mjs")).href);
  const serverArtifact = await buildServerPackage({ outputDirectory: path.join(outputDirectory, "runtime/server") });
  const pluginExports = {};
  const pluginDirectory = path.join(outputDirectory, "plugins");
  await fs.mkdir(pluginDirectory, { recursive: true });
  for (const [name, packageName, client] of [
    ["multiuser", "dsh-multiuser", true],
    ["model-settings", "dsh-model-settings", false],
    ["agent-runtime", "dsh-agent-runtime", false],
    ["agent-settings", "dsh-agent-settings", false],
    ["execution-environment", "dsh-execution-environment", false],
    ["app-sync", "dsh-app-sync", false],
    ["collaboration", "dsh-collaboration", false],
    ["device-services", "dsh-device-services", false],

    ["agent-ui", "dsh-agent-ui", true],
    ["applications", "dsh-app-platform", true],
    ["development", "dsh-app-development", true],
    ["documents", "dsh-document-tools", false],
  ]) {
    const entry = `../runtime/server/node_modules/@localapp/${packageName}/dist/index.mjs`;
    const resources = client ? `export const clientHostUrl = new URL('../runtime/server/node_modules/@localapp/${packageName}/dist/${name === "multiuser" ? "index" : "client-host"}.mjs', import.meta.url).href;\n` : "";
    await fs.writeFile(path.join(pluginDirectory, `${name}.mjs`), `export { default } from ${JSON.stringify(entry)};\nexport * from ${JSON.stringify(entry)};\n${resources}`);
    await fs.writeFile(path.join(pluginDirectory, `${name}.d.mts`), `export { default } from ${JSON.stringify(entry)};\nexport * from ${JSON.stringify(entry)};\n${client ? "export declare const clientHostUrl: string;\n" : ""}`);
    pluginExports[`./plugins/${name}`] = { types: `./plugins/${name}.d.mts`, import: `./plugins/${name}.mjs`, default: `./plugins/${name}.mjs` };
  }
  await build({
    absWorkingDir: projectDirectory,
    alias: {
      "@localapp/server/app-package-api": path.join(projectDirectory, "packages/server/src/app-package-api.ts"),
      "@localapp/server/device-action-ticket": path.join(projectDirectory, "packages/server/src/device-action-ticket.ts"),
      "@localapp/server/project-api": path.join(projectDirectory, "packages/server/src/project-api.ts"),
      "@localapp/server/project-api/backend": path.join(projectDirectory, "packages/server/src/project/backend.ts"),
      "@localapp/server/project-api/check": path.join(projectDirectory, "packages/server/src/project/check.ts"),
      "@localapp/server/project-api/files": path.join(projectDirectory, "packages/server/src/project/files.ts"),
      "@localapp/server/project-api/manifest": path.join(projectDirectory, "packages/server/src/project/manifest.ts"),
      "@localapp/server/project-api/package": path.join(projectDirectory, "packages/server/src/project/package.ts"),
      "@localapp/server-core": path.join(projectDirectory, "packages/server-core/src/index.ts"),
    },
    bundle: true,
    entryPoints: [path.join(packageDirectory, "src/main.ts")],
    format: "esm",
    legalComments: "none",
    outfile: path.join(binDirectory, "localapp.mjs"),
    platform: "node",
    sourcemap: false,
    target: "node24",
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __localAppCreateRequire } from 'node:module';\nconst require = __localAppCreateRequire(import.meta.url);",
    },
  });
  await fs.chmod(path.join(binDirectory, "localapp.mjs"), 0o755);

  const packageJson = {
    name: npmPackage.name,
    version: sourceManifest.version,
    description: sourceManifest.description,
    license: sourceManifest.license,
    repository: sourceManifest.repository,
    homepage: sourceManifest.homepage,
    bugs: sourceManifest.bugs,
    type: "module",
    bin: { localapp: "bin/localapp.mjs" },
    exports: pluginExports,
    engines: { node: ">=24" },
  };
  const bootstrapEntrypoint = "runtime/bootstrap/localapp-daemon-bootstrap.mjs";
  const bootstrapPath = path.join(outputDirectory, bootstrapEntrypoint);
  await fs.mkdir(path.dirname(bootstrapPath), { recursive: true, mode: 0o755 });
  await fs.writeFile(bootstrapPath, daemonBootstrapSource(npmPackage.name), { mode: 0o755 });
  await fs.chmod(bootstrapPath, 0o755);
  const manifestPath = path.join(outputDirectory, ".localapp-artifact.json");
  await writeJson(path.join(outputDirectory, "package.json"), packageJson);
  const files = await collectArtifactFiles(outputDirectory);
  const artifactDescriptor = {
    schemaVersion: 2,
    name: packageJson.name,
    version: packageJson.version,
    nodeMajor: 24,
    entrypoint: "bin/localapp.mjs",
    bootstrapEntrypoint,
    files,
    bundleDigest: await sha256(path.join(binDirectory, "localapp.mjs")),
    serverBundleDigest: serverArtifact.bundleDigest,
    serverEntrypoint: "runtime/server/bin/server.mjs",
    protocolVersions: { deviceAction: 2, notificationDelivery: 2, peerSync: 1 },
    nativeAdapters: nativeManifest.schemaVersion === 2 ? nativeManifest.adapters : [{
      target: nativeManifest.target,
      signing: nativeManifest.signing,
      assets: nativeManifest.assets,
    }],
  };
  await writeJson(manifestPath, {
    ...artifactDescriptor,
    artifactDigest: sha256Bytes(Buffer.from(JSON.stringify(artifactDescriptor))),
  });

  return { outputDirectory, tarballInput: outputDirectory, manifestPath };
}

function readNpmPackageTarget(value) {
  const npmPackage = value?.npmPackage;
  if (!npmPackage || typeof npmPackage.name !== "string" || npmPackage.name.length === 0
    || typeof npmPackage.filenameTemplate !== "string" || !npmPackage.filenameTemplate.includes("{version}")) {
    throw new Error("release npm package target is unavailable");
  }
  return npmPackage;
}

async function stageBuiltinTemplate({ outputDirectory, version }) {
  const stagingEntrypoint = path.join(outputDirectory, ".stage-template.mjs");
  await build({
    absWorkingDir: projectDirectory,
    bundle: true,
    entryPoints: [path.join(packageDirectory, "src/template/stage.ts")],
    format: "esm",
    legalComments: "none",
    outfile: stagingEntrypoint,
    platform: "node",
    sourcemap: false,
    target: "node24",
  });
  try {
    const { stageBuiltinTemplate: stage } = await import(pathToFileURL(stagingEntrypoint).href);
    await stage({ repositoryRoot: projectDirectory, outputDirectory: path.join(outputDirectory, "template"), version });
  } finally {
    await fs.rm(stagingEntrypoint, { force: true });
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function collectArtifactFiles(root) {
  const files = [];
  const visit = async (directory, prefix) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relativePath === ".localapp-artifact.json") continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed in LocalApp artifact: ${relativePath}`);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`unsupported LocalApp artifact entry: ${relativePath}`);
      const before = await fs.lstat(absolutePath, { bigint: true });
      const bytes = await fs.readFile(absolutePath);
      const after = await fs.lstat(absolutePath, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || !after.isFile() || after.isSymbolicLink()
        || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || BigInt(bytes.byteLength) !== after.size) {
        throw new Error(`LocalApp artifact entry changed while hashing: ${relativePath}`);
      }
      files.push({ path: relativePath, size: bytes.byteLength, sha256: sha256Bytes(bytes) });
    }
  };
  await visit(root, "");
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return files;
}

function daemonBootstrapSource(npmPackageName) {
  return DAEMON_BOOTSTRAP_SOURCE.replace("__LOCALAPP_NPM_PACKAGE_NAME__", JSON.stringify(npmPackageName));
}

const DAEMON_BOOTSTRAP_SOURCE = String.raw`#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const npmPackageName = __LOCALAPP_NPM_PACKAGE_NAME__;

const launcher = fileURLToPath(import.meta.url);
const support = path.resolve(path.dirname(launcher), "..");
const currentPath = path.join(support, "current.json");
const fail = () => { process.stderr.write("LocalApp current release is unavailable. Run localapp server start again.\n"); process.exit(1); };
const digestPattern = /^[0-9a-f]{64}$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const exactKeys = (value, expected) => {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
};
const safeRelative = (value) => typeof value === "string" && value.length > 0 && value.length <= 512
  && !value.includes("\\") && !value.startsWith("/") && !value.endsWith("/")
  && path.posix.normalize(value) === value
  && value.split("/").every((part) => part && part !== "." && part !== "..");
const regularBytes = (filePath) => {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe file");
  const bytes = fs.readFileSync(filePath);
  const after = fs.lstatSync(filePath, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || BigInt(bytes.byteLength) !== after.size) throw new Error("changed file");
  return bytes;
};
const listFiles = (root, prefix = "") => {
  const output = [];
  for (const entry of fs.readdirSync(path.join(root, ...prefix.split("/").filter(Boolean)), { withFileTypes: true })) {
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    if (relative === ".localapp-artifact.json") continue;
    if (!safeRelative(relative) || entry.isSymbolicLink()) throw new Error("unsafe release entry");
    if (entry.isDirectory()) output.push(...listFiles(root, relative));
    else if (entry.isFile()) output.push(relative);
    else throw new Error("unsupported release entry");
  }
  return output.sort();
};
let executable;
let expectedRelease;
try {
  const supportStat = fs.lstatSync(support);
  const releasesPath = path.join(support, "releases");
  const releasesStat = fs.lstatSync(releasesPath);
  if (!supportStat.isDirectory() || supportStat.isSymbolicLink() || !releasesStat.isDirectory() || releasesStat.isSymbolicLink()) {
    throw new Error("unsafe support root");
  }
  const currentStat = fs.lstatSync(currentPath);
  if (!currentStat.isFile() || currentStat.isSymbolicLink()) throw new Error("unsafe current manifest");
  const current = JSON.parse(regularBytes(currentPath).toString("utf8"));
  if (!current || typeof current !== "object" || Array.isArray(current)
    || !exactKeys(current, ["version", "artifactDigest", "releasePath", "entrypoint", "bootstrapEntrypoint"])
    || typeof current.version !== "string" || !versionPattern.test(current.version)
    || typeof current.artifactDigest !== "string" || !digestPattern.test(current.artifactDigest)
    || !safeRelative(current.entrypoint) || !safeRelative(current.bootstrapEntrypoint)) throw new Error("invalid current manifest");
  expectedRelease = path.join(releasesPath, current.version + "-" + current.artifactDigest);
  const releaseStat = fs.lstatSync(expectedRelease);
  if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink()
    || path.resolve(current.releasePath) !== path.resolve(expectedRelease)) throw new Error("unsafe current release");
  const manifestPath = path.join(expectedRelease, ".localapp-artifact.json");
  const manifest = JSON.parse(regularBytes(manifestPath).toString("utf8"));
  const allowedManifestKeys = ["schemaVersion", "name", "version", "nodeMajor", "entrypoint", "bootstrapEntrypoint", "files", "artifactDigest", "bundleDigest", "serverBundleDigest", "serverEntrypoint", "protocolVersions", "nativeAdapters"];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || Object.keys(manifest).some((key) => !allowedManifestKeys.includes(key))
    || manifest.schemaVersion !== 2 || manifest.name !== npmPackageName || manifest.nodeMajor !== 24
    || manifest.version !== current.version || manifest.artifactDigest !== current.artifactDigest
    || manifest.entrypoint !== current.entrypoint || manifest.bootstrapEntrypoint !== current.bootstrapEntrypoint
    || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("invalid release manifest");
  const files = manifest.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !exactKeys(entry, ["path", "size", "sha256"])
      || !safeRelative(entry.path) || entry.path === ".localapp-artifact.json"
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== "string" || !digestPattern.test(entry.sha256)) {
      throw new Error("invalid release file");
    }
    return { path: entry.path, size: entry.size, sha256: entry.sha256 };
  });
  const canonicalFiles = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(files.map((entry) => entry.path)).size !== files.length
    || canonicalFiles.some((entry, index) => entry.path !== files[index].path)
    || !files.some((entry) => entry.path === manifest.entrypoint)
    || !files.some((entry) => entry.path === manifest.bootstrapEntrypoint)) throw new Error("noncanonical release files");
  const descriptor = {
    schemaVersion: 2,
    name: npmPackageName,
    version: manifest.version,
    nodeMajor: 24,
    entrypoint: manifest.entrypoint,
    bootstrapEntrypoint: manifest.bootstrapEntrypoint,
    files,
    ...(typeof manifest.bundleDigest === "string" ? { bundleDigest: manifest.bundleDigest } : {}),
    ...(typeof manifest.serverBundleDigest === "string" ? { serverBundleDigest: manifest.serverBundleDigest } : {}),
    ...(typeof manifest.serverEntrypoint === "string" ? { serverEntrypoint: manifest.serverEntrypoint } : {}),
    ...(manifest.protocolVersions ? { protocolVersions: manifest.protocolVersions } : {}),
    ...(manifest.nativeAdapters ? { nativeAdapters: manifest.nativeAdapters } : {}),
  };
  const descriptorDigest = crypto.createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
  if (descriptorDigest !== manifest.artifactDigest) throw new Error("release descriptor changed");
  const observed = listFiles(expectedRelease);
  if (observed.length !== files.length || observed.some((entry, index) => entry !== files[index].path)) throw new Error("release tree changed");
  for (const entry of files) {
    const bytes = regularBytes(path.join(expectedRelease, ...entry.path.split("/")));
    if (bytes.byteLength !== entry.size || crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error("release file changed");
    }
  }
  executable = path.join(expectedRelease, ...manifest.entrypoint.split("/"));
} catch {
  fail();
}
if (executable && expectedRelease) {
  if (process.platform === "win32") {
    try {
      const service = JSON.parse(regularBytes(path.join(support, "service", "windows-user-task.json")).toString("utf8"));
      const allowedEnvironment = ["LOCALAPP_SUPPORT_DIR", "LOCALAPP_RUNTIME_DIR", "LOCALAPP_DATA_DIR"];
      if (!service || typeof service !== "object" || Array.isArray(service)
        || !exactKeys(service, ["schemaVersion", "taskName", "command", "environment"])
        || service.schemaVersion !== 1 || service.taskName !== "LocalApp User Daemon"
        || !service.environment || typeof service.environment !== "object" || Array.isArray(service.environment)
        || !exactKeys(service.environment, allowedEnvironment)
        || allowedEnvironment.some((key) => typeof service.environment[key] !== "string"
          || !path.win32.isAbsolute(service.environment[key]) || service.environment[key].includes("\0"))
        || path.win32.resolve(service.environment.LOCALAPP_SUPPORT_DIR) !== path.win32.resolve(support)) {
        throw new Error("invalid Windows service environment");
      }
      Object.assign(process.env, service.environment);
    } catch {
      fail();
    }
  }
  const child = spawn(process.execPath, [executable, "_daemon"], {
    cwd: expectedRelease,
    env: { ...process.env, LOCALAPP_RELEASE_PATH: expectedRelease },
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  child.once("error", fail);
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
`;

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  buildLocalAppPackage().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
