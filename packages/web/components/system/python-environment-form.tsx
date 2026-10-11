"use client";
import { createPythonEnvironmentForm } from "@localapp/dsh-multiuser/ui/python-environment-form";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
export const PythonEnvironmentForm = createPythonEnvironmentForm({Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Input, Label, Switch});
