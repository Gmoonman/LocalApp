import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { hostProcessId } from "./hostProcessId.js";

it("maps an isolated PID to the uniquely named host process", async () => {
  const parent = path.resolve(__dirname, "../../../../../../tmp/host-process-id");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "proc-"));
  try {
    for (const [pid, title] of [[1, "host-init"], [12345, "unique-sandbox-process"]] as const) {
      await fs.mkdir(path.join(root, String(pid)));
      await fs.writeFile(path.join(root, String(pid), "cmdline"), title + "\0");
    }
    expect(await hostProcessId(1, "unique-sandbox-process", "linux", root)).toBe(12345);
    await expect(hostProcessId(1, "missing", "linux", root)).rejects.toThrow("found 0");
    await fs.mkdir(path.join(root, "12346"));
    await fs.writeFile(path.join(root, "12346/cmdline"), "unique-sandbox-process\0");
    await expect(hostProcessId(1, "unique-sandbox-process", "linux", root)).rejects.toThrow("found 2");
    expect(await hostProcessId(7, "unused", "darwin", root)).toBe(7);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
