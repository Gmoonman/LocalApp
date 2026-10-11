"use client";
import { createAgentModelSettings } from "@localapp/dsh-multiuser/ui/model-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChoiceSelect } from "@/components/ui/choice-select";
import { AppAgentSettings } from "@/components/app-settings/agent-settings";
import { toast } from "sonner";
const AgentModelSettings = createAgentModelSettings({Button, Input, Label, ChoiceSelect, AgentSettings: AppAgentSettings, notifySuccess: message => toast.success(message)});

export default function Page() { return <AgentModelSettings />; }
