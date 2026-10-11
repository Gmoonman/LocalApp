import fs from "node:fs";
import path from "node:path";
import { ProjectStore, DevelopmentError } from "./projects.cjs";
export interface ReleaseBuildStore {
  get(project: string, user: string, buildId: string): {
    purpose?: string; status: string; packagePath?: string;
    sha256?: string; sourceVersion: string;
  };
}
import { installAppPackage } from "@localapp/dsh-app-platform/app-installer";
import { inspectAppPackage } from "@localapp/dsh-app-platform/app-package";
import { readPageMeta } from "@localapp/dsh-app-platform/page-storage";
export class DevelopmentReleases {
  private readonly publishing = new Set<string>();
  constructor(
    private readonly dataDir: string,
    private readonly projects: ProjectStore,
    private readonly builds: ReleaseBuildStore,
  ) {}
  target(project: string, user: string) {
    const p = this.projects.get(project, user);
    return {
      version: readPageMeta(this.dataDir, user, p.name)?.currentVersion ?? 0,
    };
  }
  async release(
    project: string,
    user: string,
    buildId: string,
    expected: number,
    key: string,
  ) {
    const p = this.projects.get(project, user),
      b = this.builds.get(project, user, buildId);
    if (b.purpose === "preview") throw new DevelopmentError("预览尚未通过完整检查，请先执行发布构建");
    if (b.status !== "succeeded" || !b.packagePath)
      throw new DevelopmentError("构建尚未通过检查");
    if (typeof key !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(key))
      throw new DevelopmentError("发布请求标识无效");
    const dir = path.join(this.projects.directory, project, "releases"),
      file = path.join(dir, key + ".json");
    if (fs.existsSync(file)) {
      const previous = JSON.parse(fs.readFileSync(file, "utf8"));
      if (previous.buildId !== buildId)
        throw new DevelopmentError("发布标识已用于其他构建", 409);
      return previous;
    }
    const target = user + "/" + p.name;
    if (this.publishing.has(target))
      throw new DevelopmentError("应用正在发布", 409);
    this.publishing.add(target);
    try {
      if (this.target(project, user).version !== expected)
        throw new DevelopmentError("正式应用版本已改变，请重新检查", 409);
      const inspected = await inspectAppPackage(b.packagePath);
      if (inspected.digest !== b.sha256 || inspected.name !== p.name)
        throw new DevelopmentError("构建包或应用身份已改变");
      const result = await installAppPackage({
        dataDir: this.dataDir,
        ownerId: user,
        packagePath: b.packagePath,
        expectedLocalVersion: expected,
      });
      const release = {
        buildId,
        sourceVersion: b.sourceVersion,
        digest: b.sha256,
        version: result.localVersion,
        url: `/${user}/${p.name}/`,
        createdAt: new Date().toISOString(),
        userId: user,
      };
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(release), {
        flag: "wx",
        mode: 0o600,
      });
      return release;
    } finally {
      this.publishing.delete(target);
    }
  }
}
