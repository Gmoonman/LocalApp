import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ejectManagedTemplate } from "../src/commands/eject-template.js";
import { initializeProject } from "../src/commands/init.js";
import { syncManagedTemplate } from "../src/commands/sync-template.js";
import { stageBuiltinTemplate } from "../src/template/stage.js";

const repositoryRoot = path.resolve(process.cwd(), "../..");
const testRoot = path.join(repositoryRoot, "tmp/task-3-template-zone-tests");
const version = "0.1.0-test";
let directory = "";
let project = "";
let templateDirectory = "";

beforeEach(async () => {
  await fs.mkdir(testRoot, { recursive: true });
  directory = await fs.mkdtemp(path.join(testRoot, "case-"));
  templateDirectory = path.join(directory, "packed-template");
  await stageBuiltinTemplate({ repositoryRoot, outputDirectory: templateDirectory, version });
  vi.stubEnv("LOCALAPP_TEMPLATE_DIR", templateDirectory);
  project = (await initializeProject({
    cwd: directory,
    name: "fresh-app",
    skipInstall: true,
    skipDeploy: true,
    io: { stdout: () => undefined, stderr: () => undefined },
  })).projectDir;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

describe("managed template zones", () => {
  it("ships plugin-backed server-core without a private registry dependency", async () => {
    const runtime = path.join(project, ".localapp/runtime/server-core");
    const manifest = JSON.parse(await fs.readFile(path.join(runtime, "package.json"), "utf8"));
    expect(manifest.dependencies).not.toHaveProperty("@localapp/dsh-app-platform");
    expect(await fs.readFile(path.join(runtime, "dist/lib/app-db.js"), "utf8")).toContain("../platform/app-db.cjs");
    expect(await fs.readFile(path.join(runtime, "dist/platform/app-db.cjs"), "utf8")).toContain("exports.getConnection");
    expect(await fs.readFile(path.join(runtime, "dist/lib/app-db.d.ts"), "utf8")).toContain("../platform/app-db.cjs");
    await fs.mkdir(path.join(runtime, "node_modules"));
    await fs.symlink(path.join(repositoryRoot, "packages/app-foundation/node_modules/sql.js"), path.join(runtime, "node_modules/sql.js"), "junction");
    const runtimeRequire = createRequire(path.join(runtime, "package.json"));
    const database = runtimeRequire("./dist/lib/app-db.js");
    expect(database.getConnection).toBeTypeOf("function");
  });

  it("sync replaces managed files without changing user source", async () => {
    // Break caught: copying the full template during sync overwrites application source or custom skills.
    await fs.writeFile(path.join(project, "src/App.tsx"), "user-owned\n");
    await fs.writeFile(path.join(project, ".localapp/runtime/version.json"), '{"cliVersion":"stale"}\n');
    await fs.writeFile(path.join(project, ".claude/skills/localapp/SKILL.md"), "stale managed skill\n");
    await fs.mkdir(path.join(project, ".claude/skills/custom-user"), { recursive: true });
    await fs.writeFile(path.join(project, ".claude/skills/custom-user/SKILL.md"), "user-owned skill\n");

    const result = await syncManagedTemplate(project, { quiet: true });

    expect(result.updated).toBe(true);
    expect(await fs.readFile(path.join(project, "src/App.tsx"), "utf8")).toBe("user-owned\n");
    expect(await fs.readFile(path.join(project, ".claude/skills/custom-user/SKILL.md"), "utf8")).toBe("user-owned skill\n");
    expect(await fs.readFile(path.join(project, ".claude/skills/localapp/SKILL.md"), "utf8")).not.toBe("stale managed skill\n");
    expect(JSON.parse(await fs.readFile(path.join(project, ".localapp/runtime/version.json"), "utf8"))).toEqual({ cliVersion: version });
  });

  it.runIf(process.platform !== "win32")("refuses a symlinked .localapp without changing its external target", async () => {
    // Break caught: resolving .localapp through a symlink lets sync delete files outside the project.
    const externalLocalApp = path.join(directory, "external-localapp");
    await fs.rename(path.join(project, ".localapp"), externalLocalApp);
    await fs.writeFile(path.join(externalLocalApp, "runtime/version.json"), "external-runtime\n");
    await fs.symlink(externalLocalApp, path.join(project, ".localapp"), "dir");

    await expect(syncManagedTemplate(project, { quiet: true })).rejects.toMatchObject({ code: "unsafe_project_path" });

    expect(await fs.readFile(path.join(externalLocalApp, "runtime/version.json"), "utf8")).toBe("external-runtime\n");
  });

  it.runIf(process.platform !== "win32")("refuses a symlinked runtime and manifest before mutation", async () => {
    // Break caught: validating only .localapp itself still allows runtime or identity files to resolve outside the project.
    const externalRuntime = path.join(directory, "external-runtime");
    await fs.rename(path.join(project, ".localapp/runtime"), externalRuntime);
    await fs.writeFile(path.join(externalRuntime, "version.json"), "external runtime\n");
    await fs.symlink(externalRuntime, path.join(project, ".localapp/runtime"), "dir");

    await expect(syncManagedTemplate(project, { quiet: true })).rejects.toMatchObject({ code: "unsafe_project_path" });
    expect(await fs.readFile(path.join(externalRuntime, "version.json"), "utf8")).toBe("external runtime\n");

    await fs.rm(path.join(project, ".localapp/runtime"));
    await fs.rename(externalRuntime, path.join(project, ".localapp/runtime"));
    const externalManifest = path.join(directory, "external-manifest.json");
    await fs.rename(path.join(project, "manifest.json"), externalManifest);
    await fs.symlink(externalManifest, path.join(project, "manifest.json"), "file");

    await expect(syncManagedTemplate(project, { quiet: true })).rejects.toMatchObject({ code: "unsafe_project_path" });
    expect(await fs.readFile(externalManifest, "utf8")).toContain('"name": "fresh-app"');
  });

  it.runIf(process.platform !== "win32")("refuses symlinked skill parents and managed targets without changing external files", async () => {
    // Break caught: walking or copying through .claude/skills or a managed target can overwrite an external directory.
    const skills = path.join(project, ".claude/skills");
    const externalSkills = path.join(directory, "external-skills");
    await fs.rename(skills, externalSkills);
    await fs.writeFile(path.join(externalSkills, "localapp/SKILL.md"), "external skill parent\n");
    await fs.symlink(externalSkills, skills, "dir");

    await expect(syncManagedTemplate(project, { quiet: true })).rejects.toMatchObject({ code: "unsafe_project_path" });
    expect(await fs.readFile(path.join(externalSkills, "localapp/SKILL.md"), "utf8")).toBe("external skill parent\n");

    await fs.rm(skills);
    await fs.rename(externalSkills, skills);
    const externalManagedSkill = path.join(directory, "external-managed-skill");
    await fs.rename(path.join(skills, "localapp"), externalManagedSkill);
    await fs.writeFile(path.join(externalManagedSkill, "SKILL.md"), "external managed target\n");
    await fs.symlink(externalManagedSkill, path.join(skills, "localapp"), "dir");

    await expect(syncManagedTemplate(project, { quiet: true })).rejects.toMatchObject({ code: "unsafe_project_path" });
    expect(await fs.readFile(path.join(externalManagedSkill, "SKILL.md"), "utf8")).toBe("external managed target\n");
  });

  it.runIf(process.platform !== "win32")("refuses a symlinked managed skill in the staged template", async () => {
    // Break caught: silently skipping an unsafe staged skill removes the project's current managed skill during sync.
    const stagedSkill = path.join(templateDirectory, ".claude/skills/localapp");
    const externalSkill = path.join(directory, "external-template-skill");
    await fs.rename(stagedSkill, externalSkill);
    await fs.symlink(externalSkill, stagedSkill, "dir");
    const currentSkill = await fs.readFile(path.join(project, ".claude/skills/localapp/SKILL.md"), "utf8");

    await expect(syncManagedTemplate(project, { quiet: true })).rejects.toMatchObject({ code: "template_sync_failed" });

    expect(await fs.readFile(path.join(project, ".claude/skills/localapp/SKILL.md"), "utf8")).toBe(currentSkill);
  });

  it("validates a real LocalApp project before mutating decoy managed paths", async () => {
    // Break caught: sync in an arbitrary cwd deletes a coincidental .localapp/runtime directory before proving project identity.
    const arbitraryDirectory = path.join(directory, "arbitrary-directory");
    await fs.mkdir(path.join(arbitraryDirectory, ".localapp/runtime"), { recursive: true });
    await fs.writeFile(path.join(arbitraryDirectory, ".localapp/runtime/sentinel.txt"), "keep me\n");

    await expect(syncManagedTemplate(arbitraryDirectory, { quiet: true })).rejects.toMatchObject({ code: "not_localapp_project" });

    expect(await fs.readFile(path.join(arbitraryDirectory, ".localapp/runtime/sentinel.txt"), "utf8")).toBe("keep me\n");
  });

  it("rolls back the complete managed zone when an atomic swap rename fails", async () => {
    // Break caught: a failed multi-target refresh leaves the new runtime paired with stale or missing managed skills.
    await fs.writeFile(path.join(project, ".localapp/runtime/version.json"), '{"cliVersion":"old-runtime"}\n');
    await fs.writeFile(path.join(project, ".claude/skills/localapp/SKILL.md"), "old managed skill\n");
    let moves = 0;

    await expect(syncManagedTemplate(project, { quiet: true }, {
      beforeRename: async () => {
        moves += 1;
        if (moves === 3) throw new Error("simulated rename interruption");
      },
    })).rejects.toMatchObject({ code: "template_sync_failed" });

    expect(await fs.readFile(path.join(project, ".localapp/runtime/version.json"), "utf8")).toBe('{"cliVersion":"old-runtime"}\n');
    expect(await fs.readFile(path.join(project, ".claude/skills/localapp/SKILL.md"), "utf8")).toBe("old managed skill\n");
  });

  it.runIf(process.platform !== "win32")("refuses replacement of .localapp immediately before a sync rename", async () => {
    // Break caught: replacing a validated mutation parent after preflight redirects the rename into an external tree.
    const heldLocalApp = path.join(directory, "held-localapp");
    const externalLocalApp = path.join(directory, "external-race-localapp");
    await fs.mkdir(externalLocalApp);
    await fs.writeFile(path.join(externalLocalApp, "sentinel.txt"), "external sentinel\n");
    let replaced = false;

    await expect(syncManagedTemplate(project, { quiet: true }, {
      beforeRename: async () => {
        if (replaced) return;
        replaced = true;
        await fs.rename(path.join(project, ".localapp"), heldLocalApp);
        await fs.symlink(externalLocalApp, path.join(project, ".localapp"), "dir");
      },
    })).rejects.toMatchObject({ code: "unsafe_project_path" });

    expect(await fs.readFile(path.join(externalLocalApp, "sentinel.txt"), "utf8")).toBe("external sentinel\n");
    expect((await fs.readdir(externalLocalApp)).sort()).toEqual(["sentinel.txt"]);
    await fs.rm(path.join(project, ".localapp"));
    await fs.rename(heldLocalApp, path.join(project, ".localapp"));
  });

  it.runIf(process.platform !== "win32")("refuses replacement of .claude immediately before a managed-skill rename", async () => {
    // Break caught: replacing .claude after preflight lets a later managed-skill rename target an external skills parent.
    const heldClaude = path.join(directory, "held-claude");
    const externalClaude = path.join(directory, "external-race-claude");
    await fs.mkdir(path.join(externalClaude, "skills"), { recursive: true });
    await fs.writeFile(path.join(externalClaude, "sentinel.txt"), "external sentinel\n");
    let replaced = false;

    await expect(syncManagedTemplate(project, { quiet: true }, {
      beforeRename: async (source) => {
        if (replaced || !source.includes(`${path.sep}.claude${path.sep}`)) return;
        replaced = true;
        await fs.rename(path.join(project, ".claude"), heldClaude);
        await fs.symlink(externalClaude, path.join(project, ".claude"), "dir");
      },
    })).rejects.toMatchObject({ code: "unsafe_project_path" });

    expect(await fs.readFile(path.join(externalClaude, "sentinel.txt"), "utf8")).toBe("external sentinel\n");
    expect(await fs.readdir(path.join(externalClaude, "skills"))).toEqual([]);
    await fs.rm(path.join(project, ".claude"));
    await fs.rename(heldClaude, path.join(project, ".claude"));
  });

  it.runIf(process.platform !== "win32").each([".sync-stage-", ".sync-backup-"])(
    "refuses replacement of .localapp immediately before creating a %s recovery root",
    async (prefix) => {
      // Break caught: checking .localapp before mkdtemp still lets a raced symlink redirect recovery-root creation outside the project.
      const race = await localAppReplacementRace(`recovery-${prefix}`);

      await expect(syncManagedTemplate(project, { quiet: true }, {
        beforeCreate: async (target, kind) => {
          if (race.replaced() || kind !== "temporary-directory" || !path.basename(target).startsWith(prefix)) return;
          await race.replace();
        },
      })).rejects.toMatchObject({ code: "unsafe_project_path" });

      await race.expectExternalUntouched();
      await race.restore();
    },
  );

  it.runIf(process.platform !== "win32")("refuses replacement of .localapp immediately before the first staged mutation", async () => {
    // Break caught: safe recovery-root creation is insufficient if later staged mkdir/copy operations do not revalidate its ancestor chain.
    const race = await localAppReplacementRace("staged-mutation");

    await expect(syncManagedTemplate(project, { quiet: true }, {
      beforeCreate: async (target, kind) => {
        if (race.replaced() || kind === "temporary-directory" || !target.includes(`${path.sep}.sync-stage-`)) return;
        await race.replace();
      },
    })).rejects.toMatchObject({ code: "unsafe_project_path" });

    await race.expectExternalUntouched();
    await race.restore();
  });

  it.runIf(process.platform !== "win32")("refuses replacement of .localapp immediately before a staged file copy", async () => {
    // Break caught: guarding staged directory creation alone still lets a later file copy follow a replaced .localapp ancestor.
    const race = await localAppReplacementRace("staged-file-copy");
    let fileHookFired = false;

    await expect(syncManagedTemplate(project, { quiet: true }, {
      beforeCreate: async (target, kind) => {
        if (fileHookFired || kind !== "file" || !target.includes(`${path.sep}.sync-stage-`)) return;
        fileHookFired = true;
        await race.replace();
      },
    })).rejects.toMatchObject({ code: "unsafe_project_path" });

    expect(fileHookFired).toBe(true);
    await race.expectExternalUntouched();
    await race.restore();
  });

  it.runIf(process.platform !== "win32")("refuses replacement of .localapp immediately before creating backup skills", async () => {
    // Break caught: a raw mkdir for the backup subdirectory can be redirected through a replaced recovery-root ancestor.
    const race = await localAppReplacementRace("backup-skills");

    await expect(syncManagedTemplate(project, { quiet: true }, {
      beforeCreate: async (target, kind) => {
        if (race.replaced() || kind !== "directory" || path.basename(target) !== "skills"
          || !path.dirname(target).includes(`${path.sep}.sync-backup-`)) return;
        await race.replace();
      },
    })).rejects.toMatchObject({ code: "unsafe_project_path" });

    await race.expectExternalUntouched();
    await race.restore();
  });

  it("preserves stage and backup recovery data when sync rollback fails", async () => {
    // Break caught: cleanup after failed rollback deletes the only copy of the old managed runtime.
    await fs.writeFile(path.join(project, ".localapp/runtime/version.json"), '{"cliVersion":"old-runtime"}\n');
    const externalSentinel = path.join(directory, "outside-sentinel.txt");
    await fs.writeFile(externalSentinel, "outside\n");
    let guardedMoves = 0;

    const failure = syncManagedTemplate(project, { quiet: true }, {
      beforeRename: async () => {
        guardedMoves += 1;
        if (guardedMoves === 3 || guardedMoves === 5) throw new Error("simulated rename failure");
      },
    });

    await expect(failure).rejects.toMatchObject({ code: "template_sync_recovery_required" });
    const localAppEntries = await fs.readdir(path.join(project, ".localapp"));
    const backupName = localAppEntries.find((name) => name.startsWith(".sync-backup-"));
    const stageName = localAppEntries.find((name) => name.startsWith(".sync-stage-"));
    expect(backupName).toBeDefined();
    expect(stageName).toBeDefined();
    expect(await fs.readFile(path.join(project, ".localapp", backupName!, "runtime/version.json"), "utf8")).toBe('{"cliVersion":"old-runtime"}\n');
    expect(await fs.readFile(externalSentinel, "utf8")).toBe("outside\n");
  });

  it("does not roll back a committed sync when best-effort cleanup fails", async () => {
    // Break caught: cleanup inside the transaction catch restores old files after the new managed zone was fully installed.
    await fs.writeFile(path.join(project, ".localapp/runtime/version.json"), '{"cliVersion":"old-runtime"}\n');

    const result = await syncManagedTemplate(project, { quiet: true }, {
      beforeRemove: async () => { throw new Error("simulated cleanup failure"); },
    });

    expect(result).toEqual({ updated: true, version });
    expect(JSON.parse(await fs.readFile(path.join(project, ".localapp/runtime/version.json"), "utf8"))).toEqual({ cliVersion: version });
    expect((await fs.readdir(path.join(project, ".localapp"))).some((name) => name.startsWith(".sync-backup-"))).toBe(true);
  });

  it("eject copies managed files into user ownership and permanently refuses later sync", async () => {
    // Break caught: ejecting without a durable marker lets a later automatic sync overwrite the newly user-owned runtime.
    const result = await ejectManagedTemplate(project);

    expect(result.ejected).toBe(true);
    expect(await exists(path.join(project, "src/_localapp_runtime/server-core/dist/index.js"))).toBe(true);
    expect(await exists(path.join(project, ".claude/skills/custom-localapp/SKILL.md"))).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(project, ".localapp/project-config.json"), "utf8"))).toMatchObject({ ejected: true });
    await expect(syncManagedTemplate(project, { quiet: true })).rejects.toThrow("ejected");
  });

  it("persists an eject transaction before moves and resumes after a mid-transaction failure", async () => {
    // Break caught: interruption after moving runtime but before skills/package config leaves eject unable to retry safely.
    let moves = 0;
    await expect(ejectManagedTemplate(project, {
      beforeRename: async () => {
        moves += 1;
        if (moves === 2) throw new Error("simulated eject interruption");
      },
    })).rejects.toMatchObject({ code: "template_eject_failed" });

    expect(JSON.parse(await fs.readFile(path.join(project, ".localapp/project-config.json"), "utf8"))).toMatchObject({
      templateState: "ejecting",
    });
    await expect(syncManagedTemplate(project, { quiet: true })).rejects.toMatchObject({ code: "template_ejecting" });

    const result = await ejectManagedTemplate(project);

    expect(result).toEqual({ ejected: true });
    expect(await exists(path.join(project, "src/_localapp_runtime/server-core/dist/index.js"))).toBe(true);
    expect(await exists(path.join(project, ".claude/skills/custom-localapp/SKILL.md"))).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(project, ".localapp/project-config.json"), "utf8"))).toMatchObject({
      ejected: true,
      templateState: "ejected",
    });
    expect(JSON.parse(await fs.readFile(path.join(project, "package.json"), "utf8")).scripts).not.toHaveProperty("postinstall");
  });

  it("resumes eject after package rewrite but before the final ejected marker", async () => {
    // Break caught: retry after package commit mistakes the rewritten package or moved directories for user collisions.
    await expect(ejectManagedTemplate(project, {
      beforeFinalMarker: async () => { throw new Error("simulated final marker interruption"); },
    })).rejects.toMatchObject({ code: "template_eject_failed" });

    expect(await exists(path.join(project, "src/_localapp_runtime/server-core/dist/index.js"))).toBe(true);
    expect(await exists(path.join(project, ".claude/skills/custom-localapp/SKILL.md"))).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(project, "package.json"), "utf8")).scripts).not.toHaveProperty("postinstall");
    const interruptedConfig = JSON.parse(await fs.readFile(path.join(project, ".localapp/project-config.json"), "utf8"));
    expect(interruptedConfig).toMatchObject({ templateState: "ejecting" });
    expect(interruptedConfig.ejected).toBeUndefined();

    await expect(ejectManagedTemplate(project)).resolves.toEqual({ ejected: true });
    expect(JSON.parse(await fs.readFile(path.join(project, ".localapp/project-config.json"), "utf8"))).toMatchObject({
      templateState: "ejected",
      ejected: true,
    });
  });

  it("never treats an unrelated eject destination as a resumable move", async () => {
    // Break caught: retry logic accepting any existing destination can overwrite or adopt user-owned content.
    const destination = path.join(project, "src/_localapp_runtime");
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "user.txt"), "user-owned\n");

    await expect(ejectManagedTemplate(project)).rejects.toMatchObject({ code: "template_eject_collision" });

    expect(await fs.readFile(path.join(destination, "user.txt"), "utf8")).toBe("user-owned\n");
    expect(await exists(path.join(project, ".localapp/runtime/server-core/dist/index.js"))).toBe(true);
  });
});

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function localAppReplacementRace(label: string): Promise<{
  replaced(): boolean;
  replace(): Promise<void>;
  expectExternalUntouched(): Promise<void>;
  restore(): Promise<void>;
}> {
  const heldLocalApp = path.join(directory, `held-localapp-${label}`);
  const externalLocalApp = path.join(directory, `external-localapp-${label}`);
  await fs.mkdir(externalLocalApp);
  await fs.writeFile(path.join(externalLocalApp, "sentinel.txt"), "external sentinel\n");
  let didReplace = false;
  return {
    replaced: () => didReplace,
    replace: async () => {
      didReplace = true;
      await fs.rename(path.join(project, ".localapp"), heldLocalApp);
      await fs.symlink(externalLocalApp, path.join(project, ".localapp"), "dir");
    },
    expectExternalUntouched: async () => {
      expect(await fs.readFile(path.join(externalLocalApp, "sentinel.txt"), "utf8")).toBe("external sentinel\n");
      expect((await fs.readdir(externalLocalApp)).sort()).toEqual(["sentinel.txt"]);
    },
    restore: async () => {
      if (!didReplace) return;
      await fs.rm(path.join(project, ".localapp"));
      await fs.rename(heldLocalApp, path.join(project, ".localapp"));
    },
  };
}
