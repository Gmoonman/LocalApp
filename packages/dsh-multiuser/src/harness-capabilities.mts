import { resolveDeepSeekPlugin } from "./deepseek-plugin.mjs";
import { DOCUMENT_SKILLS_ROOT } from "@localapp/dsh-document-tools/catalog";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";
import fs from "node:fs";
import { preparePublicSkills } from "./public-skills.cjs";
import path from "node:path";
import { pythonReadDirectories, pythonShellEnvironment, type PythonEnvironment } from "./python-environment.cjs";
import { createRequire } from "node:module";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import type { AgentSettings, AgentCapability } from "./settings.cjs";
import * as FileSearch from "@deepseek-ai/dsh-tool-fs-search";
import * as PlanMode from "@deepseek-ai/dsh-plan-mode";
import * as Ralph from "@deepseek-ai/dsh-tool-ralph";
import * as McpResources from "@deepseek-ai/dsh-mcp-resources";
import * as AgentList from "@deepseek-ai/dsh-tool-subagent-control/list-agents";
import * as p0 from "@deepseek-ai/dsh-sandbox-policy";
import * as p1 from "@deepseek-ai/dsh-user-approval";
import * as p2 from "@deepseek-ai/dsh-user-questions";
import * as p3 from "@deepseek-ai/dsh-subprocess-local";
import * as p4 from "@deepseek-ai/dsh-shell-env";
import * as p5 from "@deepseek-ai/dsh-sandbox-local";
import * as p6 from "@deepseek-ai/dsh-bash-sandbox";
import * as p7 from "@deepseek-ai/dsh-jobs-local";
import * as p8 from "@deepseek-ai/dsh-tool-bash";
import * as p9 from "@deepseek-ai/dsh-tool-jobs";
import * as p10 from "@deepseek-ai/dsh-tool-fs";
import * as p11 from "@deepseek-ai/dsh-skill";
import * as p12 from "@deepseek-ai/dsh-skill-filesystem";
import * as p13 from "@deepseek-ai/dsh-tool-skill";
import * as p14 from "@deepseek-ai/dsh-subagent";
import * as p15 from "@deepseek-ai/dsh-subagent-spawn-in-process";
import * as p16 from "@deepseek-ai/dsh-subagent-fork-in-process";
import * as p17 from "@deepseek-ai/dsh-tool-subagent";
import * as p18 from "@deepseek-ai/dsh-tool-subagent-control";
import * as p19 from "@deepseek-ai/dsh-tool-todo";
import * as p20 from "@deepseek-ai/dsh-goal";
import * as p21 from "@deepseek-ai/dsh-goal-round-driver";
import * as p22 from "@deepseek-ai/dsh-tool-goal";
import * as p23 from "@deepseek-ai/dsh-commands";
import * as p24 from "@deepseek-ai/dsh-compaction-basic";
import * as p25 from "@deepseek-ai/dsh-command-compact";
import * as p26 from "@deepseek-ai/dsh-token-meter";
import * as p27 from "@deepseek-ai/dsh-storage";
import * as p28 from "@deepseek-ai/dsh-storage-json";
import * as p29 from "@deepseek-ai/dsh-storage-domain";
import SessionProjectionCache from "@deepseek-ai/dsh-session-projection-cache";
import * as p30 from "@deepseek-ai/dsh-tool-web";
import * as p31 from "@deepseek-ai/dsh-web";
import * as p32 from "@deepseek-ai/dsh-web-fetch-http";
import * as p33 from "@deepseek-ai/dsh-tool-call-timeout-policy";
import * as p34 from "@deepseek-ai/dsh-tool-workflow";
import * as p35 from "@deepseek-ai/dsh-workflow-ptc";
import * as p36 from "@deepseek-ai/dsh-ptc-runtime-node";
import * as p37 from "@deepseek-ai/dsh-tool-ask-user";
import * as p38 from "@deepseek-ai/dsh-mcp-client";
import * as p39 from "@deepseek-ai/dsh-schedule";
import * as p40 from "@deepseek-ai/dsh-tool-schedule";
const plugins: Record<string, unknown> = {
  "sandbox-policy": p0,
  "user-approval": p1,
  "user-questions": p2,
  "subprocess-local": p3,
  "shell-env": p4,
  "sandbox-local": p5,
  "bash-sandbox": p6,
  "jobs-local": p7,
  "tool-bash": p8,
  "tool-jobs": p9,
  "tool-fs": p10,
  "skill": p11,
  "skill-filesystem": p12,
  "tool-skill": p13,
  "subagent": p14,
  "subagent-spawn-in-process": p15,
  "subagent-fork-in-process": p16,
  "tool-subagent": p17,
  "tool-subagent-control": p18,
  "tool-todo": p19,
  "goal": p20,
  "goal-round-driver": p21,
  "tool-goal": p22,
  "commands": p23,
  "compaction-basic": p24,
  "command-compact": p25,
  "token-meter": p26,
  "storage": p27,
  "storage-json": p28,
  "storage-domain": p29,
  "tool-web": p30,
  "web": p31,
  "web-fetch-http": p32,
  "tool-call-timeout-policy": p33,
  "tool-workflow": p34,
  "workflow-ptc": p35,
  "ptc-runtime-node": p36,
  "tool-ask-user": p37,
  "mcp-client": p38,
  "schedule": p39,
  "tool-schedule": p40,
};

