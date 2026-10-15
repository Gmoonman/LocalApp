import {installCompactConversation} from "./compact-conversation.js";
import type {Context} from "@deepseek-ai/cordis";
import type {ISessions} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type {} from "@deepseek-ai/dsh-api-workspace-controller/client";
import {installNativeComposerBridge} from "./native-composer-bridge.js";
import {installNativeAttachmentObserver} from "./native-attachment-observer.js";
import {registerNativeAttachments,removeNativeAttachment} from "./native-attachment-intake.js";
import {installNativeNavigationBridge} from "./native-navigation-bridge.js";
export const inject=["sessions","conversation","uiConversation","uiWorkspace","workspaces","slots"];
export function apply(ctx: Omit<Context,"sessions"> & {sessions:ISessions}):void {
  try { installCompactConversation(ctx); } catch(error) { console.error("LocalApp conversation initialization failed", error); throw error; }
  ctx.effect(() => installNativeComposerBridge(ctx.sessions, context => {
    const conversation = context.get("conversation");
    if (!conversation) throw new Error("原生对话服务不可用");
    const input = conversation.input.for(context);
    return {input, removeFile: id => removeNativeAttachment(input, conversation, id), cancel: () => conversation.cancel(), addFiles: files => {
      const sessionId = ctx.sessions.scopeOf(context);
      if (!sessionId) throw new Error("原生会话不可用");
      registerNativeAttachments(sessionId, input, conversation, files);
    }};
  }));
  ctx.effect(() => installNativeAttachmentObserver(ctx.sessions, context => {
    const conversation=context.get("conversation");
    if(!conversation)throw new Error("原生对话服务不可用");
    return {input:conversation.input.for(context),conversation};
  }));
  ctx.effect(() => installNativeNavigationBridge(ctx.sessions, ctx.uiWorkspace, ctx.workspaces));
}
