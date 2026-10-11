"use client";
import { createDevelopmentAgentSettings } from "@localapp/dsh-app-development/ui/development-agent-settings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
export const DevelopmentAgentSettings = createDevelopmentAgentSettings({
  Button, Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger, Switch, Label, Textarea,
});
