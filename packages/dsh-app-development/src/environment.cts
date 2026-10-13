import fs from "node:fs";
import path from "node:path";
import { allocateTestPorts, developmentDependenciesDirectory } from "./builds.cjs";
import { DevelopmentError } from "./projects.cjs";
export interface DevelopmentSettings {
  dependenciesDirectory?: string;
  previewOrigin?: string;
}
export function readDevelopmentSettings(dataDir: string): DevelopmentSettings {
  const file = path.join(dataDir, "development", "settings.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}
export function saveDevelopmentSettings(
  dataDir: string,
  value: DevelopmentSettings,
) {
  if (
    value.dependenciesDirectory !== undefined &&
    (typeof value.dependenciesDirectory !== "string" ||
      !path.isAbsolute(value.dependenciesDirectory) ||
      path.basename(value.dependenciesDirectory) !== "node_modules" ||
      !fs.existsSync(value.dependenciesDirectory))
  )
    throw new DevelopmentError("请选择已准备的绝对 node_modules 路径");
  if (value.previewOrigin) {
    if (
      typeof value.previewOrigin !== "string"
    )
      throw new DevelopmentError("预览地址必须是 URL");
    const url = new URL(
      value.previewOrigin.replaceAll("{previewId}", "preview-check"),
    );
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname.endsWith(".localhost"))
    )
      throw new DevelopmentError("远程预览必须使用 HTTPS");
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new DevelopmentError("预览地址只能包含协议、域名和端口");
  }
  const file = path.join(dataDir, "development", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
  return value;
}
import type { BuildManifest, BuildOperations } from "./builds.cjs";
export async function developmentEnvironment(dataDir: string, createExecutor: BuildOperations<BuildManifest>["createExecutor"]) {
  const checks: Array<{ id: string; ready: boolean; detail: string }> = [];
  let dependencies: string | undefined;
  try {
    dependencies = developmentDependenciesDirectory(dataDir);
    checks.push({
      id: "dependencies",
      ready: true,
      detail: "模板构建依赖已准备",
    });
  } catch (e) {
    checks.push({
      id: "dependencies",
      ready: false,
      detail: (e as Error).message,
    });
  }
  const root = path.join(dataDir, "development", "environment"),
    workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const testPorts = await allocateTestPorts();
  try {
    const executor = await createExecutor({
      llmApiKey: "",
      llmBaseUrl: "http://127.0.0.1:9",
      llmModel: "environment",
      root: path.join(root, "sessions"),
      workspaceRoot: workspace,
      dataRoot: dataDir,
      networkBlocked: true,
      localTestPorts: testPorts.ports,
      readDirectories: [],
      capabilities: ["terminal"],
    });
    try {
      const result = await executor.executeDevelopmentCommand(process.execPath, [
        "-e",
        "console.log(process.versions.node)",
      ]);
      checks.push({
        id: "executor",
        ready: result.exitCode === 0,
        detail:
          result.exitCode === 0
            ? "隔离命令检查通过；构建命令关闭网络"
            : result.stderr.text.slice(0, 300),
      });
      const loopback = await executor.executeDevelopmentCommand(
        process.execPath,
        [
          "-e",
          "const s=require('net').createServer();s.on('error',()=>process.exit(1));s.listen(Number(process.env.LOCALAPP_TEST_BACKEND_PORT),'127.0.0.1',()=>s.close())",
        ],
      );
      checks.push({
        id: "localTests",
        ready: loopback.exitCode === 0,
        detail:
          loopback.exitCode === 0
            ? "隔离环境支持本地服务测试"
            : "当前隔离环境不允许本地服务测试，builtin 模板完整构建尚不可用",
      });
    } catch (e) {
      checks.push({ id: "executor", ready: false, detail: (e as Error).message });
    } finally {
      await executor.close();
    }
  } finally {
    testPorts.release();
  }
  return {
    ready: checks.every((c) => c.ready),
    nodeVersion: process.versions.node,
    dependenciesDirectory: dependencies ?? null,
    settings: readDevelopmentSettings(dataDir),
    checks,
  };
}
