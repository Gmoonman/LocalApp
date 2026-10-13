import { randomUUID } from "node:crypto";

/** Page reads stay in the browser; requests are isolated by user and project. */
export class DevelopmentPageContext {
  private active = new Map<string,string>();
  activate(scope:string,clientId:string) { this.active.set(scope,clientId); }
  private pending = new Map<string, {scope:string; clientId?:string; command?:unknown; resolve(value:unknown):void; timer:ReturnType<typeof setTimeout>}>();
  request(scope:string,command?:unknown):Promise<unknown> {
    if ([...this.pending.values()].filter(value=>value.scope===scope).length >= 8) throw new Error("页面读取请求过多");
    const id=randomUUID();
    return new Promise(resolve=> {
      const timer=setTimeout(()=>{this.pending.delete(id);resolve({error:"当前应用页面未连接，请打开应用后重试"});},command?120000:15000);
      this.pending.set(id,{scope,clientId:this.active.get(scope),command,resolve,timer});
    });
  }
  poll(scope:string, clientId:string) {
    return [...this.pending].filter(([,value])=>value.scope===scope && (!value.clientId||value.clientId===clientId))
      .map(([id,value])=>{value.clientId=clientId;return {id,...(value.command?{command:value.command}: {})};});
  }
  complete(scope:string,clientId:string,id:string,value:unknown) {
    const pending=this.pending.get(id);
    if(!pending||pending.scope!==scope||pending.clientId!==clientId)throw new Error("页面读取请求已结束");
    clearTimeout(pending.timer);this.pending.delete(id);pending.resolve(value);
  }
  close(){for(const value of this.pending.values()){clearTimeout(value.timer);value.resolve({error:"页面连接已关闭"});}this.pending.clear();this.active.clear();}
}
