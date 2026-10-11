"use client";

import { useState } from "react";
import { Bot, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function agentStarterPhrase(origin: string): string {
  return `阅读 ${origin}/starter.md，按照本地开发流程帮助我同步并修改应用；先确认应用名称，上传源码后由我决定上线。`;
}

export function AgentStarterHint({ compact = false }: { compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const phrase = agentStarterPhrase(origin);

  return (
    <div className={compact ? "text-left" : "text-left"}>
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 shrink-0" />
        <p className="text-sm font-semibold">使用外部 Agent 在本地开发</p>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        把下面这句话发给本地的 Codex、Claude Code 等 Agent，并补充应用名称和需求。
        在线开发请直接点击“创建应用”，无需安装 CLI。
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
        <code className="min-w-0 break-all rounded-md border border bg-background px-3 py-2 font-mono text-xs font-medium text-foreground">
          {phrase}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            navigator.clipboard.writeText(phrase).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? (
            <>
              <span>已复制</span>
              <Check className="h-4 w-4" />
            </>
          ) : (
            <>
              <span>复制</span>
              <Copy className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
      <a
        href="/starter.md"
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block text-xs underline decoration-black/25 underline-offset-4 hover:decoration-current"
      >
        查看 starter.md 完整说明
      </a>
    </div>
  );
}
