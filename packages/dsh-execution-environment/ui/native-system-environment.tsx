import { createSystemAgentEnvironment } from "./system-agent-environment";
import { createPythonEnvironmentForm } from "./python-environment-form";
import { Button } from "@localapp/ui/button";
import { Input } from "@localapp/ui/input";
import { Label } from "@localapp/ui/label";
import { Switch } from "@localapp/ui/switch";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@localapp/ui/card";
import { Badge } from "@localapp/ui/badge";
import { Skeleton } from "@localapp/ui/skeleton";
const PythonEnvironmentForm = createPythonEnvironmentForm({Button, Input, Label, Switch, Card, CardHeader, CardTitle, CardDescription, CardContent});
const Environment = createSystemAgentEnvironment({Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Skeleton, PythonEnvironmentForm});
export function NativeSystemEnvironment() {
  return <div className="localapp-native-settings"><Environment /></div>;
}
