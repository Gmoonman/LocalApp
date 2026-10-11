import { createSystemAgentEnvironment } from "./system-agent-environment";
import { createPythonEnvironmentForm } from "./python-environment-form";
import { Button } from "./shadcn/button";
import { Input } from "./shadcn/input";
import { Label } from "./shadcn/label";
import { Switch } from "./shadcn/switch";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./shadcn/card";
import { Badge } from "./shadcn/badge";
import { Skeleton } from "./shadcn/skeleton";
const PythonEnvironmentForm = createPythonEnvironmentForm({Button, Input, Label, Switch, Card, CardHeader, CardTitle, CardDescription, CardContent});
const Environment = createSystemAgentEnvironment({Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Skeleton, PythonEnvironmentForm});
export function NativeSystemEnvironment() {
  return <div className="localapp-native-settings"><Environment /></div>;
}
