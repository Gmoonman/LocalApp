import { it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createUserApplicationManagement } from "@localapp/dsh-app-platform/user-applications";

it("preserves account and local files if application object cleanup fails, then completes cleanup on retry", async () => {
  const dataDir = path.resolve(process.cwd(), "../../tmp/dsh-user-application-cleanup");
  const userDir = path.join(dataDir, "owner");
  await fs.mkdir(path.join(userDir, "app"), { recursive: true });
  await fs.writeFile(path.join(userDir, "app", "source.txt"), "existing source");
  const deleteAccount = vi.fn();
  const deleteAppObjects = vi.fn(async (): Promise<void> => { throw new Error("object storage unavailable"); });
  const management = createUserApplicationManagement({ dataDir, deleteAppObjects });
  try {
    await expect(management.deleteUserApplications("owner", deleteAccount)).rejects.toThrow("object storage unavailable");
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(userDir, "app", "source.txt"), "utf8")).toBe("existing source");
    deleteAppObjects.mockImplementation(async () => {});
    deleteAccount.mockImplementation(() => { expect(existsSync(userDir)).toBe(false); });
    await management.deleteUserApplications("owner", deleteAccount);
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(deleteAppObjects).toHaveBeenCalledWith("owner", "app");
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

