import fs from "node:fs";
import path from "node:path";
import { DevelopmentError } from "./projects.cjs";
export function developmentTemplateDirectory(): string {
  const configured = process.env.LOCALAPP_TEMPLATE_DIR;
  if (configured && fs.existsSync(path.join(configured, "package.json")))
    return fs.realpathSync(configured);
  for (
    let dir = __dirname;
    dir !== path.dirname(dir);
    dir = path.dirname(dir)
  ) {
    for (const name of ["template", "init-repo"]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
  }
  throw new DevelopmentError("builtin 模板未就绪，请联系管理员检查安装", 503);
}
export function templateSource(name: string): Record<string, string> {
  const root = developmentTemplateDirectory();
  const files: Record<string, string> = {};
  const excluded = new Set([
    "node_modules",
    "dist",
    ".git",
    ".next",
    "data",
    "tmp",
    "runtime",
    ".localapp",
    "template.npmrc",
    "template.gitignore",
    ".npmrc",
  ]);
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excluded.has(e.name) || e.name.endsWith(".tsbuildinfo")) continue;
      const file = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(file);
      else if (e.isFile()) {
        const content = fs.readFileSync(file, "utf8");
        if (!content.includes("\0"))
          files[path.relative(root, file).split(path.sep).join("/")] = content;
      }
    }
  };
  walk(root);
  const manifest = {
    name,
    description: "",
    distDir: "dist",
    db: { mode: "crud", sqlAccess: "authenticated" },
    backend: { root: "backend" },
    requires: {
      backend: "named-sql",
      identity: ["currentUser", "pageOwner"],
      primitives: [],
    },
    platformVersion: "^1.2",
  };
  files["manifest.json"] = JSON.stringify(manifest, null, 2);
  const pkg = JSON.parse(files["package.json"]);
  pkg.name = name;
  files["package.json"] = JSON.stringify(pkg, null, 2);
  return files;
}
