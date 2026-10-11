import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildLocalappClient } from "./build-localapp-client.mjs";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Compile the upstream web boot kernel and its shared module table. */
export async function buildNativeClient(outputDirectory) {
  await buildLocalappClient(path.join(projectDirectory, "packages/dsh-multiuser"), path.join(projectDirectory, "packages/dsh-multiuser/dist/client.cjs"));
  await buildLocalappClient(path.join(projectDirectory, "packages/dsh-agent-ui"), path.join(projectDirectory, "packages/dsh-agent-ui/dist/client.cjs"), "@localapp/dsh-agent-ui");
  await buildLocalappClient(path.join(projectDirectory, "packages/dsh-app-platform"), path.join(projectDirectory, "packages/dsh-app-platform/dist/client.cjs"), "@localapp/dsh-app-platform");
  await buildLocalappClient(path.join(projectDirectory, "packages/dsh-app-development"), path.join(projectDirectory, "packages/dsh-app-development/dist/client.cjs"), "@localapp/dsh-app-development");
  await build({
    entryPoints: [path.join(projectDirectory, "packages/dsh-multiuser/src/native-web-entry.ts")],
    outdir: outputDirectory,
    entryNames: "entry",
    assetNames: "assets/[name]-[hash]",
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: true,
    loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
    alias: { "node:module": path.join(projectDirectory, "packages/dsh-multiuser/src/browser-node-module.ts") },
    define: { "process.versions.node": '"0.0.0"', "process.execArgv": "[]", "process.env.CORDIS_SHARED": "undefined", "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildNativeClient(path.join(projectDirectory, "tmp/native-client-entry"));
}
