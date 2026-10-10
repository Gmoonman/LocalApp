import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Compile the upstream web boot kernel and its shared module table. */
export async function buildNativeClient(outputDirectory) {
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
