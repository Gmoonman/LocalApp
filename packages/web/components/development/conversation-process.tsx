"use client";
import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

/** QEDAgent's per-turn process disclosure: answers stay outside, details open only on request. */
export function ConversationProcess({ children, running }: { children: ReactNode; running: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="dsh-process-row">
    <Button variant="ghost" size="sm" className="h-auto justify-start gap-2 px-0 py-1 text-xs font-normal text-muted-foreground hover:bg-transparent" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      {running ? "正在处理 · 查看过程" : "查看处理过程"}<ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
    </Button>
    {open && <div id={id} className="mt-2 space-y-2">{children}</div>}
  </div>;
}
