"use client";
import { createAgentCapabilitySettings } from "@localapp/dsh-multiuser/ui/agent-capability-settings";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
export const AppAgentSettings = createAgentCapabilitySettings({
  Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Switch, Badge, Input, Label, Skeleton,
});
