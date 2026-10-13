import { expect, it } from "vitest";
it("loads Python configuration and dependency checks from the standalone multiuser plugin", async () => {
  const python = await import("@localapp/dsh-execution-environment/python-environment");
  const environment = await import("@localapp/dsh-execution-environment/agent-environment");
  expect(python.shellQuote("/space dir/python")).toBe("'/space dir/python'");
  expect(environment.environmentProbe("/space dir/python")).toContain("'/space dir/python'");
  const report = environment.summarizeEnvironment(JSON.stringify({ version: [3, 12, 0], python: "python", modules: { docx: true }, commands: { soffice: true } }), ["docx"], []);
  expect(report.ready).toBe(true);
});

it("reads existing Server Python settings without changing their location or contents", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/dsh-plugin-environment");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "compatibility-"));
  const config = { executable: "/example/venv/bin/python", directory: "/example/venv", baseDirectory: "/example/python", version: "3.12.0", revision: "existing-settings", managed: true };
  const content = JSON.stringify(config);
  try {
    const filename = path.join(root, "python-environment.json"); await fs.writeFile(filename, content);
    const plugin = await import("@localapp/dsh-execution-environment/python-environment");
    const server = await import("../python-environment.js");
    expect(plugin.readPythonEnvironment(root)).toEqual(config);
    expect(server.readPythonEnvironment(root)).toEqual(config);
    await expect(plugin.selectPythonEnvironment(root, "python3")).rejects.toThrow("绝对路径");
    expect(await fs.readFile(filename, "utf8")).toBe(content);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
