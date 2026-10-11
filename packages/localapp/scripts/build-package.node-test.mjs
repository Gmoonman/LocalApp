import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildLocalAppPackage } from "./build-package.mjs";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const testRoot = path.join(projectDirectory, "tmp/task-1-package-test");
const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productVersion = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8")).version;
const require = createRequire(import.meta.url);

test("CLI bundle resolves both Server contracts from source without prebuilt dist", async () => {
  const source = await fs.readFile(path.join(packageDirectory, "scripts/build-package.mjs"), "utf8");
  assert.match(source, /"@localapp\/server\/app-package-api": path\.join\(projectDirectory, "packages\/server\/src\/app-package-api\.ts"\)/);
  assert.match(source, /"@localapp\/server\/device-action-ticket": path\.join\(projectDirectory, "packages\/server\/src\/device-action-ticket\.ts"\)/);
});

test("Windows sync command builder uses explicit cmd.exe invocation for a spaced special-character path", () => {
  const { buildSyncInvocation } = require("../src/template/sync-template-command.cjs");
  const executable = "C:\\Program Files\\Local & App!^(test)\\localapp.cmd";

  assert.deepEqual(buildSyncInvocation(executable, "win32", "C:\\Windows\\System32\\cmd.exe"), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", '""C:\\Program Files\\Local & App!^(test)\\localapp.cmd" sync-template --quiet"'],
    spawnOptions: { shell: false, windowsHide: true, windowsVerbatimArguments: true },
  });
  assert.throws(
    () => buildSyncInvocation("C:\\unsafe%PATH%\\localapp.cmd", "win32", "cmd.exe"),
    /unsafe Windows command path/,
  );
});

