"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CircleDot, Star, LogIn, Sparkles, Save, Undo2, Redo2, Users, Code2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthModals } from "@/components/auth-modals/auth-provider";

interface UserData { id: string; name: string; displayName?: string | null; avatarUrl?: string | null; }
export interface PresenceSnapshot {
  count: number;
  anonymousCount: number;
  authenticatedUsers: Array<{ id: string; name: string; displayName: string | null; avatarUrl: string | null }>;
}

export interface PlatformEditSession {
  canSave: boolean;
  canUndo: boolean;
  canRedo: boolean;
  busy?: boolean;
  onSave: () => void | Promise<void>;
  onUndo: () => void | Promise<void>;
  onRedo: () => void | Promise<void>;
}

interface NavbarProps {
  pageName: string;
  previewControls?: React.ReactNode;
  onOpenDevelopment?: () => void;
  user: UserData | null;
  favCount: number;
  isFavorited: boolean;
  onToggleFavorite: () => void;
  onOpenIssues: () => void;
  openIssueCount?: number | null;
  aiMode?: "system" | "custom" | null;
  aiOpen?: boolean;
  onToggleAI?: () => void;
  bell?: React.ReactNode;
  editSession?: PlatformEditSession | null;
  presenceCount?: number | null;
  presenceSnapshot?: PresenceSnapshot | null;
}

export function Navbar({ onOpenDevelopment, previewControls, pageName, user, favCount, isFavorited, onToggleFavorite, onOpenIssues, openIssueCount, aiMode, aiOpen, onToggleAI, bell, editSession, presenceCount, presenceSnapshot }: NavbarProps) {
  const { openLogin } = useAuthModals();
  const initial = user ? (user.displayName || user.name).charAt(0).toUpperCase() : "?";
  const editBusy = editSession?.busy ?? false;
  const onlineCount = presenceSnapshot?.count ?? presenceCount ?? null;
  const [presenceOpen, setPresenceOpen] = useState(false);
  const presenceRef = useRef<HTMLDivElement>(null);
  const issueCount = openIssueCount ?? null;
  const issueLabel = issueCount === null ? "Issue" : `Issue，${issueCount} 个待处理`;

  useEffect(() => {
    if (!presenceOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (!presenceRef.current?.contains(event.target as Node)) setPresenceOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPresenceOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [presenceOpen]);

  return (
    <nav className={`flex shrink-0 flex-col bg-card ${previewControls ? "localapp-preview-navbar" : ""}`}>
      <div className="flex items-center justify-between px-4 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-2" data-testid="localapp-platform-nav-left">
        <strong className="max-w-[200px] truncate">{pageName}</strong>
        {previewControls}
        {onOpenDevelopment && <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 px-2" onClick={onOpenDevelopment}><Code2 className="h-4 w-4" />开发应用</Button>}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-muted-foreground"
          aria-label={issueLabel}
          title={issueLabel}
          onClick={onOpenIssues}
        >
          <CircleDot className="h-4 w-4" />
          <span className="hidden sm:inline">Issue</span>
          {issueCount !== null && (
            <span
              data-testid="localapp-open-issue-count"
              data-empty={issueCount === 0}
              className={`min-w-4 text-center text-[11px] font-semibold tabular-nums ${
                issueCount === 0 ? "text-muted-foreground/70" : "text-foreground"
              }`}
            >
              {issueCount}
            </span>
          )}
        </Button>
        {onlineCount !== null && (
          <div className="relative" ref={presenceRef}>
            <button
              type="button"
              className="inline-flex h-7 min-w-12 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              aria-label={`当前在线用户 ${onlineCount} 人`}
              title={`当前在线用户 ${onlineCount} 人`}
              aria-expanded={presenceOpen}
              onClick={() => presenceSnapshot && setPresenceOpen((open) => !open)}
            >
              <Users className="h-4 w-4" />
              <span>{onlineCount}</span>
            </button>
            {presenceOpen && presenceSnapshot && (
              <div className="absolute left-0 top-8 z-50 w-72 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
                <div className="border-b px-3 py-2 text-xs font-medium">当前在线用户</div>
                <div className="max-h-72 overflow-y-auto p-1">
                  {presenceSnapshot.authenticatedUsers.map((onlineUser) => {
                    const display = onlineUser.displayName || onlineUser.name;
                    return (
                      <div key={onlineUser.id} className="flex items-center gap-2 rounded px-2 py-2">
                        {onlineUser.avatarUrl ? (
                          <img src={onlineUser.avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
                        ) : (
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold">
                            {display.charAt(0).toUpperCase()}
                          </span>
                        )}
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{display}</span>
                          {onlineUser.displayName && <span className="block truncate text-xs text-muted-foreground">@{onlineUser.name}</span>}
                        </span>
                      </div>
                    );
                  })}
                  {presenceSnapshot.anonymousCount > 0 && (
                    <div className="px-2 py-2 text-sm text-muted-foreground">匿名访客 {presenceSnapshot.anonymousCount} 人</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
        {editSession && (
          <div className="flex items-center gap-1" data-localapp-edit-session-controls>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label="保存"
              title="保存"
              disabled={editBusy || !editSession.canSave}
              onClick={() => { void editSession.onSave(); }}
            >
              <Save className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label="撤销"
              title="撤销"
              disabled={editBusy || !editSession.canUndo}
              onClick={() => { void editSession.onUndo(); }}
            >
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label="重做"
              title="重做"
              disabled={editBusy || !editSession.canRedo}
              onClick={() => { void editSession.onRedo(); }}
            >
              <Redo2 className="h-4 w-4" />
            </Button>
          </div>
        )}
        {bell}
      </div>

      <div className="flex items-center gap-3" data-testid="localapp-platform-nav-right">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={onToggleFavorite}
          title={isFavorited ? "取消收藏" : "收藏"}
        >
          <Star
            className={`h-4 w-4 ${isFavorited ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`}
          />
          <span className="text-xs">{favCount}</span>
        </Button>

        {aiMode && (
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${aiOpen ? "text-primary" : "text-muted-foreground"}`}
            title="AI 助手"
            onClick={onToggleAI}
          >
            <Sparkles className="h-4 w-4" />
          </Button>
        )}

        {user ? (
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-2 hover:opacity-80">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
              ) : (
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                  {initial}
                </div>
              )}
              <span className="hidden sm:inline max-w-[120px] truncate">{user.displayName || user.name}</span>
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => openLogin()}>
              <LogIn className="h-4 w-4" />
              登录
            </Button>
          </div>
        )}
      </div>
      </div>
      <div className={`h-[3px] ${previewControls ? "bg-sky-400/70" : "bg-gradient-to-r from-indigo-500 via-fuchsia-500 to-orange-400"}`} />
    </nav>
  );
}
