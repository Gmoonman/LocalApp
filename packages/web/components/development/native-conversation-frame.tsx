"use client";
import { useCallback } from "react";
import type { HarnessAgent } from "@localapp/sdk-agent/harness-client";
import { attachNativeFrame } from "@localapp/sdk-agent/native-frame-bridge";
import { NativeConversationFrame as PlatformFrame, type NavigationProps } from "@localapp/dsh-agent-ui/ui/native-conversation-frame";
export type { NativeSelection, NativeCatalogEntry } from "@localapp/dsh-agent-ui/ui/native-conversation-frame";
export function NativeConversationFrame(props: NavigationProps & (
  | {identity: "user"; applicationId: string; providerId: string; agent: HarnessAgent}
  | {identity: "developer"; projectId: string; providerId: string})) {
  const agent = props.identity === "user" ? props.agent : undefined;
  const bind = useCallback((frame: HTMLIFrameElement) => attachNativeFrame(frame, agent!), [agent]);
  const src = props.identity === "developer"
    ? `/api/development/projects/${encodeURIComponent(props.projectId)}/native/${encodeURIComponent(props.providerId)}/`
    : `/api/agent/native/${btoa(JSON.stringify({appId: props.applicationId, providerId: props.providerId})).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}/?localappBridge=1`;
  return <PlatformFrame {...props} src={src} title={props.identity === "developer" ? "原生应用开发对话" : "原生应用用户对话"} bind={agent ? bind : undefined} />;
}
