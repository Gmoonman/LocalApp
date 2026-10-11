import type { AppLifecycleStatus } from "./models.cjs";
export type { AppLifecycleStatus } from "./models.cjs";

export function getAppLifecycleStatus(value: { lifecycle?: { status?: unknown } }): AppLifecycleStatus {
  return value.lifecycle?.status === "offline" ? "offline" : "online";
}

export function isAppOffline(value: { lifecycle?: { status?: unknown } }): boolean {
  return getAppLifecycleStatus(value) === "offline";
}
