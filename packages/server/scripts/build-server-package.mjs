import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { harnessBundlePlugin } from "./harness-bundle-plugin.mjs";
import { copyHarnessDependencies } from "./harness-package-dependencies.mjs";
import { buildNativeClient } from "./build-native-client.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "../../..");
const serverDirectory = path.join(projectDirectory, "packages/server");
const sourceDirectory = path.join(serverDirectory, "src");
const defaultOutputDirectory = path.join(projectDirectory, "tmp/localapp-server-package");

/**
 * Build the self-contained Server runtime embedded by the localapp package.
 * @param {{ outputDirectory?: string }} [options]
 */
export async function buildServerPackage(options = {}) {
  const outputDirectory = path.resolve(options.outputDirectory ?? process.env.LOCALAPP_SERVER_PACKAGE_DIR ?? defaultOutputDirectory);
  const binDirectory = path.join(outputDirectory, "bin");
  const webDirectory = path.join(outputDirectory, "web");
  const runnerDirectory = path.join(outputDirectory, "runner");
  const sqlDirectory = path.join(outputDirectory, "node_modules/sql.js");
  const sourcePackage = JSON.parse(await fs.readFile(path.join(serverDirectory, "package.json"), "utf8"));
  const webOutput = path.join(projectDirectory, "packages/web/out");
  await assertFile(path.join(webOutput, "index.html"));

  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(binDirectory, { recursive: true, mode: 0o755 });
  await fs.copyFile(path.join(serverDirectory, "THIRD_PARTY_NOTICES.txt"), path.join(outputDirectory, "THIRD_PARTY_NOTICES.txt"));
  await fs.cp(webOutput, webDirectory, { recursive: true });
  await buildNativeClient(path.join(outputDirectory, "native-client"));
  await fs.cp(path.join(projectDirectory, "packages/dsh-document-tools/skills"), path.join(outputDirectory, "skills"), { recursive: true });
  await fs.mkdir(runnerDirectory, { recursive: true, mode: 0o755 });
  await fs.cp(path.join(serverDirectory, "runner/localapp-runner.mjs"), path.join(runnerDirectory, "localapp-runner.mjs"));
  await fs.cp(path.join(serverDirectory, "runner/task-supervisor.mjs"), path.join(runnerDirectory, "task-supervisor.mjs"));

  const bundleOptions = {
    alias: {
      "@localapp/dsh-multiuser/native-server": path.join(projectDirectory, "packages/dsh-multiuser/src/native-server.mts"),
      "@localapp/dsh-multiuser/native-scope": path.join(projectDirectory, "packages/dsh-multiuser/src/native-scope.cts"),
      "@localapp/dsh-multiuser/native-session": path.join(projectDirectory, "packages/dsh-multiuser/src/native-session.mts"),
      "@localapp/dsh-multiuser": path.join(projectDirectory, "packages/dsh-multiuser/src/index.mts"),
      "@localapp/dsh-multiuser/auth-cookies": path.join(projectDirectory, "packages/dsh-multiuser/src/auth-cookies.cts"),
      "@localapp/dsh-multiuser/browser-sessions": path.join(projectDirectory, "packages/dsh-multiuser/src/browser-sessions.cts"),
      "@localapp/dsh-multiuser/profile-routes": path.join(projectDirectory, "packages/dsh-multiuser/src/profile-routes.cts"),
      "@localapp/dsh-multiuser/keys-routes": path.join(projectDirectory, "packages/dsh-multiuser/src/keys-routes.cts"),
      "@localapp/dsh-multiuser/auth-sessions": path.join(projectDirectory, "packages/dsh-multiuser/src/auth-sessions.cts"),
      "@localapp/dsh-multiuser/auth-routes": path.join(projectDirectory, "packages/dsh-multiuser/src/auth-routes.cts"),
      "@localapp/dsh-multiuser/api-keys": path.join(projectDirectory, "packages/dsh-multiuser/src/api-keys.cts"),
      "@localapp/dsh-multiuser/account-schema": path.join(projectDirectory, "packages/dsh-multiuser/src/account-schema.cts"),
      "@localapp/dsh-multiuser/account-services": path.join(projectDirectory, "packages/dsh-multiuser/src/account-services.cts"),
      "@localapp/dsh-multiuser/admin-accounts-routes": path.join(projectDirectory, "packages/dsh-multiuser/src/admin-accounts-routes.cts"),
      "@localapp/dsh-multiuser/setup-token-store": path.join(projectDirectory, "packages/dsh-multiuser/src/setup-token-store.cts"),
      "@localapp/dsh-multiuser/loopback": path.join(projectDirectory, "packages/dsh-multiuser/src/loopback.cts"),
      "@localapp/dsh-multiuser/setup-routes": path.join(projectDirectory, "packages/dsh-multiuser/src/setup-routes.cts"),
      "@localapp/dsh-multiuser/environment-routes": path.join(projectDirectory, "packages/dsh-multiuser/src/environment-routes.cts"),
      "@localapp/dsh-multiuser/system-environment": path.join(projectDirectory, "packages/dsh-multiuser/src/system-environment.cts"),
      "@localapp/dsh-multiuser/public-skills": path.join(projectDirectory, "packages/dsh-multiuser/src/public-skills.cts"),
      "@localapp/dsh-multiuser/harness-capabilities": path.join(projectDirectory, "packages/dsh-multiuser/src/harness-capabilities.mts"),
      "@localapp/dsh-multiuser/harness": path.join(projectDirectory, "packages/dsh-multiuser/src/harness.mts"),
      "@localapp/dsh-multiuser/llm-adapter": path.join(projectDirectory, "packages/dsh-multiuser/src/llm-adapter.mts"),
      "@localapp/dsh-multiuser/accounts": path.join(projectDirectory, "packages/dsh-multiuser/src/accounts.cts"),
      "@localapp/dsh-multiuser/groups": path.join(projectDirectory, "packages/dsh-multiuser/src/groups.cts"),
      "@localapp/dsh-multiuser/groups-routes": path.join(projectDirectory, "packages/dsh-multiuser/src/groups-routes.cts"),
      "@localapp/dsh-multiuser/personal-pages": path.join(projectDirectory, "packages/dsh-multiuser/src/personal-pages.cts"),
      "@localapp/dsh-multiuser/llm-routes": path.join(projectDirectory, "packages/dsh-multiuser/src/llm-routes.cts"),
      "@localapp/dsh-multiuser/request-identity": path.join(projectDirectory, "packages/dsh-multiuser/src/request-identity.cts"),
      "@localapp/dsh-multiuser/settings": path.join(projectDirectory, "packages/dsh-multiuser/src/settings.cts"),
      "@localapp/dsh-multiuser/python-environment": path.join(projectDirectory, "packages/dsh-multiuser/src/python-environment.cts"),
      "@localapp/dsh-multiuser/agent-environment": path.join(projectDirectory, "packages/dsh-multiuser/src/agent-environment.cts"),
    },
    bundle: true,
    plugins: [harnessBundlePlugin(), {
      name: "localapp-native-harness-entry",
      setup(build) {
        build.onResolve({ filter: /(?:^|\/)deepseek-harness\.mjs$/ }, () => ({ path: "./harness.mjs", external: true }));
        // Keep the default WebServer import in ESM; CJS wrapping changes it
        // into a namespace object and prevents the carrier from extending it.
        build.onResolve({ filter: /(?:^|\/)native-server(?:\.m[jt]s)?$/ }, () => ({ path: "@localapp/dsh-multiuser/native-server", external: true }));
      },
    }],
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: false,
    legalComments: "none",
    external: ["@localapp/dsh-agent-ui", "@localapp/dsh-agent-ui/*", "sql.js", "@deepseek-ai/*", "@localapp/dsh-multiuser/native-server", "@localapp/dsh-document-tools", "@localapp/dsh-document-tools/*", "@localapp/dsh-app-platform", "@localapp/dsh-app-platform/*", "@localapp/dsh-app-development", "@localapp/dsh-app-development/*"],
    define: { "process.env.LOCALAPP_PACKAGE_ENTRY": '"1"' },
    absWorkingDir: projectDirectory,
    logLevel: "warning",
  };
  await build({ ...bundleOptions, entryPoints: [path.join(sourceDirectory, "package-cli.ts")], outfile: path.join(binDirectory, "server-cli.cjs") });
  await build({ ...bundleOptions, entryPoints: [path.join(sourceDirectory, "package-worker.ts")], outfile: path.join(binDirectory, "worker.cjs") });
  await build({ ...bundleOptions, format: "esm", plugins: [], entryPoints: [path.join(sourceDirectory, "lib/deepseek-harness.mts")], outfile: path.join(binDirectory, "harness.mjs") });
  const launcher = `#!/usr/bin/env node\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\n\nconst packageDirectory = path.dirname(fileURLToPath(import.meta.url));\nprocess.env.LOCALAPP_WORKER_PATH ??= path.join(packageDirectory, "worker.cjs");\nprocess.env.LOCALAPP_PUBLIC_SKILLS_ROOT ??= path.resolve(packageDirectory, "../skills");\nprocess.env.LOCALAPP_WEB_ROOT ??= path.resolve(packageDirectory, "../web");\nprocess.env.LOCALAPP_NATIVE_CLIENT_ROOT ??= path.resolve(packageDirectory, "../native-client");\nawait import("./server-cli.cjs");\n`;
  await fs.writeFile(path.join(binDirectory, "server.mjs"), launcher, { mode: 0o755 });
  await fs.chmod(path.join(binDirectory, "server-cli.cjs"), 0o755);
  await fs.chmod(path.join(binDirectory, "worker.cjs"), 0o755);
  await fs.chmod(path.join(binDirectory, "server.mjs"), 0o755);

  await copyHarnessDependencies(serverDirectory, outputDirectory);

  const require = createRequire(import.meta.url);
  const sqlEntry = require.resolve("sql.js", { paths: [serverDirectory] });
  const sqlPackageDirectory = path.resolve(path.dirname(sqlEntry), "..");
  await fs.cp(path.join(sqlPackageDirectory, "package.json"), path.join(sqlDirectory, "package.json"));
  await fs.mkdir(path.join(sqlDirectory, "dist"), { recursive: true });
  await fs.cp(path.join(path.dirname(sqlEntry), "sql-wasm.js"), path.join(sqlDirectory, "dist/sql-wasm.js"));
  await fs.cp(path.join(path.dirname(sqlEntry), "sql-wasm.wasm"), path.join(sqlDirectory, "dist/sql-wasm.wasm"));

  const packageJson = {
    name: "@localapp/server-runtime",
    version: sourcePackage.version,
    description: "LocalApp canonical Server",
    license: sourcePackage.license,
    type: "module",
    private: true,
    engines: { node: ">=24" },
  };
  await writeJson(path.join(outputDirectory, "package.json"), packageJson);
  const files = await listFiles(outputDirectory);
  const digests = {};
  for (const file of files) {
    if (file === ".localapp-server-runtime.json") continue;
    digests[file] = await sha256(path.join(outputDirectory, file));
  }
  const bundleDigest = sha256Bytes(Buffer.from(JSON.stringify(digests)));
  const manifest = {
    schemaVersion: 1,
    name: packageJson.name,
    version: packageJson.version,
    nodeMajor: 24,
    entrypoint: "bin/server.mjs",
    worker: "bin/worker.cjs",
    bundleDigest,
    files: digests,
  };
  await writeJson(path.join(outputDirectory, ".localapp-server-runtime.json"), manifest);
  return {
    outputDirectory,
    bin: path.join(outputDirectory, "bin/server.mjs"),
    worker: path.join(outputDirectory, "bin/worker.cjs"),
    manifestPath: path.join(outputDirectory, ".localapp-server-runtime.json"),
    bundleDigest,
  };
}

async function assertFile(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Required package input is missing: ${filePath}`);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function listFiles(directory, prefix = "") {
  const entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.posix.join(prefix.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(directory, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildServerPackage().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
