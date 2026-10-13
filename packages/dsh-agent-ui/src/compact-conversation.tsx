import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "localapp.conversation": {kind:"single"; scope:"session-maybe"};
  }
}

/** The floating entry owns navigation and input; dsh owns the live transcript. */
export function installCompactConversation(ctx: Context): void {
  if (new URLSearchParams(window.location.search).get("localappCompact") !== "1") return;
  ctx.slots.register({
    name:"root", priority:-1,
    children:{"localapp.conversation":{kind:"single",scope:"session-maybe"}},
  }, ({renderSlot}) => <main data-localapp-conversation style={{height:"100dvh", display:"flex", flexDirection:"column", background:"var(--dsw-alias-background-primary, white)"}}>
    {renderSlot("localapp.conversation", {})}
  </main>);
  ctx.slots.register({name:"localapp.conversation"}, ({sessionId, useSessions, renderFactorySlot}) => {
    const blank = useSessions(snapshot => sessionId ? snapshot.byId[sessionId]?.blank : true);
    return !sessionId || blank
      ? <div role="status" style={{padding:24, color:"#737373", fontSize:14}}>描述你的需求，开始应用对话</div>
      : renderFactorySlot("conversation.content", {variant:"embedded", phase:"active", hero:false});
  });
  // Only replace the ordinary input bar. Approval/question takeovers and the
  // queued-turn dock remain rendered by the upstream conversation content.
  ctx.slots.inject("conversation.composer.bar", () => ctx.slots.register({name:"conversation.composer.bar", priority:-1}, () => null));
}
