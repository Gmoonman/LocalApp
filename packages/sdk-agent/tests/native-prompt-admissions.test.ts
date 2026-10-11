import {it,expect,vi} from "vitest";
import {NativePromptAdmissions} from "../../dsh-multiuser/src/native-prompt-admissions.mts";
it("merges pending and accepted retries",async()=>{
 const cache=new NativePromptAdmissions();let resolve!:(v:{accepted:boolean})=>void;
 const submit=vi.fn(()=>new Promise<{accepted:boolean}>(r=>{resolve=r;}));
 const first=cache.run("one",submit),second=cache.run("one",submit);await Promise.resolve();resolve({accepted:true});
 await Promise.all([first,second]);await cache.run("one",submit);expect(submit).toHaveBeenCalledTimes(1);
});
it("retries failures and refusals",async()=>{
 const cache=new NativePromptAdmissions();const submit=vi.fn().mockRejectedValueOnce(Error("failed")).mockResolvedValueOnce({accepted:false}).mockResolvedValue({accepted:true});
 await expect(cache.run("one",submit)).rejects.toThrow("failed");await cache.run("one",submit);await cache.run("one",submit);expect(submit).toHaveBeenCalledTimes(3);
});
it("preserves pending entries at capacity and evicts completed receipts",async()=>{
 const cache=new NativePromptAdmissions(1);let resolve!:(v:{accepted:boolean})=>void;
 const first=cache.run("one",()=>new Promise<{accepted:boolean}>(r=>{resolve=r;}));await Promise.resolve();
 await expect(cache.run("two",async()=>({accepted:true}))).rejects.toThrow("Too many pending");resolve({accepted:true});await first;
 await expect(cache.run("two",async()=>({accepted:true}))).resolves.toEqual({accepted:true});
});
it("rejects late acknowledgements and new requests after disposal",async()=>{
 const cache=new NativePromptAdmissions();let resolve!:(v:{accepted:boolean})=>void;
 const first=cache.run("one",()=>new Promise<{accepted:boolean}>(r=>{resolve=r;}));await Promise.resolve();cache.dispose();resolve({accepted:true});
 await expect(first).rejects.toThrow("runtime stopped");await expect(cache.run("two",async()=>({accepted:true}))).rejects.toThrow("runtime stopped");
});
it("does not start a queued admission after disposal",async()=>{
 const cache=new NativePromptAdmissions();const submit=vi.fn(async()=>({accepted:true}));
 const pending=cache.run("one",submit);cache.dispose();
 await expect(pending).rejects.toThrow("runtime stopped");expect(submit).not.toHaveBeenCalled();
});
