"use client";
import { NativeDevelopmentEntry } from "@localapp/dsh-app-development/ui/development-entry";
import type { DevelopmentShellProps } from "@localapp/dsh-app-development/ui/development-types";
export type { DevelopmentShellProps } from "@localapp/dsh-app-development/ui/development-types";
/** Compatibility component; dsh owns the actual layout and conversations. */
export function DshDevelopmentShell(_props: DevelopmentShellProps) {
  return <NativeDevelopmentEntry/>;
}
