import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(process.env.LOCALAPP_REPOSITORY_ROOT ?? path.resolve(packageDirectory, "../.."));

/**
 * Builds one exact target directory. The public package invokes this without a
 * target override, so it can never accidentally pack adapters for other hosts.
 * Cross-target tests must inject the Windows compiler seam explicitly.
 */
export async function buildNativeAdapter(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = supportedTarget(platform, arch);
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(repositoryRoot, "tmp/localapp-native"));
  const signing = options.signing ?? process.env.LOCALAPP_NATIVE_SIGNING ?? "adhoc";
  if (signing !== "adhoc" && signing !== "release") throw new Error("LOCALAPP_NATIVE_SIGNING must be adhoc or release");
  if (signing === "release" && platform !== "darwin") throw new Error("release native signing is currently available only for macOS");
  if (platform === "darwin" && (process.platform !== "darwin" || arch !== process.arch)) {
    throw new Error(`NATIVE_ADAPTER_UNSUPPORTED: cannot build ${target} on this host`);
  }

  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true, mode: 0o755 });
  const targetDirectory = path.join(outputDirectory, target);
  await fs.mkdir(targetDirectory, { recursive: true, mode: 0o755 });

  let result;
  if (platform === "darwin") result = await buildMacAdapter({ target, targetDirectory, signing, ...options });
  else if (platform === "linux") result = await buildLinuxAdapter({ target, targetDirectory, outputDirectory, buildLinux: options.buildLinux });
  else result = await buildWindowsAdapter({ target, targetDirectory, outputDirectory, buildWindows: options.buildWindows });

  const assets = await collectAssets(outputDirectory);
  await fs.writeFile(path.join(outputDirectory, "adapter-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    target,
    signing: { mode: signing },
    assets,
  }, null, 2)}\n`, { mode: 0o644 });
  return { outputDirectory, target, signing: { mode: signing }, ...result };
}

async function buildMacAdapter(options) {
  const appBundle = path.join(options.targetDirectory, "LocalAppBridge.app");
  const macos = path.join(appBundle, "Contents", "MacOS");
  const resources = path.join(appBundle, "Contents", "Resources");
  await fs.mkdir(macos, { recursive: true, mode: 0o755 });
  await fs.mkdir(resources, { recursive: true, mode: 0o755 });
  const bundleIdentifier = options.bundleIdentifier ?? "dev.localapp.bridge";
  if (!/^dev\.localapp\.bridge(?:\.[a-z0-9-]+)*$/.test(bundleIdentifier)) throw new Error("invalid native bundle identifier");
  const info = (await fs.readFile(path.join(packageDirectory, "native/macos/Info.plist"), "utf8"))
    .replaceAll("@BUNDLE_IDENTIFIER@", bundleIdentifier);
  await fs.writeFile(path.join(appBundle, "Contents", "Info.plist"), info, { mode: 0o644 });
  const executable = path.join(macos, "LocalAppBridge");
  await copyCachedBridge({ target: options.target, executable, cacheDirectory: options.cacheDirectory });
  const ipcClient = path.join(resources, "localapp-native-ipc-client.mjs");
  await bundleIpcClient(ipcClient);
  const identity = options.signing === "release" ? process.env.LOCALAPP_MACOS_SIGNING_IDENTITY : "-";
  if (options.signing === "release" && (!identity || identity === "-")) throw new Error("LOCALAPP_MACOS_SIGNING_IDENTITY is required for release signing");
  await run("/usr/bin/codesign", ["--force", "--sign", identity, "--options", "runtime", appBundle]);
  return { appBundle, executable, ipcClient };
}

async function buildLinuxAdapter({ target, targetDirectory, outputDirectory, buildLinux }) {
  const ipcClient = path.join(targetDirectory, "localapp-native-ipc-client.mjs");
  await bundleIpcClient(ipcClient);
  const executable = path.join(targetDirectory, "localapp-notifications");
  if (typeof buildLinux === "function") {
    await buildLinux({ target, executable, targetDirectory });
  } else {
    if (process.platform !== "linux") throw new Error(`NATIVE_ADAPTER_UNSUPPORTED: cannot build ${target} without an injected Linux toolchain`);
    const cargoTarget = linuxCargoTarget(target);
    const cargoDirectory = path.join(outputDirectory, ".cargo-linux-target");
    try {
      await run("cargo", ["build", "--release", "--locked", "--manifest-path", path.join(packageDirectory, "native/linux/Cargo.toml"), "--target", cargoTarget], {
        CARGO_TARGET_DIR: cargoDirectory,
      });
      await fs.copyFile(path.join(cargoDirectory, cargoTarget, "release", "localapp-linux-notifications"), executable);
    } finally {
      await fs.rm(cargoDirectory, { recursive: true, force: true });
    }
  }
  await fs.chmod(executable, 0o755);
  // The per-user desktop file is generated only by installLinuxScheme, once
  // the immutable release path and current Node executable are known.
  return { executable, ipcClient };
}

async function buildWindowsAdapter({ target, targetDirectory, outputDirectory, buildWindows }) {
  const executable = path.join(targetDirectory, "localapp-native.exe");
  const ipcClient = path.join(targetDirectory, "localapp-native-ipc-client.mjs");
  await bundleIpcClient(ipcClient);
  if (typeof buildWindows === "function") {
    await buildWindows({ target, executable, targetDirectory });
  } else {
    if (process.platform !== "win32") throw new Error(`NATIVE_ADAPTER_UNSUPPORTED: cannot build ${target} without an injected Windows toolchain`);
    const cargoTarget = windowsCargoTarget(target);
    const cargoDirectory = path.join(outputDirectory, ".cargo-target");
    const cargoWorkspace = path.join(outputDirectory, ".cargo-source");
    const cargoSource = path.join(cargoWorkspace, "windows");
    const cargoCommon = path.join(cargoWorkspace, "common");
    await fs.cp(path.join(packageDirectory, "native", "windows"), cargoSource, { recursive: true });
    await fs.cp(path.join(packageDirectory, "native", "common"), cargoCommon, { recursive: true });
    try {
      await run("cargo", ["build", "--release", "--manifest-path", path.join(cargoSource, "Cargo.toml"), "--target", cargoTarget], {
        CARGO_TARGET_DIR: cargoDirectory,
      });
      await fs.copyFile(path.join(cargoDirectory, cargoTarget, "release", "localapp-native.exe"), executable);
    } finally {
      await Promise.all([
        fs.rm(cargoDirectory, { recursive: true, force: true }),
        fs.rm(cargoWorkspace, { recursive: true, force: true }),
      ]);
    }
  }
  await fs.chmod(executable, 0o755);
  return { executable, ipcClient };
}

async function bundleIpcClient(outfile) {
  await build({
    absWorkingDir: repositoryRoot,
    alias: {
      "@localapp/server/device-action-ticket": path.join(repositoryRoot, "packages/dsh-app-platform/src/device-action-ticket.cts"),
      "@localapp/server/project-api": path.join(repositoryRoot, "packages/dsh-app-development/src/project-errors.cts"),
    },
    bundle: true,
    entryPoints: [path.join(packageDirectory, "src/native/native-ipc-client.ts")],
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    sourcemap: false,
    target: "node24",
    banner: { js: "#!/usr/bin/env node" },
  });
  await fs.chmod(outfile, 0o755);
}

async function copyCachedBridge({ target, executable, cacheDirectory }) {
  if (process.platform !== "darwin") throw new Error(`NATIVE_ADAPTER_UNSUPPORTED: cannot compile ${target} on this host`);
  const source = path.join(packageDirectory, "native/macos/LocalAppBridge.swift");
  const key = crypto.createHash("sha256").update(await fs.readFile(source)).update(target).digest("hex");
  const cacheRoot = path.resolve(cacheDirectory ?? path.join(repositoryRoot, "tmp/localapp-native-build-cache"));
  const cached = path.join(cacheRoot, target, key, "LocalAppBridge");
  const present = await fs.access(cached).then(() => true, () => false);
  if (!present) {
    await fs.mkdir(path.dirname(cached), { recursive: true, mode: 0o700 });
    await run("/usr/bin/swiftc", [
      source,
      "-framework", "AppKit", "-framework", "CoreServices", "-framework", "UserNotifications",
      "-o", cached,
    ]);
  }
  await fs.copyFile(cached, executable);
  await fs.chmod(executable, 0o755);
}

function supportedTarget(platform, arch) {
  if ((platform === "darwin" || platform === "linux" || platform === "win32") && (arch === "arm64" || arch === "x64")) return `${platform}-${arch}`;
  throw new Error(`NATIVE_ADAPTER_UNSUPPORTED: cannot build ${platform}-${arch}`);
}

function windowsCargoTarget(target) {
  if (target === "win32-x64") return "x86_64-pc-windows-msvc";
  if (target === "win32-arm64") return "aarch64-pc-windows-msvc";
  throw new Error(`NATIVE_ADAPTER_UNSUPPORTED: no Windows Rust target for ${target}`);
}

function linuxCargoTarget(target) {
  if (target === "linux-x64") return "x86_64-unknown-linux-gnu";
  if (target === "linux-arm64") return "aarch64-unknown-linux-gnu";
  throw new Error(`NATIVE_ADAPTER_UNSUPPORTED: no Linux Rust target for ${target}`);
}

async function collectAssets(root) {
  const files = [];
  const visit = async (directory, prefix) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push({ path: relative, sha256: crypto.createHash("sha256").update(await fs.readFile(absolute)).digest("hex") });
      else throw new Error(`unsupported native adapter asset: ${relative}`);
    }
  };
  await visit(root, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function run(command, args, environment = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }) });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed: ${stderr.trim()}`)));
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNativeAdapter().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
