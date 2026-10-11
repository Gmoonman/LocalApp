import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeLayout } from "../src/daemon/runtime-layout.js";
import { publishRelease, readCurrentRelease, verifyReleaseArtifact } from "../src/daemon/release-store.js";
import { buildLocalAppPackage } from "../scripts/build-package.mjs";

const repositoryRoot = path.resolve(process.cwd(), "../..");
const testRoot = path.join(repositoryRoot, "tmp/task-7-release-tests");
const packageArtifact = path.join(testRoot, "package-artifact");
const directories: string[] = [];

beforeAll(async () => {
  await fs.mkdir(testRoot, { recursive: true });
  await buildLocalAppPackage({ outputDirectory: packageArtifact });
}, 120_000);
afterAll(async () => { await fs.rm(packageArtifact, { recursive: true, force: true }); });
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("daemon runtime layout", () => {
  it("uses platform user roots and an injectable repository-local runtime", () => {
    const mac = createRuntimeLayout({ platform: "darwin", homeDir: "/Users/Alice", runtimeDir: "/repo/tmp/run", uid: 501 });
    expect(mac.supportDir).toBe("/Users/Alice/Library/Application Support/LocalApp");
    expect(mac.controlEndpoint).toBe("/repo/tmp/run/control.sock");

    const linux = createRuntimeLayout({
      platform: "linux",
      homeDir: "/home/alice",
      env: { XDG_DATA_HOME: "/data home", XDG_RUNTIME_DIR: "/run/user/1000" },
      uid: 1000,
    });
    expect(linux.supportDir).toBe("/data home/localapp");
    expect(linux.runtimeDir).toBe("/run/user/1000/localapp");

    const windows = createRuntimeLayout({
      platform: "win32",
      homeDir: "C:\\Users\\Alice",
      env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
    });
    expect(windows.supportDir).toBe("C:\\Users\\Alice\\AppData\\Local\\LocalApp");
    expect(windows.controlEndpoint).toMatch(/^\\\\\.\\pipe\\localapp-[0-9a-f]{24}$/);
  });
});

