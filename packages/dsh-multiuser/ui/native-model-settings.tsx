import { useMemo, useState } from "react";
import { createAgentModelSettings } from "./model-settings";
import { createAgentCapabilitySettings } from "./agent-capability-settings";
import { Button } from "./shadcn/button";
import { Input } from "./shadcn/input";
import { Label } from "./shadcn/label";
import { Switch } from "./shadcn/switch";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./shadcn/card";
import { Badge } from "./shadcn/badge";
import { Skeleton } from "./shadcn/skeleton";
import { ChoiceSelect } from "./shadcn/choice-select";
const AgentSettings = createAgentCapabilitySettings({Button, Input, Label, Switch, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Skeleton});
function NativeChoiceSelect(props: React.ComponentProps<typeof ChoiceSelect>) {
  return <ChoiceSelect {...props} contentClassName="localapp-native-settings z-[1100]" />;
}
export function NativeModelSettings() {
  const [notice, setNotice] = useState("");
  const Panel = useMemo(() => createAgentModelSettings({Button, Input, Label, ChoiceSelect: NativeChoiceSelect, AgentSettings, notifySuccess: setNotice}), []);
  return <div className="localapp-native-settings">
    <Panel showCapabilities={false} />
    {notice && <p role="status" className="mt-4 text-sm text-muted-foreground">{notice}</p>}
  </div>;
}
