import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildServerPackage } from "./build-server-package.mjs";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const testRoot = path.join(projectDirectory, "tmp/server-package-e2e");

test("packed Node Server initializes and serves Web without repository dependencies", async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
  await fs.mkdir(testRoot, { recursive: true });
  const outputDirectory = path.join(testRoot, "artifact");
  const repeatedDirectory = path.join(testRoot, "artifact-repeat");
  const dataDirectory = await fs.mkdtemp(path.join(testRoot, "data-"));
  const artifact = await buildServerPackage({ outputDirectory });
  const repeated = await buildServerPackage({ outputDirectory: repeatedDirectory });
  assert.equal(artifact.bundleDigest, repeated.bundleDigest);
  const manifest = JSON.parse(await fs.readFile(artifact.manifestPath, "utf8"));
  assert.ok(manifest.files["native-client/entry.js"]);
  assert.ok(manifest.files["native-client/entry.css"]);
  assert.ok(Object.keys(manifest.files).some(file => file.startsWith("native-client/assets/") && file.endsWith(".woff2")));
  for (const skill of ["markitdown", "pdf", "docx", "xlsx"]) {
    assert.ok(manifest.files[`skills/${skill}/SKILL.md`]);
    assert.ok(manifest.files[`skills/${skill}/LICENSE`]);
    assert.ok(manifest.files[`skills/${skill}/SOURCE.json`]);
    assert.ok(Object.keys(manifest.files).some((file) => file.startsWith(`skills/${skill}/scripts/`) && file.endsWith(".py")));
  }
  for (const plugin of ["dsh-client-modules", "dsh-client-ui-chat", "dsh-client-ui-trajectory", "dsh-client-ui-renderer"]) {
    assert.ok(manifest.files["node_modules/@deepseek-ai/" + plugin + "/lib/client.js"], plugin + " client artifact must be packaged");
  }
  assert.ok(manifest.files["node_modules/@localapp/dsh-multiuser/dist/native-client.mjs"]);
  const clientBoot = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import { Context } from "@deepseek-ai/cordis";
    import { mountNativeClientModules } from "@localapp/dsh-multiuser/native-client";
    const ctx = new Context();
    try {
      const modules = await mountNativeClientModules(ctx);
      const graph = modules.graph();
      for (const entry of graph.entries) {
        if (!modules.clientPath(entry.id)?.startsWith(process.cwd())) throw new Error("Client artifact escaped package: " + entry.id);
        const response = await modules.fetchBundle(new Request("http://package.test/" + entry.url));
        if (response.status !== 200) throw new Error("Client artifact missing: " + entry.id);
      }
      console.log(JSON.stringify({ entries: graph.entries.length }));
    } finally { await ctx.fiber.dispose(); }
  `], { cwd: outputDirectory, env: { ...process.env, NODE_PATH: "" }, timeout: 15000 });
  assert.ok(JSON.parse(clientBoot.stdout.trim()).entries >= 23);
  assert.match(await fs.readFile(artifact.bin, "utf8"), /LOCALAPP_PUBLIC_SKILLS_ROOT/);
  assert.equal((await fs.readFile(artifact.bin, "utf8")).startsWith("#!/usr/bin/env node\n"), true);

  const child = spawn(process.execPath, [artifact.bin, "start", "--data-dir", dataDirectory, "--port", "0"], {
    cwd: outputDirectory,
    env: { ...process.env, NODE_PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const ready = await readReadyLine(child.stdout);
    assert.equal(ready.type, "ready");
    assert.equal((await fetch(`${ready.url}/health`)).status, 200);
    const setupResponse = await fetch(ready.setupUrl);
    assert.equal(setupResponse.status, 200, stderr);
    assert.match(await setupResponse.text(), /Create|admin|管理员/i);
    assert.equal(await fileExists(path.join(dataDirectory, "jwt.key")), true);
  } finally {
    if (!child.killed) child.kill("SIGTERM");
    await onceExit(child);
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

async function readReadyLine(stream) {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === "ready") {
            stream.off("data", onData);
            resolve(message);
            return;
          }
        } catch {
          // Ignore non-JSON diagnostic lines until the readiness message.
        }
      }
    };
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.once("error", reject);
  });
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function fileExists(filePath) {
  return (await fs.stat(filePath).catch(() => null))?.isFile() ?? false;
}