describe("release store", () => {
  it("publishes the real self-contained packed product manifest", async () => {
    const root = await fixtureRoot();
    const layout = createRuntimeLayout({
      platform: process.platform,
      homeDir: root,
      supportDir: path.join(root, "support"),
      runtimeDir: path.join(root, "runtime"),
    });

    const published = await publishRelease({ sourceDirectory: packageArtifact, layout });

    const packed = await verifyReleaseArtifact(published.releasePath);
    expect(packed).toMatchObject({
      schemaVersion: 2,
      name: "@patodo/localapp",
      entrypoint: "bin/localapp.mjs",
      bootstrapEntrypoint: "runtime/bootstrap/localapp-daemon-bootstrap.mjs",
    });
    if (process.platform !== "win32") {
      const helper = packed.files.find((file) => file.path.endsWith("/node-pty/prebuilds/darwin-arm64/spawn-helper"));
      expect(helper, "dsh terminal helper must be present in the installed release").toBeDefined();
      expect((await fs.stat(path.join(published.releasePath, helper!.path))).mode & 0o700).toBe(0o700);
    }
    expect(await fs.readFile(layout.launcherPath, "utf8")).not.toContain(repositoryRoot);
  }, 30_000);

  it("verifies, atomically publishes, and idempotently reuses one immutable release", async () => {
    const root = await fixtureRoot();
    const source = await writeArtifact(path.join(root, "packed product"), "one");
    const layout = createRuntimeLayout({
      platform: process.platform,
      homeDir: root,
      supportDir: path.join(root, "support with spaces"),
      runtimeDir: path.join(root, "runtime"),
    });

    const [first, second] = await Promise.all([
      publishRelease({ sourceDirectory: source, layout }),
      publishRelease({ sourceDirectory: source, layout }),
    ]);

    expect(second).toEqual(first);
    expect(path.basename(first.releasePath)).toBe(`0.1.0-${first.artifactDigest}`);
    expect(await readCurrentRelease(layout)).toEqual(first);
    expect(await fs.readFile(layout.launcherPath, "utf8")).toContain("current.json");
    expect(await verifyReleaseArtifact(first.releasePath)).toMatchObject({ artifactDigest: first.artifactDigest });
    if (process.platform !== "win32") {
      expect((await fs.stat(layout.releasesDir)).mode & 0o077).toBe(0);
      expect((await fs.stat(layout.currentManifestPath)).mode & 0o077).toBe(0);
    }
  });

  it("preserves the previous current release when a candidate is corrupt", async () => {
    const root = await fixtureRoot();
    const firstSource = await writeArtifact(path.join(root, "first"), "one");
    const layout = createRuntimeLayout({
      platform: process.platform,
      homeDir: root,
      supportDir: path.join(root, "support"),
      runtimeDir: path.join(root, "runtime"),
    });
    const first = await publishRelease({ sourceDirectory: firstSource, layout });
    const corrupt = await writeArtifact(path.join(root, "corrupt"), "two");
    await fs.writeFile(path.join(corrupt, "bin/localapp.mjs"), "tampered\n");

    await expect(publishRelease({ sourceDirectory: corrupt, layout })).rejects.toMatchObject({ code: "release_artifact_invalid" });
    expect(await readCurrentRelease(layout)).toEqual(first);
  });

  it.skipIf(process.platform === "win32")("keeps the selected published native bridge and IPC client executable", async () => {
    const root = await fixtureRoot();
    const layout = createRuntimeLayout({
      platform: process.platform,
      homeDir: root,
      supportDir: path.join(root, "support"),
      runtimeDir: path.join(root, "runtime"),
    });
    const release = await publishRelease({ sourceDirectory: packageArtifact, layout });
    const target = `${process.platform}-${process.arch}`;
    const executable = process.platform === "darwin"
      ? "LocalAppBridge.app/Contents/MacOS/LocalAppBridge"
      : "localapp-notifications";
    const ipcClient = process.platform === "darwin"
      ? "LocalAppBridge.app/Contents/Resources/localapp-native-ipc-client.mjs"
      : "localapp-native-ipc-client.mjs";
    await expect(fs.access(path.join(release.releasePath, "runtime/native", target, executable), fsConstants.X_OK)).resolves.toBeUndefined();
    await expect(fs.access(path.join(release.releasePath, "runtime/native", target, ipcClient), fsConstants.X_OK)).resolves.toBeUndefined();
  }, 30_000);

  it.skipIf(process.platform === "win32")("reclaims a dead publisher lock but fails closed for an active publisher", async () => {
    const root = await fixtureRoot();
    const source = await writeArtifact(path.join(root, "source"), "one");
    const layout = createRuntimeLayout({
      platform: process.platform,
      homeDir: root,
      supportDir: path.join(root, "support"),
      runtimeDir: path.join(root, "runtime"),
    });
    await fs.mkdir(layout.runtimeDir, { recursive: true });
    const deadPid = await exitedProcessPid();
    await fs.writeFile(layout.releaseLockPath, `${JSON.stringify({ schemaVersion: 1, pid: deadPid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    await expect(publishRelease({ sourceDirectory: source, layout, lockTimeoutMs: 100 })).resolves.toMatchObject({ version: "0.1.0" });

    await fs.writeFile(layout.releaseLockPath, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    await expect(publishRelease({ sourceDirectory: source, layout, lockTimeoutMs: 50 }))
      .rejects.toMatchObject({ code: "release_store_busy" });
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked support root before writing outside it", async () => {
    const root = await fixtureRoot();
    const source = await writeArtifact(path.join(root, "source"), "one");
    const outside = path.join(root, "outside");
    const supportLink = path.join(root, "support-link");
    await fs.mkdir(outside);
    await fs.symlink(outside, supportLink);
    const layout = createRuntimeLayout({
      platform: process.platform,
      homeDir: root,
      supportDir: supportLink,
      runtimeDir: path.join(root, "runtime"),
    });

    await expect(publishRelease({ sourceDirectory: source, layout, lockTimeoutMs: 100 }))
      .rejects.toMatchObject({ code: "release_path_unsafe" });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("keeps the stable launcher immutable across current-release updates", async () => {
    const root = await fixtureRoot();
    const source = await writeArtifact(path.join(root, "source"), "one");
    const layout = createRuntimeLayout({
      platform: process.platform,
      homeDir: root,
      supportDir: path.join(root, "support"),
      runtimeDir: path.join(root, "runtime"),
    });
    const first = await publishRelease({ sourceDirectory: source, layout });
    await fs.writeFile(layout.launcherPath, "incompatible launcher\n");

    await expect(publishRelease({ sourceDirectory: source, layout })).rejects.toMatchObject({ code: "release_launcher_incompatible" });
    expect(await readCurrentRelease(layout)).toEqual(first);
  });

  it.skipIf(process.platform === "win32")("stable bootstrap refuses a mutated published entrypoint", async () => {
    const root = await fixtureRoot();
    const layout = createRuntimeLayout({
      platform: process.platform,
      homeDir: root,
      supportDir: path.join(root, "support"),
      runtimeDir: path.join(root, "runtime"),
    });
    const published = await publishRelease({ sourceDirectory: packageArtifact, layout });
    const marker = path.join(root, "compromised-marker");
    await fs.writeFile(path.join(published.releasePath, "bin/localapp.mjs"),
      `import fs from "node:fs"; fs.writeFileSync(process.env.LOCALAPP_BOOTSTRAP_MARKER, "executed");\n`);

    const result = await runNode(layout.launcherPath, { LOCALAPP_BOOTSTRAP_MARKER: marker });

    expect(result.code).not.toBe(0);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("rejects unlisted files and symbolic links rather than copying ambient credentials", async () => {
    const root = await fixtureRoot();
    const extra = await writeArtifact(path.join(root, "extra"), "one");
    await fs.writeFile(path.join(extra, "profiles.json"), '{"apiKey":"must-not-copy"}\n');
    await expect(verifyReleaseArtifact(extra)).rejects.toMatchObject({ code: "release_artifact_invalid" });

    if (process.platform !== "win32") {
      const linked = await writeArtifact(path.join(root, "linked"), "one");
      await fs.rm(path.join(linked, "bin/localapp.mjs"));
      await fs.symlink(path.join(linked, "package.json"), path.join(linked, "bin/localapp.mjs"));
      await expect(verifyReleaseArtifact(linked)).rejects.toMatchObject({ code: "release_artifact_invalid" });
    }
  });

  it("rejects descriptor order substitution and a native runtime manifest that disagrees with the descriptor", async () => {
    const root = await fixtureRoot();
    const source = packageArtifact;

    const reordered = path.join(root, "reordered descriptor");
    await copyArtifact(source, reordered);
    const reorderedManifestPath = path.join(reordered, ".localapp-artifact.json");
    const reorderedManifest = JSON.parse(await fs.readFile(reorderedManifestPath, "utf8"));
    reorderedManifest.protocolVersions = { peerSync: 1, deviceAction: 2, notificationDelivery: 2 };
    await fs.writeFile(reorderedManifestPath, `${JSON.stringify(reorderedManifest, null, 2)}\n`);
    await expect(verifyReleaseArtifact(reordered)).rejects.toMatchObject({ code: "release_artifact_invalid" });

    const substituted = path.join(root, "substituted native manifest");
    await copyArtifact(source, substituted);
    const nativePath = path.join(substituted, "runtime/native/adapter-manifest.json");
    const native = JSON.parse(await fs.readFile(nativePath, "utf8"));
    native.signing.mode = native.signing.mode === "adhoc" ? "release" : "adhoc";
    const nativeBytes = Buffer.from(`${JSON.stringify(native, null, 2)}\n`);
    await fs.writeFile(nativePath, nativeBytes);
    const manifestPath = path.join(substituted, ".localapp-artifact.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const entry = manifest.files.find((file: { path: string }) => file.path === "runtime/native/adapter-manifest.json");
    entry.size = nativeBytes.byteLength;
    entry.sha256 = crypto.createHash("sha256").update(nativeBytes).digest("hex");
    const { artifactDigest: _artifactDigest, ...descriptor } = manifest;
    manifest.artifactDigest = crypto.createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(verifyReleaseArtifact(substituted)).rejects.toMatchObject({ code: "release_artifact_invalid" });
  }, 30_000);

  it("rejects a release descriptor that omits required protocol and native adapter contracts", async () => {
    const root = await fixtureRoot();
    const source = path.join(root, "missing release contracts");
    await copyArtifact(packageArtifact, source);
    const manifestPath = path.join(source, ".localapp-artifact.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    delete manifest.protocolVersions;
    delete manifest.nativeAdapters;
    const { artifactDigest: _artifactDigest, ...descriptor } = manifest;
    manifest.artifactDigest = crypto.createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(verifyReleaseArtifact(source)).rejects.toMatchObject({ code: "release_artifact_invalid" });
  }, 30_000);

  it("rejects a native adapter contract that omits a runtime-required asset", async () => {
    const root = await fixtureRoot();
    const source = await writeArtifact(path.join(root, "missing native IPC client"), "one");
    const manifestPath = path.join(source, ".localapp-artifact.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const missingPath = "runtime/native/linux-x64/localapp-native-ipc-client.mjs";
    manifest.files = manifest.files.filter((file: { path: string }) => file.path !== missingPath);
    manifest.nativeAdapters[0].assets = manifest.nativeAdapters[0].assets.filter(
      (asset: { path: string }) => asset.path !== "linux-x64/localapp-native-ipc-client.mjs",
    );
    const nativePath = path.join(source, "runtime/native/adapter-manifest.json");
    const native = JSON.parse(await fs.readFile(nativePath, "utf8"));
    native.adapters[0].assets = native.adapters[0].assets.filter(
      (asset: { path: string }) => asset.path !== "linux-x64/localapp-native-ipc-client.mjs",
    );
    const nativeBytes = Buffer.from(`${JSON.stringify(native, null, 2)}\n`);
    await fs.writeFile(nativePath, nativeBytes);
    await fs.rm(path.join(source, missingPath));
    const nativeEntry = manifest.files.find((file: { path: string }) => file.path === "runtime/native/adapter-manifest.json");
    nativeEntry.size = nativeBytes.byteLength;
    nativeEntry.sha256 = crypto.createHash("sha256").update(nativeBytes).digest("hex");
    const { artifactDigest: _artifactDigest, ...descriptor } = manifest;
    manifest.artifactDigest = crypto.createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(verifyReleaseArtifact(source)).rejects.toMatchObject({ code: "release_artifact_invalid" });
  });
});

async function fixtureRoot(): Promise<string> {
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, "fixture-"));
  directories.push(root);
  return root;
}

async function writeArtifact(directory: string, marker: string): Promise<string> {
  const nativeAssets = new Map([
    ["linux-x64/localapp-notifications", "native adapter\n"],
    ["linux-x64/localapp-native-ipc-client.mjs", "native IPC client\n"],
  ]);
  const nativeAdapters = [{
    target: "linux-x64",
    signing: { mode: "adhoc" },
    assets: [...nativeAssets].map(([assetPath, bytes]) => ({
      path: assetPath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    })),
  }];
  const values = new Map<string, string>([
    ["bin/localapp.mjs", `#!/usr/bin/env node\nconsole.log(${JSON.stringify(marker)});\n`],
    ["package.json", `${JSON.stringify({ name: "@patodo/localapp", version: "0.1.0", bin: { localapp: "bin/localapp.mjs" } })}\n`],
    ["runtime/bootstrap/localapp-daemon-bootstrap.mjs", "// stable launcher reads current.json\n"],
    ...[...nativeAssets].map(([assetPath, bytes]) => [`runtime/native/${assetPath}`, bytes] as [string, string]),
    ["runtime/native/adapter-manifest.json", `${JSON.stringify({ schemaVersion: 2, adapters: nativeAdapters }, null, 2)}\n`],
  ]);
  for (const [relativePath, value] of values) {
    const target = path.join(directory, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value);
  }
  const files = [...values].map(([relativePath, value]) => ({
    path: relativePath,
    size: Buffer.byteLength(value),
    sha256: crypto.createHash("sha256").update(value).digest("hex"),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const descriptor = {
    schemaVersion: 2,
    name: "@patodo/localapp",
    version: "0.1.0",
    nodeMajor: 24,
    entrypoint: "bin/localapp.mjs",
    bootstrapEntrypoint: "runtime/bootstrap/localapp-daemon-bootstrap.mjs",
    files,
    protocolVersions: { deviceAction: 2, notificationDelivery: 2, peerSync: 1 },
    nativeAdapters,
  } as const;
  const artifactDigest = crypto.createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
  await fs.writeFile(path.join(directory, ".localapp-artifact.json"), `${JSON.stringify({ ...descriptor, artifactDigest }, null, 2)}\n`);
  return directory;
}

function runNode(script: string, environment: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

function exitedProcessPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    if (pid === undefined) return reject(new Error("fixture process has no PID"));
    child.once("error", reject);
    child.once("exit", () => resolve(pid));
  });
}

// Copy every file in the verified package with bounded filesystem concurrency.
// Each destination remains independent so tampering cannot alter the fixture.
async function copyArtifact(source: string, destination: string): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.join(source, ".localapp-artifact.json"), "utf8"));
  const files: string[] = [".localapp-artifact.json", ...manifest.files.map((file: { path: string }) => file.path)];
  let next = 0;
  const workers = Array.from({ length: Math.min(16, files.length) }, async () => {
    while (next < files.length) {
      const relative = files[next++];
      const target = path.join(destination, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(source, relative), target, fsConstants.COPYFILE_FICLONE);
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
