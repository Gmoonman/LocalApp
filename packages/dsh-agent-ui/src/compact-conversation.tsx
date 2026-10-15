import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type { ConversationViewsProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { useState, useEffect } from "react";
import { Button } from "@localapp/ui/button";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "localapp.conversation": {kind:"single"; scope:"session-maybe"};
  }
}

/** The floating entry owns navigation and input; dsh owns the live transcript. */
export function installCompactConversation(ctx: Context): void {
  if (new URLSearchParams(window.location.search).get("localappCompact") !== "1") return;
  function CompactViews({sessionId, renderSlot}: ConversationViewsProps) {
    const [view, setView] = useState("chat");
    useEffect(() => { ctx.uiConversation.binding(sessionId).activate(view); }, [sessionId, view]);
    return <>
      <nav className="localapp-conversation-views" aria-label="对话视图" style={{display:"flex", gap:8, padding:8}}>
        <Button size="sm" variant={view === "chat" ? "secondary" : "ghost"} aria-pressed={view === "chat"} onClick={() => setView("chat")}>对话</Button>
        <Button size="sm" variant={view === "trajectory" ? "secondary" : "ghost"} aria-pressed={view === "trajectory"} onClick={() => setView("trajectory")}>运行轨迹</Button>
      </nav>
      {renderSlot("conversation.session", {view})}
    </>;
  }
  ctx.slots.register({
    name:"root", priority:-1,
    children:{"localapp.conversation":{kind:"single",scope:"session-maybe"}},
  }, ({renderSlot}) => <main data-localapp-conversation style={{height:"100dvh", display:"flex", flexDirection:"column", background:"var(--dsw-alias-background-primary, white)"}}>
    <style>{`
      .localapp-conversation-views button { border:0; border-radius:6px; padding:6px 12px; font:inherit; font-size:13px; cursor:pointer; color:inherit; background:transparent; }
      .localapp-conversation-views button:hover { background:var(--dsw-alias-background-secondary, #f5f5f5); }
      .localapp-conversation-views button[aria-pressed="true"] { background:var(--dsw-alias-background-secondary, #f0f0f0); font-weight:600; }
      .localapp-conversation-views button:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
    `}</style>
    {renderSlot("localapp.conversation", {})}
  </main>);
  ctx.slots.register({name:"localapp.conversation"}, ({sessionId, useSessions, renderFactorySlot}) => {
    const blank = useSessions(snapshot => sessionId ? snapshot.byId[sessionId]?.blank : true);
    return !sessionId || blank
      ? <div role="status" style={{padding:24, color:"#737373", fontSize:14}}>描述你的需求，开始应用对话</div>
      : renderFactorySlot("conversation.content", {variant:"embedded", phase:"active", hero:false}, {slots:{views:CompactViews}});
  });
  // Only replace the ordinary input bar. Approval/question takeovers and the
  // queued-turn dock remain rendered by the upstream conversation content.
  ctx.slots.inject("conversation.composer.bar", () => ctx.slots.register({name:"conversation.composer.bar", priority:-1}, () => null));
}
