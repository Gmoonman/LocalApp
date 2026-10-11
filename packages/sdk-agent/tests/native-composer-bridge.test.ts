import { afterEach, expect, it, vi } from "vitest";
import { installNativeComposerBridge } from "../../dsh-app-platform/src/native-composer-bridge.js";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const parent = { postMessage: vi.fn() };
  let receive!: (event: any) => void;
  const remove = vi.fn();
  vi.stubGlobal("window", {parent, location:{origin:"http://localhost"}, addEventListener: (_:string, cb:any) => {receive=cb;}, removeEventListener:remove});
  const row = {retainedBy:{mainView:1}};
  const context = {};
  const release = vi.fn();
  const sessions = {list:{getSnapshot:()=>({byId:{one:row}})}, using:vi.fn(async (_:any, options:any, cb:any) => {
    try { return await cb({ready:Promise.resolve({ctx:context})}); } finally {release();}
  })};
  const inputState = {phase:"plain"};
  const input = {setDraft:vi.fn(),submit:vi.fn(),state:{getSnapshot:()=>inputState}};
  const cancel = vi.fn(async()=>{});
  const resolve = vi.fn(()=>({input,cancel}));
  const dispose=installNativeComposerBridge(sessions as any,resolve as any);
  const send=(data:any, overrides:any={})=>receive({source:parent,origin:"http://localhost",data:{type:"localapp:native-composer",requestId:"r1",sessionId:"one",...data},...overrides});
  return {parent,row,sessions,input,inputState,cancel,resolve,release,dispose,send,remove};
}
it("uses the native input and releases its reference after submit and cancellation",async()=>{
  const f=fixture();f.send({action:"submit",prompt:"edit the application"});
  await vi.waitFor(()=>expect(f.parent.postMessage).toHaveBeenCalledOnce());
  expect(f.input.setDraft).toHaveBeenCalledWith("edit the application");
  expect(f.input.submit).toHaveBeenCalledWith("queue","click");
  expect(f.release).toHaveBeenCalledOnce();
  f.send({requestId:"r2",action:"cancel"});
  await vi.waitFor(()=>expect(f.cancel).toHaveBeenCalledOnce());
  await vi.waitFor(()=>expect(f.release).toHaveBeenCalledTimes(2));f.dispose();
});
it("rejects foreign callers and prevents dispatch after selection changes or disposal",async()=>{
  const f=fixture();f.send({action:"submit",prompt:"foreign"},{origin:"https://foreign.invalid"});
  f.send({action:"cancel"},{source:{}});expect(f.sessions.using).not.toHaveBeenCalled();
  f.send({action:"submit",prompt:"stale"});f.row.retainedBy.mainView=0;
  await vi.waitFor(()=>expect(f.parent.postMessage).toHaveBeenCalledOnce());
  expect(f.input.submit).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledOnce();
  expect(f.parent.postMessage.mock.calls[0][0].error).toBe("会话已切换");
  f.dispose();f.send({requestId:"r2",action:"cancel"});expect(f.sessions.using).toHaveBeenCalledOnce();expect(f.remove).toHaveBeenCalledOnce();
});

it("preserves a busy native draft and reports refusal instead of claiming submission",async()=>{
  const f=fixture();f.inputState.phase="submitting";f.send({action:"submit",prompt:"replacement"});
  await vi.waitFor(()=>expect(f.parent.postMessage).toHaveBeenCalledOnce());
  expect(f.input.setDraft).not.toHaveBeenCalled();expect(f.input.submit).not.toHaveBeenCalled();
  expect(f.parent.postMessage.mock.calls[0][0].error).toBe("输入框正在提交，请稍后重试");f.dispose();
});

it("passes browser files only into the current native session intake",async()=>{
 const f=fixture();const addFiles=vi.fn();f.resolve.mockReturnValue({input:f.input,cancel:f.cancel,addFiles} as any);
 const files=[new File(["binary"],"report.pdf",{type:"application/pdf"})];
 f.send({action:"attach",files});await vi.waitFor(()=>expect(addFiles).toHaveBeenCalledWith(files));
 expect(f.input.submit).not.toHaveBeenCalled();await vi.waitFor(()=>expect(f.release).toHaveBeenCalledOnce());
 f.send({requestId:"invalid",action:"attach",files:[{name:"fake.pdf"}]});expect(f.sessions.using).toHaveBeenCalledOnce();f.dispose();
});
