import type { ComposerAttachment, SessionInput } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
type SessionId = Parameters<ISessions["scope"]>[0];

/** Methods exposed by the installed native ConversationController implementation. */
interface NativeFileDrafts {
  createDrafts(sessionId: SessionId, files: readonly File[]): readonly ComposerAttachment[];
  releaseDraftAttachments(drafts: readonly ComposerAttachment[]): void;
}
function fileDrafts(value: unknown): NativeFileDrafts {
  if (!value || typeof value !== "object" || !("createDrafts" in value) || typeof value.createDrafts !== "function"
    || !("releaseDraftAttachments" in value) || typeof value.releaseDraftAttachments !== "function") {
    throw new Error("当前 dsh 对话服务不支持文件草稿");
  }
  return value as NativeFileDrafts;
}
/** Reuse native upload/image handling, rolling back drafts refused by its input machine. */
export function registerNativeAttachments(sessionId: SessionId, input: SessionInput, conversation: unknown, files: readonly File[]): readonly ComposerAttachment[] {
  if (input.state.getSnapshot().phase !== "plain") throw new Error("输入框正在提交，请稍后重试");
  if (!files.length) return [];
  const native = fileDrafts(conversation);
  const drafts = native.createDrafts(sessionId, files);
  try {
    if (!input.addAttachments(drafts.map(draft => draft.id))) throw new Error("原生输入框拒绝添加附件");
    return drafts;
  } catch (error) {
    native.releaseDraftAttachments(drafts);
    throw error;
  }
}

export function nativeAttachmentList(input: SessionInput, conversation: unknown) {
  if (!conversation || typeof conversation !== "object" || !("resolveDraftAttachments" in conversation)
    || typeof conversation.resolveDraftAttachments !== "function") throw new Error("原生附件列表不可用");
  const drafts = conversation.resolveDraftAttachments(input.state.getSnapshot().attachmentIds) as readonly ComposerAttachment[];
  return drafts.map(draft => ({id: String(draft.id), name: draft.file.name, size: draft.file.size}));
}
export function removeNativeAttachment(input: SessionInput, conversation: unknown, id: string): void {
  if (input.state.getSnapshot().phase !== "plain") throw new Error("输入框正在提交，请稍后重试");
  if (!conversation || typeof conversation !== "object" || !("releaseDraftAttachment" in conversation)
    || typeof conversation.releaseDraftAttachment !== "function") throw new Error("原生附件移除不可用");
  const attachmentId=input.state.getSnapshot().attachmentIds.find(value => value === id);
  if (!attachmentId) throw new Error("附件已不存在");
  if (!input.removeAttachment(attachmentId)) throw new Error("原生输入框拒绝移除附件");
  conversation.releaseDraftAttachment(attachmentId);
}
