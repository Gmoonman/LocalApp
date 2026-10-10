import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildNativeClient } from "./build-native-client.mjs";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
test("builds the original dsh web entry with browser assets", async () => {
  const parent = path.join(projectDirectory, "tmp/native-client-build-test");
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "entry-"));
  try {
    await buildNativeClient(directory);
    const script = await fs.readFile(path.join(directory, "entry.js"), "utf8");
    assert.match(script, /Native client mount point is missing/);
    assert.match(script, /web boot/);
    assert.ok((await fs.readFile(path.join(directory, "entry.css"), "utf8")).length > 100);
    assert.ok((await fs.readdir(path.join(directory, "assets"))).some(file => file.endsWith(".woff2")));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
