import fs from "node:fs/promises";
import path from "node:path";

/** Translate a sandbox PID using a unique process title visible in host /proc. */
export async function hostProcessId(pid: number, title: string, platform = process.platform, procRoot = "/proc"): Promise<number> {
  if (platform !== "linux") return pid;
  const matches: number[] = [];
  for (const entry of await fs.readdir(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = await fs.readFile(path.join(procRoot, entry, "cmdline"), "utf8");
      if (command.split("\0")[0] === title) matches.push(Number(entry));
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  if (matches.length !== 1) throw new Error(`Expected one host process for ${title}, found ${matches.length}`);
  return matches[0];
}