test("packed product exposes one localapp binary without workspace references", async (t) => {
  await fs.rm(testRoot, { recursive: true, force: true });
  await fs.mkdir(testRoot, { recursive: true });
  t.after(() => fs.rm(testRoot, { recursive: true, force: true }));

  const outputDirectory = path.join(testRoot, "artifact with spaces");
  const result = await buildLocalAppPackage({ outputDirectory });
  const manifest = JSON.parse(await fs.readFile(path.join(result.outputDirectory, "package.json"), "utf8"));
  const artifact = JSON.parse(await fs.readFile(path.join(result.outputDirectory, ".localapp-artifact.json"), "utf8"));

  assert.equal(manifest.name, "@patodo/localapp");
  assert.deepEqual(manifest.bin, { localapp: "bin/localapp.mjs" });
  assert.equal(JSON.stringify(manifest).includes("workspace:"), false);
  for (const name of ["multiuser", "agent-ui", "applications", "development", "documents"]) {
    const entry = manifest.exports[`./plugins/${name}`];
    assert.equal(entry.default, `./plugins/${name}.mjs`);
    await fs.access(path.join(result.outputDirectory, entry.default));
  }
  const pluginCheck = spawn(process.execPath, ["--input-type=module", "-e", `
    import AgentUI from '@patodo/localapp/plugins/agent-ui';
    import Multiuser from '@patodo/localapp/plugins/multiuser';
    import Platform, { clientHostUrl as platformClient } from '@patodo/localapp/plugins/applications';
    import Development, { clientHostUrl as developmentClient, taskSupervisorPath, createBuildOperations, checkProject, buildApplicationPackage } from '@patodo/localapp/plugins/development';
    import Documents from '@patodo/localapp/plugins/documents';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import path from 'node:path';
    import fs from 'node:fs/promises';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    for (const plugin of [AgentUI, Multiuser, Platform, Development, Documents]) if (typeof plugin !== 'function') throw new Error('Invalid public plugin');
    const require = createRequire(path.resolve('runtime/server/package.json'));
    const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
    const SQL = await require('sql.js')();
    const database = new SQL.Database(); const context = new Context();
    try {
      if (!taskSupervisorPath.startsWith(path.resolve('runtime/server/node_modules/@localapp/dsh-app-development/runner') + path.sep)) throw new Error('Supervisor escaped the development plugin');
      try {
        await promisify(execFile)(process.execPath, [taskSupervisorPath]);
        throw new Error('Supervisor accepted missing arguments');
      } catch (error) {
        if (error.code !== 125 || !error.stderr.includes('Invalid LocalApp task supervisor invocation')) throw error;
      }
      await context.plugin(Multiuser, { capacity: 2 });
      await context.plugin(AgentUI);
      await context.plugin(Platform, { owner: () => undefined, application: () => undefined, canAccess: () => false });
      await context.plugin(Development, { dataDir: path.resolve('plugin-test-data'), persistence: { database: () => database, flush: () => {} } });
      await context.plugin(Documents);
      const projectDir = path.resolve('plugin-test-data/public-build');
      await fs.mkdir(path.join(projectDir, 'dist'), { recursive: true });
      await fs.writeFile(path.join(projectDir, 'manifest.json'), JSON.stringify({ name: 'public-build-app', platformVersion: '^1.2' }));
      await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'public-build-app', version: '1.0.0', scripts: { test: 'node test.cjs', build: 'node build.cjs' } }));
      await fs.writeFile(path.join(projectDir, 'test.cjs'), 'process.stdout.write("public-check-test")');
      await fs.writeFile(path.join(projectDir, 'build.cjs'), 'require("node:fs").writeFileSync("dist/index.html", "<main>public build</main>")');
      const report = await checkProject({ projectDir });
      if (!report.success) throw new Error('Public project check failed: ' + JSON.stringify(report));
      const operations = createBuildOperations();
      if ((await operations.loadAndValidateProjectManifest(projectDir)).name !== 'public-build-app') throw new Error('Public build operations failed');
      const packaged = await buildApplicationPackage({ projectDir, outputPath: path.join(projectDir, 'public.localapp') });
      if (packaged.appId !== 'public-build-app' || !(await fs.stat(packaged.path)).size) throw new Error('Public application package missing');
      if (!context.localappAgentUI || !context.localappMultiuser || !context.localappApps || !context.localappDevelopment || !context.localappDocuments) throw new Error('Missing public plugin service');
      const workspaces = context.localappDevelopment.workspaces({ workspaceDir: path.resolve('plugin-test-data/workspaces'), authorizeExecution: () => true });
      const workspace = await workspaces.create({ name: 'public-task-workspace', ownerId: 'public-user' });
      const taskRunner = context.localappDevelopment.taskRunner({ workspaceStore: workspaces, taskDir: path.resolve('plugin-test-data/tasks'), allowedExecutables: { node: process.execPath }, authorizeExecution: () => true });
      const task = await taskRunner.start({ workspaceId: workspace.id, kind: 'test', executable: 'node', args: ['-e', 'process.stdout.write("public-task-completed")'], timeoutMs: 5000, requestedBy: 'public-user' });
      const deadline = Date.now() + 5000;
      while (context.localappDevelopment.tasks.get(task.id)?.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (context.localappDevelopment.tasks.get(task.id)?.status !== 'succeeded') throw new Error('Public task failed: ' + JSON.stringify(context.localappDevelopment.tasks.get(task.id)));
      if (!taskRunner.logs(task.id, 0).content.includes('public-task-completed')) throw new Error('Public task output missing');
      const secrets = context.localappMultiuser.createSecrets(path.resolve('plugin-test-data/master.key'));
      const sealed = secrets.seal('public-plugin-secret', 'public-plugin-test');
      if (secrets.open(sealed, 'public-plugin-test') !== 'public-plugin-secret') throw new Error('Public secret service failed');
      const settingsValues = new Map();
      const settings = context.localappMultiuser.createSettings(path.resolve('plugin-test-data/settings'), {
        users: () => [...settingsValues.keys()], read: user => settingsValues.get(user), write: (user, value) => settingsValues.set(user, value),
      }, []);
      settings.write('public-user', { providers: [], defaultProviderId: '', grants: {}, mcpServers: [], applications: {} });
      if (settings.read('public-user').providers.length !== 0 || !settingsValues.has('public-user')) throw new Error('Public settings service failed');
      const { mountNativeClientModules } = await import(pathToFileURL(require.resolve('@localapp/dsh-multiuser/native-client')).href);
      const assets = new Context();
      try {
        const modules = await mountNativeClientModules(assets, true, { contributions: [platformClient, developmentClient] });
        const entries = modules.graph().entries;
        for (const id of ['@localapp/dsh-multiuser', '@localapp/dsh-app-platform', '@localapp/dsh-app-development', '@deepseek-ai/dsh-client-ui-trajectory']) {
          if (!entries.some(entry => entry.id === id)) throw new Error('Missing public client contribution: ' + id);
        }
        for (const entry of entries) {
          const response = await modules.fetchBundle(new Request('http://localapp.test/' + entry.url));
          if (response.status !== 200 || (await response.text()).length < 100) throw new Error('Unreadable client bundle: ' + entry.id);
        }
      } finally { await assets.fiber.dispose(); }
    } finally { await context.fiber.dispose(); database.close(); }
  `], { cwd: result.outputDirectory, env: { ...process.env, NODE_PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let pluginErrors = ""; pluginCheck.stderr.on("data", chunk => { pluginErrors += chunk; });
  assert.equal(await new Promise(resolve => pluginCheck.once("close", resolve)), 0, pluginErrors);
  const consumer = path.join(result.outputDirectory, "plugin-consumer.mts");
  await fs.writeFile(consumer, `
    import Multiuser, { clientHostUrl } from '@patodo/localapp/plugins/multiuser';
    import Platform from '@patodo/localapp/plugins/applications';
    import Development from '@patodo/localapp/plugins/development';
    import Documents from '@patodo/localapp/plugins/documents';
    const url: string = clientHostUrl;
    const options: ConstructorParameters<typeof Multiuser>[1] = { capacity: 2 };
    // @ts-expect-error capacity requires a number
    const invalid: ConstructorParameters<typeof Multiuser>[1] = { capacity: 'two' };
    type PlatformOptions = ConstructorParameters<typeof Platform>[1];
    type DevelopmentOptions = ConstructorParameters<typeof Development>[1];
    // @ts-expect-error application storage must implement its host interface
    const invalidPlatform: PlatformOptions = {};
    // @ts-expect-error development requires persistence as well as a data directory
    const invalidDevelopment: DevelopmentOptions = { dataDir: '/data' };
    const documentOptions: ConstructorParameters<typeof Documents>[1] = { root: '/skills' };
    // @ts-expect-error document roots are filesystem paths
    const invalidDocuments: ConstructorParameters<typeof Documents>[1] = { root: 123 };
  `);
  const compiler = spawn(process.execPath, [createRequire(path.join(projectDirectory, "packages/server/package.json")).resolve("typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--target", "ES2022", "--typeRoots", path.join(result.outputDirectory, "runtime/server/node_modules/@types"), consumer], { cwd: result.outputDirectory, env: { ...process.env, NODE_PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = ""; for (const stream of [compiler.stdout, compiler.stderr]) stream.on("data", chunk => { diagnostics += chunk; });
  assert.equal(await new Promise(resolve => compiler.once("close", resolve)), 0, diagnostics);
  assert.equal(await run(result.outputDirectory, ["--version"]), `localapp ${productVersion}`);
  assert.match(await run(result.outputDirectory, ["-h"]), /Commands:\n[\s\S]*server \[start\][\s\S]*app install/);
  assert.match(await run(result.outputDirectory, ["server", "run", "--help"]), /--data-dir <path>[\s\S]*--host <address>[\s\S]*--port <number>/);
  assert.match(await run(result.outputDirectory, ["help", "app", "sync"]), /--peer <name>[\s\S]*--with-data[\s\S]*--confirm-app <name>/);
  assert.equal(await fs.stat(path.join(result.outputDirectory, "template/runtime/server-core/dist/index.js")).then(() => true, () => false), true);
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.name, "@patodo/localapp");
  assert.equal(artifact.bootstrapEntrypoint, "runtime/bootstrap/localapp-daemon-bootstrap.mjs");
  assert.equal(artifact.files.some((entry) => entry.path === artifact.entrypoint), true);
  assert.equal(artifact.files.some((entry) => entry.path === artifact.bootstrapEntrypoint), true);
  const daemonBootstrap = await fs.readFile(path.join(result.outputDirectory, artifact.bootstrapEntrypoint), "utf8");
  assert.match(daemonBootstrap, /windows-user-task\.json/);
  assert.match(daemonBootstrap, /LOCALAPP_RUNTIME_DIR/);
  assert.match(daemonBootstrap, /Object\.assign\(process\.env, service\.environment\)/);
  const nativeManifest = JSON.parse(await fs.readFile(path.join(result.outputDirectory, "runtime/native/adapter-manifest.json"), "utf8"));
  assert.equal(nativeManifest.target, `${process.platform}-${process.arch}`);
  assert.equal(nativeManifest.assets.every((entry) => entry.path.startsWith(`${nativeManifest.target}/`)), true);
  assert.equal((await fs.readdir(path.join(result.outputDirectory, "runtime/native"))).sort().join(","), `adapter-manifest.json,${nativeManifest.target}`);
  const { artifactDigest, ...artifactDescriptor } = artifact;
  assert.equal(
    artifactDigest,
    (await import("node:crypto")).createHash("sha256").update(JSON.stringify(artifactDescriptor)).digest("hex"),
  );

  const projectRoot = path.join(testRoot, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  await run(result.outputDirectory, ["init", "packed-app", "--skip-install", "--skip-deploy"], projectRoot);
  assert.equal(await fs.stat(path.join(projectRoot, "packed-app/.localapp/runtime/server-core/dist/index.js")).then(() => true, () => false), true);
});

test("direct builder execution works from a source path containing spaces", async (t) => {
  const sourceDirectory = path.join(testRoot, "source package with spaces");
  const outputDirectory = path.join(testRoot, "built package");
  await fs.rm(testRoot, { recursive: true, force: true });
  await fs.mkdir(testRoot, { recursive: true });
  t.after(() => fs.rm(testRoot, { recursive: true, force: true }));
  await fs.cp(packageDirectory, sourceDirectory, {
    recursive: true,
    filter: (source) => !["node_modules", "dist"].includes(path.basename(source)),
  });
  await fs.symlink(path.join(packageDirectory, "node_modules"), path.join(sourceDirectory, "node_modules"));

  const result = await runNode(path.join(sourceDirectory, "scripts/build-package.mjs"), {
    LOCALAPP_PACKAGE_DIR: outputDirectory,
    LOCALAPP_REPOSITORY_ROOT: projectDirectory,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outputDirectory, outputDirectory);
  assert.equal(await run(outputDirectory, ["--version"]), `localapp ${productVersion}`);
});

test("builder rejects a source package identity that diverges from the shared release target", async (t) => {
  const sourceDirectory = path.join(testRoot, "source package with mismatched identity");
  const outputDirectory = path.join(testRoot, "mismatched identity package");
  await fs.rm(testRoot, { recursive: true, force: true });
  await fs.mkdir(testRoot, { recursive: true });
  t.after(() => fs.rm(testRoot, { recursive: true, force: true }));
  await fs.cp(packageDirectory, sourceDirectory, {
    recursive: true,
    filter: (source) => !["node_modules", "dist"].includes(path.basename(source)),
  });
  await fs.symlink(path.join(packageDirectory, "node_modules"), path.join(sourceDirectory, "node_modules"));
  const sourceManifestPath = path.join(sourceDirectory, "package.json");
  const sourceManifest = JSON.parse(await fs.readFile(sourceManifestPath, "utf8"));
  sourceManifest.name = "@patodo/mismatched-localapp";
  await fs.writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`);

  const result = await runNode(path.join(sourceDirectory, "scripts/build-package.mjs"), {
    LOCALAPP_PACKAGE_DIR: outputDirectory,
    LOCALAPP_REPOSITORY_ROOT: projectDirectory,
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /release target.*package manifest/i);
});

test("packed tarball keeps the builtin runtime available to init", async (t) => {
  const packDirectory = path.join(testRoot, "packed tarball");
  const unpackDirectory = path.join(testRoot, "unpacked tarball");
  const projectDirectory = path.join(testRoot, "tarball project");
  await fs.mkdir(packDirectory, { recursive: true });
  await fs.mkdir(projectDirectory, { recursive: true });
  t.after(() => fs.rm(packDirectory, { recursive: true, force: true }));
  t.after(() => fs.rm(unpackDirectory, { recursive: true, force: true }));
  t.after(() => fs.rm(projectDirectory, { recursive: true, force: true }));

  await runProcess("pnpm", ["-C", packageDirectory, "pack", "--pack-destination", packDirectory]);
  const tarball = path.join(packDirectory, `patodo-localapp-${productVersion}.tgz`);
  await fs.mkdir(unpackDirectory, { recursive: true });
  await runProcess("tar", ["-xzf", tarball, "-C", unpackDirectory]);
  const packedPackage = path.join(unpackDirectory, "package");
  await run(packedPackage, ["init", "tarball-app", "--skip-install", "--skip-deploy"], projectDirectory);
  assert.equal(await fs.stat(path.join(projectDirectory, "tarball-app/.localapp/runtime/server-core/dist/index.js")).then(() => true, () => false), true);
  assert.match(await fs.readFile(path.join(projectDirectory, "tarball-app/.npmrc"), "utf8"), /public-hoist-pattern\[\]=pdfjs-dist/);
});

test("packed postinstall wrapper treats only a missing localapp executable as a warning", async (t) => {
  const outputDirectory = path.join(testRoot, "wrapper package");
  const emptyPath = path.join(testRoot, "empty executable path");
  const failingPath = path.join(testRoot, "failing executable path");
  t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));
  t.after(() => fs.rm(emptyPath, { recursive: true, force: true }));
  t.after(() => fs.rm(failingPath, { recursive: true, force: true }));
  await fs.mkdir(emptyPath, { recursive: true });
  await fs.mkdir(failingPath, { recursive: true });
  const result = await buildLocalAppPackage({ outputDirectory });
  const wrapper = path.join(result.outputDirectory, "template/runtime/sync-template.cjs");

  const execution = await runNode(wrapper, { PATH: emptyPath });

  assert.equal(execution.code, 0, execution.stderr);
  assert.match(execution.stderr, /localapp executable was not found; managed template sync was skipped/i);

  const failingExecutable = path.join(failingPath, process.platform === "win32" ? "localapp.cmd" : "localapp");
  await fs.writeFile(failingExecutable, process.platform === "win32" ? "@exit /b 23\r\n" : "#!/bin/sh\nexit 23\n");
  if (process.platform !== "win32") await fs.chmod(failingExecutable, 0o755);
  const failure = await runNode(wrapper, { PATH: failingPath });
  assert.equal(failure.code, 23, failure.stderr);
});

test("pnpm-packed tarball wrapper handles missing executable and genuine child failure", async (t) => {
  const packDirectory = path.join(testRoot, "wrapper packed tarball");
  const unpackDirectory = path.join(testRoot, "wrapper unpacked tarball");
  const emptyPath = path.join(testRoot, "wrapper empty path");
  const failingPath = path.join(testRoot, "wrapper & failing path (special)!");
  for (const cleanupPath of [packDirectory, unpackDirectory, emptyPath, failingPath]) {
    t.after(() => fs.rm(cleanupPath, { recursive: true, force: true }));
    await fs.mkdir(cleanupPath, { recursive: true });
  }

  await runProcess("pnpm", ["-C", packageDirectory, "pack", "--pack-destination", packDirectory]);
  await runProcess("tar", ["-xzf", path.join(packDirectory, `patodo-localapp-${productVersion}.tgz`), "-C", unpackDirectory]);
  const wrapper = path.join(unpackDirectory, "package/template/runtime/sync-template.cjs");

  const missing = await runNode(wrapper, { PATH: emptyPath });
  assert.equal(missing.code, 0, missing.stderr);
  assert.match(missing.stderr, /localapp executable was not found; managed template sync was skipped/i);

  const failingExecutable = path.join(failingPath, process.platform === "win32" ? "localapp.cmd" : "localapp");
  await fs.writeFile(failingExecutable, process.platform === "win32" ? "@exit /b 29\r\n" : "#!/bin/sh\nexit 29\n");
  if (process.platform !== "win32") await fs.chmod(failingExecutable, 0o755);
  const failure = await runNode(wrapper, { PATH: failingPath });
  assert.equal(failure.code, 29, failure.stderr);
});

test("Windows packed wrapper executes a cmd shim from a spaced special-character PATH entry", { skip: process.platform !== "win32" }, async (t) => {
  const outputDirectory = path.join(testRoot, "windows wrapper package");
  const executableDirectory = path.join(testRoot, "windows & wrapper path (special)!");
  t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));
  t.after(() => fs.rm(executableDirectory, { recursive: true, force: true }));
  await fs.mkdir(executableDirectory, { recursive: true });
  const result = await buildLocalAppPackage({ outputDirectory });
  const wrapper = path.join(result.outputDirectory, "template/runtime/sync-template.cjs");
  await fs.writeFile(path.join(executableDirectory, "localapp.cmd"), "@exit /b 31\r\n");

  const failure = await runNode(wrapper, { PATH: executableDirectory });

  assert.equal(failure.code, 31, failure.stderr);
});

function run(directory, args, cwd = directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(directory, "bin/localapp.mjs"), ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`localapp exited ${code}: ${stderr}`));
    });
  });
}

function runNode(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}
