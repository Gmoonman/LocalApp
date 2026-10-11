import { createElement, useEffect, useState } from "react";

/** Native shell context uses the same authenticated project API as development. */
export function NativeDevelopmentContext({ projectId }: { projectId: string }) {
  const [name, setName] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/development/projects/${encodeURIComponent(projectId)}`, {
      credentials: "include", signal: controller.signal,
    }).then(async response => {
      const body = await response.json();
      if (!response.ok || !body.success || typeof body.data?.name !== "string") throw new Error("Project unavailable");
      if (!controller.signal.aborted) setName(body.data.name);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [projectId]);
  return createElement("div", {
    "aria-label": "应用开发上下文",
    style: { padding: "6px 16px", fontSize: "12px", borderTop: "1px solid var(--border, #e5e7eb)", opacity: 0.75 },
  }, error ? "开发者模式 · 无法读取应用信息" : `开发者模式 · ${name ?? "正在读取应用…"}`);
}
