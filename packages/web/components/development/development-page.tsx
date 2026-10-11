"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createDevelopmentPage, type DevelopmentPageProps } from "@localapp/dsh-app-development/ui/development-page";
import { AppDevelopmentDock } from "./app-development-dock";
import { NativeDevelopmentEntry } from "@localapp/dsh-app-development/ui/development-entry";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
const Controller = createDevelopmentPage({AppDevelopmentDock, DshDevelopmentShell: () => null});
export function DevelopmentPage(props: DevelopmentPageProps) {
  return props.application ? <ApplicationDevelopmentPage {...props}/> : <NativeDevelopmentEntry/>;
}
function ApplicationDevelopmentPage(props: DevelopmentPageProps) {
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef<((accepted: boolean) => void) | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const finish = useCallback((accepted: boolean) => {
    const resolve = pending.current; pending.current = null; setMessage(null); resolve?.(accepted);
  }, []);
  const confirmAction = useCallback((text: string) => new Promise<boolean>(resolve => {
    returnFocus.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : lastFocus.current;
    pending.current?.(false); pending.current = resolve; setMessage(text);
  }), []);
  useEffect(() => {
    const remember = (event: FocusEvent) => { if (!pending.current && event.target instanceof HTMLElement) lastFocus.current = event.target; };
    document.addEventListener("focusin", remember);
    return () => { document.removeEventListener("focusin", remember); pending.current?.(false); pending.current = null; };
  }, []);
  return <><Controller {...props} confirmAction={confirmAction} />
    <Dialog open={message !== null} onOpenChange={open => { if (!open) finish(false); }}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => returnFocus.current?.focus()); }}><DialogTitle>确认应用操作</DialogTitle><DialogDescription>{message}</DialogDescription>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => finish(false)}>取消</Button><Button onClick={() => finish(true)}>确认</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}
