import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sourceBytes, ProjectStore, DevelopmentError } from "./projects.cjs";
import { developmentTemplateDirectory } from "./template.cjs";
import { writeAppPackage } from "@localapp/dsh-app-platform/app-package";
import type { PortablePackageFile } from "@localapp/dsh-app-platform/app-package";
import { loadAndValidateProjectManifest, type ValidatedProjectManifest } from "./project/check.cjs";
import { collectCanonicalFiles, buildApplicationPackage } from "./project/package.cjs";

export function createBuildOperations(): BuildOperations<ValidatedProjectManifest> {
  return {
    loadAndValidateProjectManifest, collectCanonicalFiles, buildApplicationPackage,
    createExecutor: async input => {
      const { DeepSeekHarness } = await import("@localapp/dsh-agent-runtime/harness");
      return new DeepSeekHarness(input);
    },
  };
}
const testPortsInUse = new Set<number>();
export async function allocateTestPorts() {
  const ports: number[] = [];
  try {
    while (ports.length < 2) {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const port = (server.address() as net.AddressInfo).port;
      const available = !testPortsInUse.has(port);
      if (available) { testPortsInUse.add(port); ports.push(port); }
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    return { ports, release: () => ports.forEach(port => testPortsInUse.delete(port)) };
  } catch (error) { ports.forEach(port => testPortsInUse.delete(port)); throw error; }
}
export interface BuildManifest { name: string; platformVersion: string; }
export interface BuildExecutor {
  initialize(): Promise<void>;
  close(): Promise<void>;
  executeDevelopmentCommand(command: string, args: string[], signal?: AbortSignal): Promise<{ exitCode: number | null; timedOut: boolean; stdout: { text: string }; stderr: { text: string } }>;
}
export interface BuildOperations<Manifest extends BuildManifest> {
  loadAndValidateProjectManifest(directory: string): Promise<Manifest>;
  collectCanonicalFiles(directory: string, manifest: Manifest): Promise<PortablePackageFile[]>;
  buildApplicationPackage(input: { projectDir: string; versionOverride: string; outputPath: string; signal: AbortSignal; run(invocation: { args: string[] }): Promise<{ exitCode: number; stdout: string; stderr: string }> }): Promise<{ path: string; sha256: string }>;
  createExecutor(input: { llmApiKey: string; llmBaseUrl: string; llmModel: string; root: string; workspaceRoot: string; dataRoot: string; networkBlocked: boolean; localTestPorts?: number[]; readDirectories: string[]; capabilities: ["terminal"] }): Promise<BuildExecutor>;
}
export interface DevelopmentBuild {
  id: string;
  projectId: string;
  sourceVersion: string;
  purpose?: "release" | "preview";
  status:
    "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  log: string;
  packagePath?: string;
  sha256?: string;
}
export interface BuildInput {
  workspace: string;
  signal: AbortSignal;
  log: (text: string) => void;
  id: string;
  purpose?: "release" | "preview";
}
export type BuildTask = (
  input: BuildInput,
) => Promise<{ path: string; sha256: string }>;
export function developmentDependenciesDirectory(dataDir: string): string {
  const config = path.join(dataDir, "development", "settings.json");
  const settings = fs.existsSync(config)
    ? JSON.parse(fs.readFileSync(config, "utf8"))
    : {};
  const dir =
    settings.dependenciesDirectory ??
    process.env.LOCALAPP_DEVELOPMENT_DEPENDENCIES ??
    path.join(developmentTemplateDirectory(), "node_modules");
  if (
    typeof dir !== "string" ||
    !path.isAbsolute(dir) ||
    path.basename(dir) !== "node_modules" ||
    !["vite", "tsc", "vitest"].every((n) =>
      fs.existsSync(path.join(dir, ".bin", n)),
    )
  )
    throw new DevelopmentError(
      "应用开发依赖未就绪，请管理员配置模板的 node_modules 目录",
      503,
    );
  return fs.realpathSync(dir);
}
function dependenciesReadDirectories(dir: string): string[] {
  const roots = [dir];
  const templateConfig = path.join(
    developmentTemplateDirectory(),
    "tsconfig.json",
  );
  if (fs.existsSync(templateConfig)) roots.push(templateConfig);
  for (
    let parent = path.dirname(dir);
    parent !== path.dirname(parent);
    parent = path.dirname(parent)
  ) {
    const file = path.join(parent, "package.json");
    if (fs.existsSync(file)) roots.push(file);
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const children = entry.name.startsWith("@")
      ? fs.readdirSync(full).map((n) => path.join(full, n))
      : [full];
    for (const child of children) {
      const real = fs.realpathSync(child);
      if (!roots.includes(real)) roots.push(real);
    }
  }
  return roots;
}
export class DevelopmentBuilds<Manifest extends BuildManifest = BuildManifest> {
  private stopped = false;
  private readonly active = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<void>;
      projectId: string;
      user: string;
    }
  >();
  constructor(
    private readonly dataDir: string,
    private readonly projects: ProjectStore,
    private readonly task?: BuildTask,
    private readonly operations?: BuildOperations<Manifest>,
  ) {
    for (const p of fs.readdirSync(projects.directory)) {
      const dir = path.join(projects.directory, p, "builds");
      if (!fs.existsSync(dir)) continue;
      for (const id of fs.readdirSync(dir)) {
        const record = path.join(dir, id, "record.json");
        if (!fs.existsSync(record)) continue;
        const b = JSON.parse(fs.readFileSync(record, "utf8"));
        if (["running", "queued"].includes(b.status)) {
          b.status = "interrupted";
          b.log += "\nServer 重启，任务已中断";
          this.save(b);
        }
      }
    }
  }
  private directory(project: string, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new DevelopmentError("构建标识无效");
    return path.join(this.projects.directory, project, "builds", id);
  }
  private save(b: DevelopmentBuild) {
    const file = path.join(this.directory(b.projectId, b.id), "record.json"),
      temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(b), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  get(project: string, user: string, id: string): DevelopmentBuild {
    this.projects.get(project, user);
    const file = path.join(this.directory(project, id), "record.json");
    if (!fs.existsSync(file)) throw new DevelopmentError("构建不存在", 404);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  list(project: string, user: string) {
    this.projects.get(project, user);
    const dir = path.join(this.projects.directory, project, "builds");
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .map((id) => this.get(project, user, id))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : [];
  }
  start(
    project: string,
    user: string,
    purpose: "release" | "preview" = "release",
  ) {
    if (this.stopped) throw new DevelopmentError("构建服务已停止", 503);
    this.projects.assertIdle(project, user);
    if ([...this.active.values()].some((b) => b.projectId === project))
      throw new DevelopmentError("项目已有构建任务", 409);
    if (this.active.size >= 2)
      throw new DevelopmentError("构建队列已满，请稍后重试", 429);
    const version = this.projects.snapshot(project, user, "构建输入");
    const b: DevelopmentBuild = {
      id: randomUUID(),
      projectId: project,
      sourceVersion: version.id,
      purpose,
      status: "queued",
      createdAt: new Date().toISOString(),
      log: "",
    };
    const workspace = path.join(this.directory(project, b.id), "workspace");
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    for (const [file, content] of Object.entries(
      this.projects.versionFiles(project, user, version.id),
    )) {
      const target = path.join(workspace, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, sourceBytes(content), { mode: 0o600 });
    }
    this.save(b);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 300000);
    deadline.unref();
    const promise = Promise.resolve().then(async () => {
      b.status = "running";
      this.save(b);
      const log = (text: string) => {
        b.log = (b.log + text).slice(-1024 * 1024);
        this.save(b);
      };
      try {
        controller.signal.throwIfAborted();
        const result = await (this.task ?? ((input) => this.build(input)))({
          id: b.id,
          purpose,
          workspace,
          signal: controller.signal,
          log,
        });
        if (controller.signal.aborted) b.status = "cancelled";
        else {
          b.status = "succeeded";
          b.packagePath = result.path;
          b.sha256 = result.sha256;
        }
      } catch (error) {
        b.status = controller.signal.aborted ? "cancelled" : "failed";
        log("\n" + (error as Error).message);
      } finally {
        this.save(b);
        clearTimeout(deadline);
        this.active.delete(b.id);
      }
    });
    this.active.set(b.id, { controller, promise, projectId: project, user });
    return b;
  }
  async wait(id: string) {
    await this.active.get(id)?.promise;
  }
  cancel(project: string, user: string, id: string) {
    this.get(project, user, id);
    this.active.get(id)?.controller.abort();
  }
  async close() {
    this.stopped = true;
    for (const a of this.active.values()) a.controller.abort();
    await Promise.all([...this.active.values()].map((a) => a.promise));
  }
  private async build(input: BuildInput) {
    const deps = developmentDependenciesDirectory(this.dataDir);
    const packageFile = path.join(input.workspace, "package.json"),
      pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")),
      template = JSON.parse(
        fs.readFileSync(
          path.join(developmentTemplateDirectory(), "package.json"),
          "utf8",
        ),
      );
    if (
      typeof pkg.scripts?.test !== "string" ||
      typeof pkg.scripts?.build !== "string"
    )
      throw new DevelopmentError("构建必须保留 test 和 build 脚本");
    for (const group of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      for (const [name, version] of Object.entries(pkg[group] ?? {})) {
        if (template[group]?.[name] !== version)
          throw new DevelopmentError(
            `依赖 ${name} 尚未由管理员准备，首版仅使用模板依赖`,
          );
      }
    }
    fs.writeFileSync(
      path.join(input.workspace, ".npmrc"),
      "public-hoist-pattern[]=pdfjs-dist\n",
      { mode: 0o600 },
    );
    const modules = path.join(input.workspace, "node_modules");
    fs.mkdirSync(modules);
    for (const name of fs.readdirSync(deps)) {
      if ([".vite-temp", ".cache", ".vite"].includes(name)) continue;
      if (name === ".bin" && process.platform !== "win32") {
        const binDir = path.join(modules, name);
        fs.mkdirSync(binDir);
        for (const command of fs.readdirSync(path.join(deps, name))) {
          const original = path.join(deps, name, command);
          const shim = fs.readFileSync(original);
          const text = shim.toString("utf8");
          if (text.startsWith("#!/bin/sh") && /^basedir=.*$/m.test(text)) {
            const quoted = `'${path.join(deps, name).replace(/'/g, "'\\''")}'`;
            fs.writeFileSync(path.join(binDir, command), text.replace(/^basedir=.*$/m, () => `basedir=${quoted}`), { mode: 0o755 });
          } else fs.symlinkSync(original, path.join(binDir, command));
        }
        continue;
      }
      fs.symlinkSync(path.join(deps, name), path.join(modules, name), "dir");
    }
    const runtime = path.join(developmentTemplateDirectory(), "runtime");
    if (fs.existsSync(runtime))
      fs.cpSync(runtime, path.join(input.workspace, ".localapp", "runtime"), {
        recursive: true,
      });
    const operations = this.operations;
    if (!operations) throw new DevelopmentError("构建执行环境未接入", 503);
    const testPorts = input.purpose === "preview" ? undefined : await allocateTestPorts();
    const executor = await operations.createExecutor({
      llmApiKey: "",
      llmBaseUrl: "http://127.0.0.1:9",
      llmModel: "build",
      root: path.join(path.dirname(input.workspace), "executor"),
      workspaceRoot: input.workspace,
      dataRoot: this.dataDir,
      networkBlocked: true,
      localTestPorts: testPorts?.ports,
      readDirectories: dependenciesReadDirectories(deps),
      capabilities: ["terminal"],
    }).catch(error => { testPorts?.release(); throw error; });
    const timer = setTimeout(
      () => input.log("\n构建达到时限，执行器会终止命令"),
      120000,
    );
    timer.unref();
    try {
      await executor.initialize();
      if (input.purpose === "preview") {
        input.log(
          "预览构建：编译和检查应用包，不代表测试通过，也不能直接发布。\n",
        );
        const result = await executor.executeDevelopmentCommand(
          path.join(path.dirname(process.execPath), "npm"),
          ["run", "build"],
          input.signal,
        );
        input.log(result.stdout.text + result.stderr.text);
        if (result.exitCode !== 0 || result.timedOut)
          throw new DevelopmentError("预览编译失败，请查看日志");
        const manifest = await operations.loadAndValidateProjectManifest(input.workspace);
        const files = await operations.collectCanonicalFiles(input.workspace, manifest);
        const outputPath = path.join(input.workspace, "preview.localapp");
        const written = await writeAppPackage({
          outputPath,
          metadata: {
            schemaVersion: 1,
            appId: manifest.name,
            version: `0.0.0-preview.${input.id.replaceAll("-", "")}`,
            platformVersion: manifest.platformVersion,
          },
          files,
        });
        return { path: outputPath, sha256: written.digest };
      }
      const result = await operations.buildApplicationPackage({
        projectDir: input.workspace,
        versionOverride: `0.0.0-development.${input.id.replaceAll("-", "")}`,
        outputPath: path.join(input.workspace, "application.localapp"),
        signal: input.signal,
        run: async (invocation) => {
          const executable = path.join(path.dirname(process.execPath), "npm");
          input.log(`\n$ npm ${invocation.args.join(" ")}\n`);
          const result = await executor.executeDevelopmentCommand(
            executable,
            invocation.args,
            input.signal,
          );
          input.log(result.stdout.text + result.stderr.text);
          return {
            exitCode: result.exitCode ?? 1,
            stdout: result.stdout.text,
            stderr: result.stderr.text,
          };
        },
      });
      return { path: result.path, sha256: result.sha256 };
    } finally {
      clearTimeout(timer);
      try { await executor.close(); } finally { testPorts?.release(); }
    }
  }
}
