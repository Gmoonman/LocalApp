import { Service, type Context } from "@deepseek-ai/cordis";
import { DOCUMENT_SKILLS_ROOT, PUBLIC_AGENT_SKILLS, preparePublicSkills, publicSkillAvailability, type DocumentEnvironment } from "./catalog.cjs";
import path from "node:path";
export interface DocumentToolsConfig { root?: string }
declare module "@deepseek-ai/cordis" { interface Context { localappDocuments: DocumentTools } }
/** Document bundles usable without LocalApp accounts or application hosting. */
export default class DocumentTools extends Service {
  private active = true;
  private readonly stopListeners = new Set<() => Promise<void> | void>();
  get enabled() { return this.active; }
  onStop(listener: () => Promise<void> | void) { this.check(); this.stopListeners.add(listener); return () => { this.stopListeners.delete(listener); }; }
  readonly root: string;
  constructor(ctx: Context, config: DocumentToolsConfig = {}) {
    super(ctx, "localappDocuments");
    this.root = config.root ?? DOCUMENT_SKILLS_ROOT;
    if (!path.isAbsolute(this.root)) throw new Error("Document Skills directory must be absolute");
    ctx.effect(() => async () => {
      this.active = false;
      const listeners = [...this.stopListeners]; this.stopListeners.clear();
      const stopped = await Promise.allSettled(listeners.map(listener => Promise.resolve().then(listener)));
      const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Document consumers failed to stop");
    });
  }
  private check() { if (!this.active) throw new Error("Document tools plugin is stopped"); }
  catalog(report: DocumentEnvironment) { this.check(); return publicSkillAvailability(report); }
  prepare(workspace: string, selected: string[], report: DocumentEnvironment) {
    this.check();
    const available = this.catalog(report);
    for (const id of selected) {
      if (!PUBLIC_AGENT_SKILLS.some(skill => skill.id === id)) throw new Error("Unknown public skill");
      if (!available.some(skill => skill.id === id && skill.available)) throw new Error("Document Skill dependencies are not ready");
    }
    return preparePublicSkills(workspace, selected, this.root);
  }
}
