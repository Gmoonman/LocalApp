/** Merge retries within one native runtime while bounding retained receipts. */
export class NativePromptAdmissions<T extends {accepted:boolean}> {
  private readonly entries=new Map<string,Promise<T>>();
  private readonly completed=new Set<string>();
  private disposed=false;
  constructor(private readonly limit=1024){if(!Number.isSafeInteger(limit)||limit<1)throw new Error("Invalid native request capacity");}
  async run(key:string,submit:()=>Promise<T>):Promise<T>{
    if(this.disposed)throw new Error("Native request runtime stopped");
    const previous=this.entries.get(key);if(previous)return previous;
    if(this.entries.size>=this.limit){
      const oldest=this.completed.values().next().value;
      if(oldest===undefined)throw new Error("Too many pending native requests");
      this.completed.delete(oldest);this.entries.delete(oldest);
    }
    const pending=Promise.resolve().then(()=>{
      if(this.disposed)throw new Error("Native request runtime stopped");
      return submit();
    }).then(result=>{
      if(this.disposed)throw new Error("Native request runtime stopped");
      if(result.accepted)this.completed.add(key);else this.entries.delete(key);
      return result;
    }).catch(error=>{if(this.entries.get(key)===pending)this.entries.delete(key);throw error;});
    this.entries.set(key,pending);return pending;
  }
  dispose(){this.disposed=true;this.entries.clear();this.completed.clear();}
}
