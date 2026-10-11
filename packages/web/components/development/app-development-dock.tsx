"use client";
import { createConversationDock } from "@localapp/dsh-agent-ui/ui/conversation-dock";
export type { DockIdentityProps } from "@localapp/dsh-agent-ui/ui/conversation-dock";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DshDiff, DshMarkdown, DshTerminal } from "./dsh-view";
import { NativeConversationFrame } from "./native-conversation-frame";
import { lazy, Suspense } from "react";
const LazyDevelopmentAgentSettings = lazy(() => import("./development-agent-settings").then(module => ({ default: module.DevelopmentAgentSettings })));
const DevelopmentAgentSettings = (props: {projectId: string}) => <Suspense fallback={null}><LazyDevelopmentAgentSettings {...props} /></Suspense>;
export const AppDevelopmentDock = createConversationDock({
  Button, Textarea, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuItem,
  DshDiff, DshMarkdown, DshTerminal, NativeConversationFrame, DevelopmentAgentSettings,
});
