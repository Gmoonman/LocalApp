import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessTreeControllerOptions {
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>;
  processIdentity?: (pid: number) => Promise<string | null>;
  signalTree?: (pid: number, force: boolean) => Promise<void>;
  isAlive?: (pid: number) => boolean;
}

const execFileAsync = promisify(execFile);

export class ProcessTreeController {
  readonly platform: NodeJS.Platform;
  private readonly runCommandImpl: (command: string, args: string[]) => Promise<CommandResult>;

  constructor(private readonly options: ProcessTreeControllerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runCommandImpl = options.runCommand ?? runCommand;
  }

  async processIdentity(pid: number): Promise<string | null> {
    if (this.options.processIdentity) return this.options.processIdentity(pid);
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    try {
      if (this.platform === "win32") {
        const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction Stop; ConvertTo-Json @($p.CreationDate,$p.CommandLine) -Compress`;
        const result = await this.runCommandImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
        return result.code === 0 && result.stdout.trim() ? `win32:${result.stdout.trim()}` : null;
      }
      const result = await this.runCommandImpl("ps", ["-ww", "-o", "lstart=", "-o", "command=", "-p", String(pid)]);
      return result.code === 0 && result.stdout.trim() ? `posix:${result.stdout.trim()}` : null;
    } catch {
      return null;
    }
  }

  async signalTree(pid: number, force: boolean): Promise<void> {
    if (this.options.signalTree) return this.options.signalTree(pid, force);
    if (this.platform === "win32") {
      const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
      const result = await this.runCommandImpl("taskkill", args);
      if (force && result.code !== 0 && this.isAlive(pid)) throw new Error(`taskkill failed: ${result.stderr.trim()}`);
      return;
    }
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") throw fallbackError;
      }
    }
  }

  isAlive(pid: number): boolean {
    if (this.options.isAlive) return this.options.isAlive(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  async terminateAndWait(pid: number, graceMs = 1_000): Promise<void> {
    if (!this.isAlive(pid)) return;
    await this.signalTree(pid, false);
    if (await this.waitUntilGone(pid, graceMs)) return;
    await this.signalTree(pid, true);
    if (!await this.waitUntilGone(pid, graceMs)) throw new Error(`Process tree ${pid} did not exit`);
  }

  async waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !this.isAlive(pid);
  }
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}
