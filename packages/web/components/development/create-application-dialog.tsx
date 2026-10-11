"use client";
import { createApplicationDialog } from "@localapp/dsh-app-development/ui/creation-dialog";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceSelect } from "@/components/ui/choice-select";
import { NativeConversationFrame } from "./native-conversation-frame";

export const CreateApplicationDialog = createApplicationDialog({
  Dialog, DialogContent, DialogTitle, DialogDescription,
  Button, Textarea, ChoiceSelect, NativeConversationFrame,
});
