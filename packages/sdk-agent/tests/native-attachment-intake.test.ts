import { expect, it, vi } from "vitest";
import { registerNativeAttachments, removeNativeAttachment } from "../../dsh-app-platform/src/native-attachment-intake.js";
function fixture() {
 const files=[new File(["document bytes"],"report.pdf",{type:"application/pdf"})];
 const drafts=[{id:"draft-one",kind:"file",file:files[0]}];
 const input={state:{getSnapshot:()=>({phase:"plain"})},addAttachments:vi.fn(()=>true)};
 const native={createDrafts:vi.fn(()=>drafts),releaseDraftAttachments:vi.fn()};
 return {files,drafts,input,native};
}
it("registers the original files through native drafts and its input machine",()=>{
 const f=fixture();expect(registerNativeAttachments("one" as any,f.input as any,f.native,f.files)).toBe(f.drafts);
 expect(f.native.createDrafts).toHaveBeenCalledWith("one",f.files);expect(f.input.addAttachments).toHaveBeenCalledWith(["draft-one"]);expect(f.native.releaseDraftAttachments).not.toHaveBeenCalled();
});
it("releases uploaded drafts when the native input refuses their registration",()=>{
 const f=fixture();f.input.addAttachments.mockReturnValue(false);
 expect(()=>registerNativeAttachments("one" as any,f.input as any,f.native,f.files)).toThrow("拒绝添加附件");
 expect(f.native.releaseDraftAttachments).toHaveBeenCalledWith(f.drafts);
});
it("does not start uploads while admission is busy or the native capability is absent",()=>{
 const f=fixture();f.input.state.getSnapshot=()=>({phase:"submitting"});
 expect(()=>registerNativeAttachments("one" as any,f.input as any,f.native,f.files)).toThrow("正在提交");expect(f.native.createDrafts).not.toHaveBeenCalled();
 const g=fixture();expect(()=>registerNativeAttachments("one" as any,g.input as any,{},g.files)).toThrow("不支持文件草稿");
});

it("removes only an attachment owned by the current native input",()=>{
 const id="draft-one";const input={state:{getSnapshot:()=>({phase:"plain",attachmentIds:[id]})},removeAttachment:vi.fn(()=>true)};
 const native={releaseDraftAttachment:vi.fn()};
 removeNativeAttachment(input as any,native,id);expect(native.releaseDraftAttachment).toHaveBeenCalledWith(id);
 expect(()=>removeNativeAttachment(input as any,native,"foreign")).toThrow("不存在");expect(native.releaseDraftAttachment).toHaveBeenCalledOnce();
});
