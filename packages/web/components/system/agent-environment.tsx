"use client";
import { createSystemAgentEnvironment } from "@localapp/dsh-execution-environment/ui/system-agent-environment";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PythonEnvironmentForm } from "./python-environment-form";
export const SystemAgentEnvironment = createSystemAgentEnvironment({Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Skeleton, PythonEnvironmentForm});
