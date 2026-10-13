import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { buildLocalappClient } from "./build-localapp-client.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Preserve upstream module paths, native helpers and package assets. Bundling
// those plugins into a CJS file loses import.meta.url and their worker paths.
export async function copyHarnessDependencies(serverDirectory, outputDirectory) {
  const source = JSON.parse(await fs.readFile(path.join(serverDirectory, "package.json"), "utf8"));
  const internalPlugins = new Set(["@localapp/app-foundation", "@localapp/dsh-app-sync","@localapp/dsh-collaboration","@localapp/dsh-device-services", "@localapp/dsh-agent-runtime","@localapp/dsh-agent-settings","@localapp/dsh-execution-environment", "@localapp/dsh-model-settings", "@localapp/dsh-document-tools", "@localapp/dsh-agent-ui", "@localapp/dsh-multiuser", "@localapp/dsh-app-platform", "@localapp/dsh-app-development"]);
  const roots = [...Object.keys(source.dependencies).filter((name) => name.startsWith("@deepseek-ai/") || internalPlugins.has(name)), ...Object.keys(source.devDependencies ?? {}).filter(name => name.startsWith("@types/"))];
  const canonical = new Map();
  const copies = new Set();
  const outputModules = path.join(outputDirectory, "node_modules");
  async function locate(name, from) {
    const require = createRequire(path.join(from, "package.json"));
    // Dependencies can share a name with a Node builtin (string_decoder).
    // Resolve their package directory even when Node would prefer the builtin.
    for (const directory of require.resolve.paths(name) ?? require.resolve.paths("__localapp_package_lookup__") ?? []) {
      const candidate = path.join(directory, name, "package.json");
      try { await fs.access(candidate); return fs.realpath(path.dirname(candidate)); } catch {}
    }
    throw new Error(`Missing packaged Harness dependency: ${name}`);
  }
  async function copy(name, from, parentDestination) {
    const sourceDirectory = await locate(name, from);
    const existing = canonical.get(name);
    const destination = !existing || existing.sourceDirectory === sourceDirectory
      ? path.join(outputModules, name)
      : path.join(parentDestination, "node_modules", name);
    if (!existing) canonical.set(name, { sourceDirectory, destination });
    if (copies.has(destination)) return;
    copies.add(destination);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const metadata = JSON.parse(await fs.readFile(path.join(sourceDirectory, "package.json"), "utf8"));
    // Deprecated @types stubs contain no declarations. Shipping them in the
    // type root makes TypeScript report a missing implicit type library.
    if (name.startsWith("@types/") && !metadata.types && !metadata.typings) {
      try { await fs.access(path.join(sourceDirectory, "index.d.ts")); }
      catch { return; }
    }
    if (internalPlugins.has(name)) {
      await fs.mkdir(destination, { recursive: true });
      await fs.copyFile(path.join(sourceDirectory, "package.json"), path.join(destination, "package.json"));
      if (name === "@localapp/dsh-execution-environment") await fs.cp(path.join(sourceDirectory, "skills"), path.join(destination, "skills"), { recursive: true });
      // Include private runtime modules as well as public package entries.
      // Unbundled ESM entries keep relative imports; exports alone cannot
      // enumerate everything required to boot the plugin.
      const targets = new Set(Object.values(metadata.exports).map(entry => entry.default));
      for (const file of await fs.readdir(path.join(sourceDirectory, "src"), { recursive: true })) {
        if (/\.(?:cts|mts)$/.test(file) && !/\.d\.(?:cts|mts)$/.test(file)) {
          targets.add("./dist/" + file.replace(/\.cts$/, ".cjs").replace(/\.mts$/, ".mjs"));
        }
      }
      // Always compile from source, never stale workspace dist files.
      for (const target of [...targets].sort()) {
        if (target.startsWith("./ui/")) {
          await fs.mkdir(path.dirname(path.join(destination, target)), { recursive: true });
          await fs.copyFile(path.join(sourceDirectory, target), path.join(destination, target));
          continue;
        }
        if (target.startsWith("./runner/")) {
          await fs.mkdir(path.dirname(path.join(destination, target)), { recursive: true });
          await fs.copyFile(path.join(sourceDirectory, target), path.join(destination, target));
          continue;
        }
        if (metadata.dsh?.client && target === "./dist/client.cjs") {
          await buildLocalappClient(sourceDirectory, path.join(destination, target), name);
          continue;
        }
        const commonjs = target.endsWith(".cjs");
        const source = target.replace(/^\.\/dist\//, "src/").replace(/\.(mjs|cjs|js)$/, (_match, extension) => extension === "cjs" ? ".cts" : extension === "mjs" ? ".mts" : ".ts");
        // AWS's dependency graph contains many overlapping versions. Keep its
        // runtime in this entry, as the former Server bundle did, rather than
        // duplicating the graph under each parent package.
        const bundledStorage = name === "@localapp/app-foundation" && source === "src/content-storage.cts";
        await build({ entryPoints: [path.join(sourceDirectory, source)], outfile: path.join(destination, target), platform: "node", format: commonjs ? "cjs" : "esm", target: "node24", bundle: bundledStorage, logLevel: "silent" });
      }
      const compiler = createRequire(path.join(serverDirectory, "package.json")).resolve("typescript/bin/tsc");
      await promisify(execFile)(process.execPath, [compiler, "--project", path.join(sourceDirectory, "tsconfig.json"), "--emitDeclarationOnly", "--outDir", path.join(destination, "dist")]);
      for (const dependency of Object.keys(metadata.devDependencies ?? {}).filter(name => name.startsWith("@types/"))) await copy(dependency, sourceDirectory, destination);
    } else await fs.cp(sourceDirectory, destination, { recursive: true, filter: (file) => {
      const relative = path.relative(sourceDirectory, file);
      // Public plugin consumers need declarations as well as runtime assets.
      return path.basename(file) !== ".npmignore"
        && relative.split(path.sep)[0] !== "node_modules"
        && !relative.endsWith(".map");
    } });
    for (const dependency of new Set([...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.peerDependencies ?? {}), ...Object.keys(metadata.optionalDependencies ?? {})])) {
      if (name === "@localapp/app-foundation" && dependency === "@aws-sdk/client-s3") continue;
      let resolved;
      try { resolved = await locate(dependency, sourceDirectory); }
      catch (error) {
        if (metadata.optionalDependencies?.[dependency] || metadata.peerDependenciesMeta?.[dependency]?.optional) continue;
        throw error;
      }
      const inherited = canonical.get(dependency);
      if (inherited?.sourceDirectory === resolved && copies.has(inherited.destination)) continue;
      await copy(dependency, sourceDirectory, destination);
    }
  }
  // Reserve direct package versions before traversing optional peer graphs.
  for (const name of roots) canonical.set(name, { sourceDirectory: await locate(name, serverDirectory), destination: path.join(outputModules, name) });
  for (const name of roots) await copy(name, serverDirectory, outputDirectory);
}
