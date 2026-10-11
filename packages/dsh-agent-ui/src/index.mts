import {Context,Service} from "@deepseek-ai/cordis";
import type {FastifyInstance} from "fastify";

export interface ConversationIdentity {
  id: "user" | "developer";
  label: string;
}
/** Owns the floating conversation entry; execution and permissions stay in providers. */
export default class AgentUI extends Service {
  static inject = [];
  private active = true;
  private readonly entries = new Map<string, ConversationIdentity>();
  constructor(context: Context) {
    super(context,"localappAgentUI");
    context.effect(() => () => {this.active=false;this.entries.clear();});
  }
  registerIdentity(identity: ConversationIdentity): () => void {
    if(!this.active) throw new Error("Agent UI plugin is stopped");
    if(this.entries.has(identity.id)) throw new Error(`Conversation identity already registered: ${identity.id}`);
    this.entries.set(identity.id,identity);
    return () => {if(this.entries.get(identity.id)===identity)this.entries.delete(identity.id);};
  }
  identities(): ConversationIdentity[] {return [...this.entries.values()].map(value=>({...value}));}
  registerHttp(app: FastifyInstance): void {
    app.get("/api/agent/ui",async (_request,reply)=>this.active
      ? {success:true,data:{enabled:true,identities:this.identities()}}
      : reply.code(503).send({success:false,error:"Agent UI plugin is stopped"}));
  }
}
declare module "@deepseek-ai/cordis" {interface Context {localappAgentUI:AgentUI}}
