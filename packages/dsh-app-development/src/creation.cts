import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectStore, DevelopmentError } from "./projects.cjs";
import { templateSource } from "./template.cjs";
import { validateName } from "@localapp/dsh-app-platform/validate-name";
import { readPageMeta } from "@localapp/dsh-app-platform/page-storage";
import { writeAppPackage, inspectAppPackage } from "@localapp/dsh-app-platform/app-package";
import { installAppPackage } from "@localapp/dsh-app-platform/app-installer";

export interface Creation {
  projectId: string;
  sessionId: string;
  providerId: string;
  state: "planning" | "creating" | "ready";
  proposal?: { name: string; description: string };
  url?: string;
  starterDigest?: string;
  continued?: boolean;
}
/** Drafts use the same persistent session directory as the eventual application. */
export class ApplicationCreations {
  constructor(
    private dataDir: string,
    private projects: ProjectStore,
  ) {}
  private file(id: string, user: string) {
    this.projects.get(id, user);
    return path.join(this.projects.directory, id, "creation.json");
  }
  get(id: string, user: string): Creation {
    const file = this.file(id, user);
    if (!fs.existsSync(file)) throw new DevelopmentError("创建会话不存在", 404);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  list(user: string) {
    return this.projects.list(user, true).flatMap(project => {
      if (!fs.existsSync(this.file(project.id, user))) return [];
      const creation = this.get(project.id, user);
      return creation.state === "ready" ? [] : [{ ...creation, createdAt: project.createdAt }];
    });
  }
  isPlanning(id: string, user: string) {
    const file = this.file(id, user);
    return fs.existsSync(file) && this.get(id, user).state !== "ready";
  }
  private save(record: Creation, user: string) {
    const file = this.file(record.projectId, user),
      temporary = file + "." + randomUUID();
    fs.writeFileSync(temporary, JSON.stringify(record), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  }
  create(user: string, providerId: string) {
    const name = "draft-" + randomUUID();
    const project = this.projects.create(user, name, templateSource(name));
    const record: Creation = {
      projectId: project.id,
      sessionId: randomUUID(),
      providerId,
      state: "planning",
    };
    this.save(record, user);
    return record;
  }
  propose(id: string, user: string, value: unknown) {
    const record = this.get(id, user),
      proposal = value as { name: string; description: string };
    if (record.state !== "planning")
      throw new DevelopmentError("应用已进入创建阶段", 409);
    if (
      !proposal ||
      typeof proposal.name !== "string" ||
      validateName(proposal.name) ||
      typeof proposal.description !== "string" ||
      !proposal.description.trim() ||
      proposal.description.length > 4000
    )
      throw new DevelopmentError("应用名称或需求摘要无效");
    if (
      readPageMeta(this.dataDir, user, proposal.name) ||
      this.projects.list(user).some((p) => p.name === proposal.name)
    )
      throw new DevelopmentError("应用名称已存在，请选择其他名称", 409);
    record.proposal = {
      name: proposal.name,
      description: proposal.description,
    };
    this.save(record, user);
    return record.proposal;
  }
  invalidateProposal(id: string, user: string) {
    const record = this.get(id, user);
    if (record.state !== "planning")
      throw new DevelopmentError("应用已创建", 409);
    delete record.proposal;
    this.save(record, user);
  }
  async confirm(id: string, user: string, name: string) {
    const unlock = this.projects.lock(id, user);
    try {
      const record = this.get(id, user);
      if (record.state === "ready") {
        if (record.proposal?.name !== name)
          throw new DevelopmentError("应用已使用其他名称创建", 409);
        return record;
      }
      if (!record.proposal || record.proposal.name !== name)
        throw new DevelopmentError("请先与 Agent 敲定应用名称");
      const existing = readPageMeta(this.dataDir, user, name);
      if (
        existing &&
        (!record.starterDigest ||
          existing.versions.find((v) => v.version === 1)?.digest !==
            record.starterDigest)
      )
        throw new DevelopmentError("应用名称已存在，不能覆盖", 409);
      record.state = "creating";
      this.save(record, user);
      this.projects.nameDraft(id, user, name, record.proposal.description);
      const outputPath = path.join(
        this.projects.directory,
        id,
        "starter.localapp",
      );
      if (!fs.existsSync(outputPath)) {
        const manifest = JSON.parse(
          this.projects.read(id, user, "manifest.json").content,
        );
        // This fixed initial screen contains no application-controlled executable code.
        const script = `const root=document.getElementById('root');const main=document.createElement('main');main.style.cssText='max-width:960px;margin:80px auto;padding:32px;font-family:system-ui';const h=document.createElement('h1');h.textContent=${JSON.stringify(name)};const p=document.createElement('p');p.textContent='应用已创建。在下方对话中继续开发，预览会显示在这里。';const detail=document.createElement('p');detail.textContent=${JSON.stringify(record.proposal.description)};detail.style.color='#737373';main.append(h,p,detail);root?.replaceChildren(main);`;
        const files = [
          {
            path: "manifest.json",
            content: Buffer.from(JSON.stringify(manifest)),
          },
          {
            path: "dist/index.html",
            content: Buffer.from(
              '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./starter.js"></script></body></html>',
            ),
          },
          { path: "dist/starter.js", content: Buffer.from(script) },
        ];
        for (const [file, content] of Object.entries(
          this.projects.sourceFiles(id, user),
        ))
          if (
            /^migrations\/[^/]+\.sql$/.test(file) ||
            (file.startsWith("backend/") && file.endsWith(".json"))
          )
            files.push({
              path: file,
              content: Buffer.from(
                typeof content === "string" ? content : content.content,
                typeof content === "string" ? "utf8" : "base64",
              ),
            });
        await writeAppPackage({
          outputPath,
          metadata: {
            schemaVersion: 1,
            appId: name,
            version: "0.0.0-starter." + id.replaceAll("-", ""),
            platformVersion: manifest.platformVersion,
          },
          files,
        });
      }
      record.starterDigest = (await inspectAppPackage(outputPath)).digest;
      this.save(record, user);
      if (!existing)
        await installAppPackage({
          dataDir: this.dataDir,
          ownerId: user,
          packagePath: outputPath,
          expectedLocalVersion: 0,
        });
      record.state = "ready";
      record.url = `/${user}/${name}/?creation=${id}`;
      this.save(record, user);
      return record;
    } finally {
      unlock();
    }
  }
  continue(id: string, user: string, sessionId: string) {
    const prompt=this.continuationPrompt(id,user,sessionId);
    const record = this.get(id, user);
    if (
      record.state !== "ready" ||
      record.sessionId !== sessionId ||
      record.continued
    )
      throw new DevelopmentError("创建会话已继续或尚未确认", 409);
    record.continued = true;
    this.save(record, user);
    return prompt;
  }
  continuationPrompt(id:string,user:string,sessionId:string){
    const record=this.get(id,user);
    if(record.state!=="ready"||record.sessionId!==sessionId)throw new DevelopmentError("创建会话尚未确认或不匹配",409);
    return `用户已确认创建应用 ${record.proposal!.name}，起始页面已就绪。继续同一会话，开始实现刚刚讨论的需求：${record.proposal!.description}。遵循 AGENTS.md 和 shadcn/ui，完成可验证的改动后说明结果。`;
  }
}
