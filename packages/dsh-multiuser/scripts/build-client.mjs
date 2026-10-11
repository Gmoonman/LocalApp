import { readFile } from "node:fs/promises";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** Emit the same lazy module registration format as upstream dsh plugins. */
export async function buildLocalappClient(sourceDirectory, outputFile, id = "@localapp/dsh-multiuser") {
  const metadata = JSON.parse(await readFile(path.join(sourceDirectory, "package.json"), "utf8"));
  const entryPoint = path.resolve(sourceDirectory, metadata.localapp?.clientEntry ?? "src/client.mts");
  if (!entryPoint.startsWith(sourceDirectory + path.sep)) throw new Error("Client entry must be inside the plugin");
  await build({
    entryPoints: [entryPoint],
    plugins: [{name: "localapp-settings-css", setup(builder) {
      builder.onLoad({filter: /native-settings\.css$/}, async ({path: cssPath}) => {
        const source = await readFile(cssPath, "utf8");
        const result = await postcss([tailwind({base: sourceDirectory})]).process(source, {from: cssPath});
        return {contents: result.css, loader: "text"};
      });
    }}],
    outfile: outputFile,
    jsx: "automatic",
    platform: "browser", format: "cjs", bundle: true, target: "es2022",
    external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/dsh-client-ui-primitives"],
    banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
    footer: { js: "return module.exports;}});" },
    logLevel: "silent",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await buildLocalappClient(sourceDirectory, path.join(sourceDirectory, "dist/client.cjs"));
}
