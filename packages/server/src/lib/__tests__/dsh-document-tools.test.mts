import { Context } from "@deepseek-ai/cordis";
import DocumentTools from "@localapp/dsh-document-tools";
import { DOCUMENT_SKILLS_ROOT, PUBLIC_SKILL_PYTHON_MODULES } from "@localapp/dsh-document-tools/catalog";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

it("provides selected document bundles independently and blocks missing dependencies or a stopped plugin", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/document-plugin");
  await fs.mkdir(parent, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(parent, "workspace-"));
  const context = new Context();
  try {
    await context.plugin(DocumentTools);
    const documents = context.localappDocuments;
    expect(documents.root).toBe(DOCUMENT_SKILLS_ROOT);
    expect(context.get("localappMultiuser")).toBeUndefined();
    expect(context.get("localappApps")).toBeUndefined();
    expect(context.get("localappDevelopment")).toBeUndefined();
    const report = { checks: ["runner", "python", ...new Set(Object.values(PUBLIC_SKILL_PYTHON_MODULES).flat())].map(id => ({ id, status: "ready" })) };
    expect(documents.catalog(report).every(skill => skill.available)).toBe(true);
    const directory = documents.prepare(workspace, ["pdf", "pdf", "docx"], report);
    expect((await fs.readdir(directory)).sort()).toEqual(["docx", "pdf"]);
    for (const id of ["pdf", "docx"]) {
      expect(await fs.readFile(path.join(directory, id, "SKILL.md"), "utf8")).toContain("---");
      expect((await fs.stat(path.join(directory, id, "LICENSE"))).isFile()).toBe(true);
      expect(JSON.parse(await fs.readFile(path.join(directory, id, "SOURCE.json"), "utf8"))).toBeTruthy();
      expect((await fs.readdir(path.join(directory, id, "scripts"))).some(file => file.endsWith(".py"))).toBe(true);
    }
    expect(() => documents.prepare(workspace, ["unknown"], report)).toThrow("Unknown public skill");
    const missing = { checks: report.checks.filter(check => check.id !== "pypdf") };
    expect(documents.catalog(missing).find(skill => skill.id === "pdf")?.available).toBe(false);
    expect(() => documents.prepare(workspace, ["pdf"], missing)).toThrow("dependencies are not ready");
    expect((await fs.readdir(directory)).sort()).toEqual(["docx", "pdf"]);
    await context.fiber.dispose();
    expect(() => documents.catalog(report)).toThrow("plugin is stopped");
    expect(() => documents.prepare(workspace, ["pdf"], report)).toThrow("plugin is stopped");
  } finally { await context.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }); }
});