/** Reject filesystem paths outside this user's application workspace, including symlink targets. */
class ApplicationFileSystem extends SandboxedFileSystem {
  async resolve(...args: Parameters<SandboxedFileSystem["resolve"]>) {
    const target = await super.resolve(...args);
    const root = await super.resolve(this.config.cwd);
    if (!this.contains(root, target)) throw new Error("Path is outside this application's Agent workspace");
    return target;
  }
  async lstat(...args: Parameters<SandboxedFileSystem["lstat"]>) {
    await this.resolve(args[0], args[1]);
    return super.lstat(...args);
  }
}

/** Add read isolation to dsh's write confinement. No weaker runner fallback. */
class ApplicationSandbox extends LocalSandboxProvider {
  dataRoot?: string;
  pythonDirectories: string[] = [];
  networkBlocked = false;
  localTestPorts: number[] = [];
  async confine(...args: Parameters<LocalSandboxProvider["confine"]>) {
    const result = await super.confine(...args);
    const workspace = fs.realpathSync(args[1].workspaceRoot);
    const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
    // Only runtime packages and the Node installation supplement the system paths.
    const packageEntry = require.resolve("@deepseek-ai/dsh-ptc-runtime-node");
    const runtimePackages = packageEntry.slice(0, packageEntry.indexOf("/node_modules/") + "/node_modules".length);
    const roots = ["/bin", "/sbin", "/usr", "/lib", "/lib64", "/etc", "/dev", "/proc", "/System", "/Library", "/private/var/select", "/opt", ...this.pythonDirectories, workspace, runtimePackages, path.dirname(path.dirname(fs.realpathSync(process.execPath)))].filter((root) => fs.existsSync(root));
    const profile = result.argv.indexOf("-p");
    if (profile !== -1 && process.platform === "darwin") {
      if (this.networkBlocked) result.argv[profile + 1] += " (deny network*)";
      for (const port of this.localTestPorts) {
        if (!this.networkBlocked || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid isolated test port");
        result.argv[profile + 1] += ` (allow network-bind (local ip "localhost:${port}")) (allow network-inbound (local ip "localhost:${port}")) (allow network-outbound (remote ip "localhost:${port}"))`;
      }
      const quote = (value: string) => JSON.stringify(value);
      const ancestors = new Set<string>();
      for (const root of roots.flatMap((root) => [root, fs.realpathSync(root)])) {
        for (let directory = path.dirname(root); directory !== path.dirname(directory); directory = path.dirname(directory)) ancestors.add(directory);
      }
      result.argv[profile + 1] += ` (deny file-read*) (allow file-read* ${[...new Set(roots.flatMap((root) => [root, fs.realpathSync(root)]))].map((root) => `(subpath ${quote(root)})`).join(" ")} (literal "/") (literal "/private") (literal "/private/var") (literal "/private/var/db") (subpath "/private/var/db/dyld")) (allow file-read-metadata ${[...ancestors].map((directory) => `(literal ${quote(directory)})`).join(" ")})`;
      if (this.dataRoot) result.argv[profile + 1] += ` (deny file-read-data (require-all (subpath ${quote(fs.realpathSync(this.dataRoot))}) (require-not (subpath ${quote(workspace)})) ${this.pythonDirectories.map(root => `(require-not (subpath ${quote(root)}))`).join(" ")}))`;
      return result;
    }
    if (process.platform === "linux" && path.basename(result.argv[0]) === "bwrap") {
      result.argv = [result.argv[0], "--die-with-parent", "--unshare-pid", ...(this.networkBlocked ? ["--unshare-net"] : []), "--dev", "/dev", "--proc", "/proc", ...roots.filter((root) => !["/dev", "/proc", workspace].includes(root)).flatMap((root) => ["--ro-bind", root, root]), ...(this.dataRoot ? ["--tmpfs", this.dataRoot, ...this.pythonDirectories.filter(root => root.startsWith(this.dataRoot! + path.sep)).flatMap(root => ["--ro-bind", root, root])] : []), "--bind", workspace, workspace, "--chdir", workspace, "--", ...args[0]];
      return result;
    }
    if (process.platform === "linux" && path.basename(result.argv[0]) === "landlock-run") {
      if (this.networkBlocked) throw new Error("开发命令需要支持网络隔离的执行器；请配置 bubblewrap");
      // Landlock grants cannot exclude a child of a readable directory. Split
      // only the branch containing Server data, then allow this workspace.
      const protectedRoot = this.dataRoot && fs.realpathSync(this.dataRoot);
      const readable = (directory: string): string[] => {
        let resolved: string;
        try { resolved = fs.realpathSync(directory); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
        if (this.pythonDirectories.includes(resolved)) return [directory];
        if (!protectedRoot || !protectedRoot.startsWith(`${resolved}${path.sep}`)) {
          return protectedRoot && (resolved === protectedRoot || resolved.startsWith(`${protectedRoot}${path.sep}`)) ? [] : [directory];
        }
        if (fs.lstatSync(directory).isSymbolicLink()) return [];
        return fs.readdirSync(directory).flatMap((entry) => readable(path.join(directory, entry)));
      };
      // A shared /proc exposes other Server processes' environment. The
      // launcher resolves these self paths after spawning, for its own PID.
      const processFiles = ["/proc/self", "/proc/thread-self", "/proc/cpuinfo", "/proc/meminfo", "/proc/version"].filter((file) => fs.existsSync(file));
      const allowed = [...new Set([...roots.filter((directory) => directory !== workspace && directory !== "/proc").flatMap(readable), ...processFiles])];
      result.argv = [result.argv[0], ...allowed.flatMap((directory) => ["--ro", directory]), "--rw", "/dev/null", "--rw", workspace, "--", ...args[0]];
      return result;
    }
    throw new Error("This Server has no runner that isolates application file reads; terminal and workflow execution are unavailable");
  }
}
export async function mountHarnessCapabilities(ctx: Context, root: string, capabilities: AgentCapability[], mcpServers: AgentSettings["mcpServers"], skills: string[] = [], pythonEnvironment?: PythonEnvironment, development?: { workspaceRoot?: string; dataRoot?: string; networkBlocked?: boolean; localTestPorts?: number[]; readDirectories?: string[]; publicSkillsRoot?: string }) {
  const workspace = development?.workspaceRoot ?? path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const mount = async (name: string, config: unknown = {}) => {
    const namespace = plugins[name] as { default?: Plugin };
    await ctx.plugin(resolveDeepSeekPlugin(namespace), config);
  };
  await mount("user-approval", { policy: "ask" });
  await mount("user-questions");
  await mount("tool-ask-user");
  await ctx.plugin(resolveDeepSeekPlugin(PlanMode.default), { section: "处于计划模式。先阅读和说明实现步骤，不修改文件或应用数据。准备执行时使用退出计划模式工具，让用户确认方案。" });
  await mount("commands");
  await mount("token-meter");
  await mount("compaction-basic");
  await mount("command-compact");
  await mount("tool-todo", { allowParallelInProgress: true });
  await mount("goal");
  await mount("goal-round-driver");
  await mount("tool-goal");
  await mount("tool-call-timeout-policy");
  await mount("storage");
  await mount("storage-json", { root: path.join(root, "storage") });
  await mount("storage-domain", { backend: "json" });
  await ctx.plugin(resolveDeepSeekPlugin(SessionProjectionCache), { writeEveryEvents: 64, writeIntervalMs: 1000 });
  ctx.tools.guard((execution) => (execution.arguments as Record<string, unknown> | undefined)?.sandbox_permissions === "danger-full-access" ? "LocalApp does not allow leaving the application workspace" : undefined);
  await mount("sandbox-policy", { mode: "workspace-write", workspaceRoot: workspace });
  if (capabilities.some((c) => ["files", "skills", "terminal", "workflow", "subagents"].includes(c))) await ctx.plugin(resolveDeepSeekPlugin(ApplicationFileSystem), { cwd: workspace });
  if (capabilities.some(capability => ["files", "terminal", "skills", "workflow", "subagents"].includes(capability))) await ctx.plugin(resolveDeepSeekPlugin(WorkingDirectory), { defaultDirectory: workspace });
  if (capabilities.includes("files")) await mount("tool-fs");
  if (capabilities.some((c) => ["files", "terminal", "workflow"].includes(c)) || capabilities.includes("mcp") && mcpServers.some((s) => s.transport === "stdio")) {
    await mount("subprocess-local");
    await ctx.plugin(resolveDeepSeekPlugin(ApplicationSandbox));
    (ctx.sandbox as ApplicationSandbox).dataRoot = development?.dataRoot ?? path.dirname(path.dirname(root));
    (ctx.sandbox as ApplicationSandbox).networkBlocked = development?.networkBlocked ?? false;
    (ctx.sandbox as ApplicationSandbox).localTestPorts = development?.localTestPorts ?? [];
    (ctx.sandbox as ApplicationSandbox).pythonDirectories = [...(development?.readDirectories ?? []), ...(pythonEnvironment ? pythonReadDirectories(pythonEnvironment) : [])];
    await mount("shell-env");
    await mount("bash-sandbox", { timeoutMs: 60_000 });
    if (development?.workspaceRoot) {
      const temporary = path.join(workspace, ".tmp"); fs.mkdirSync(temporary, { recursive: true });
      const environment = { HOME: workspace, TMPDIR: temporary, TMP: temporary, TEMP: temporary, npm_config_cache: path.join(workspace, ".npm"), NODE_OPTIONS: "--max-old-space-size=512" };
      const spawn = ctx.subprocess.spawn.bind(ctx.subprocess);
      ctx.subprocess.spawn = input => spawn({ ...input, env: { ...input.env, ...environment } });
      const resolve = ctx.shell.resolve.bind(ctx.shell);
      ctx.shell.resolve = request => resolve({ ...request, env: { ...request.env, ...environment } });
    }
    if (pythonEnvironment) {
      const spawn = ctx.subprocess.spawn.bind(ctx.subprocess);
      ctx.subprocess.spawn = input => spawn({ ...input, env: { ...input.env, ...pythonShellEnvironment(pythonEnvironment) } });
      const resolve = ctx.shell.resolve.bind(ctx.shell);
      ctx.shell.resolve = request => resolve({ ...request, env: { ...request.env, ...pythonShellEnvironment(pythonEnvironment) } });
      ctx.systemPrompt.section({ name: "localapp-python", order: 0, text: `系统已配置共享 Python 虚拟环境。Python 命令使用 ${pythonEnvironment.executable}；环境依赖由管理员维护，只能读取。脚本在当前应用工作区中运行。` });
    }
  }
  if (capabilities.includes("files")) {
    const subprocess = ctx.subprocess;
    try {
      const confined = await ctx.sandbox.confine([process.execPath], { mode: "workspace-write", workspaceRoot: workspace });
      const prefix = confined.argv.slice(0, -1);
      const searchContext = ctx.isolate("subprocess");
      searchContext.provide("subprocess", new Proxy(subprocess, { get(target, property) {
        if (property === "spawn") return (input: Parameters<typeof subprocess.spawn>[0]) => target.spawn({ ...input, argv: [...prefix, ...input.argv], cwd: workspace });
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } }));
      await searchContext.plugin(FileSearch, { sampleOverCapGlobResults: false });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("no runner that isolates application file reads")) throw error;
      ctx.systemPrompt.section({ name: "localapp-search-availability", order: 0, text: "文件搜索工具不可用：此 Server 无法隔离搜索进程的文件读取。可以继续使用 read、write 和 edit 文件工具。" });
    }
  }
  if (capabilities.includes("jobs")) {
    await mount("jobs-local", { maxConcurrentJobsPerOwner: 5 });
    await mount("tool-jobs");
  }
  if (capabilities.includes("terminal")) await mount("tool-bash", { enableRunInBackground: capabilities.includes("jobs"), promoteOnTimeout: capabilities.includes("jobs") });
  const publicSkillsDirectory = preparePublicSkills(workspace, capabilities.includes("skills") ? skills : [], development?.publicSkillsRoot ?? process.env.LOCALAPP_PUBLIC_SKILLS_ROOT ?? DOCUMENT_SKILLS_ROOT);
  if (capabilities.includes("skills")) {
    await mount("skill");
    await mount("skill-filesystem", { includeDefaultRoots: false, customSkillDirs: [publicSkillsDirectory, path.join(workspace, "skills"), ...(development?.workspaceRoot ? [path.join(workspace, ".claude", "skills")] : [])], watch: false });
    await mount("tool-skill");
  }
  if (capabilities.includes("subagents") || capabilities.includes("workflow")) {
    await mount("subagent");
    await mount("subagent-spawn-in-process", { providerName: "spawn" });
    await mount("subagent-fork-in-process", { providerName: "fork" });
  }
  if (capabilities.includes("subagents")) {
    await mount("tool-subagent", { provider: "spawn", toolName: "subagent", enableRunInBackground: capabilities.includes("jobs"), backgroundMode: capabilities.includes("jobs") ? "continuable" : "one-shot" });
    await mount("tool-subagent", { provider: "fork", toolName: "subagent_fork", enableRunInBackground: capabilities.includes("jobs"), backgroundMode: "one-shot" });
    await mount("tool-subagent-control");
    await ctx.plugin(resolveDeepSeekPlugin(AgentList));
    await ctx.plugin(resolveDeepSeekPlugin(Ralph), { subagentProvider: "spawn", maxRounds: 64 });
  }
  if (capabilities.includes("workflow")) {
    await mount("ptc-runtime-node");
    await mount("workflow-ptc", { provider: "spawn" });
    await mount("tool-workflow", { enableRunInBackground: capabilities.includes("jobs") });
  }
  if (capabilities.includes("web")) {
    await mount("web", { fetchProvider: "http" });
    await mount("web-fetch-http");
    await mount("tool-web", { fetch: true });
  }
  if (capabilities.includes("mcp")) {
    await ctx.plugin(resolveDeepSeekPlugin(McpResources.default));
    for (const server of mcpServers) {
      if (server.transport === "stdio") {
        const confined = await ctx.sandbox.confine([server.command!, ...(server.args ?? [])], { mode: "workspace-write", workspaceRoot: workspace });
        await mount("mcp-client", { serverName: server.serverName, transport: "stdio", command: confined.argv[0], args: confined.argv.slice(1), cwd: workspace, env: { HOME: workspace, npm_config_cache: path.join(workspace, ".npm"), ...server.env }, toolCallTimeoutMs: 60_000, failOnStartupError: true });
      } else await mount("mcp-client", { ...server, transport: "streamable-http", toolCallTimeoutMs: 60_000, failOnStartupError: true });
    }
  }
  if (capabilities.includes("schedule")) {
    await mount("schedule");
    await mount("tool-schedule");
  }
  return workspace;
}

export async function mountApplicationFileSystem(ctx: Context, cwd: string): Promise<void> {
  await ctx.plugin(resolveDeepSeekPlugin(ApplicationFileSystem), { cwd });
}
