"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Clock,
  Code2,
  Copy,
  Database,
  Download,
  Globe,
  Layers3,
  Package,
  Plus,
  Rocket,
  ShieldCheck,
  Sparkles,
  Star,
  Terminal,
} from "lucide-react";
import { useAuthModals } from "@/components/auth-modals/auth-provider";
import { AgentStarterHint } from "@/components/agent-starter-hint";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CreateApplicationDialog } from "@/components/development/create-application-dialog";

interface UserData {
  id: string;
  name: string;
  displayName?: string | null;
}

interface AppItem {
  name: string;
  currentVersion: number;
  updatedAt: string;
}

interface FavoriteItem {
  pagePath: string;
  pageName: string | null;
  ownerName: string | null;
  createdAt: string;
}

interface RecentItem {
  pagePath: string;
  lastVisitedAt: string;
}

type LoadState<T> = {
  data: T[];
  loading: boolean;
  error: boolean;
};

interface CliVersionInfo {
  latest: string;
  min: string;
  versions: Record<string, { platforms: Record<string, string> }>;
}

type PlatformInfo = { os: string; arch: string; label: string };

const PLATFORM_LABELS: Record<string, string> = {
  "windows/x86_64": "Windows x64",
  "linux/x86_64": "Linux x64",
  "macos/aarch64": "macOS ARM",
  "macos/x86_64": "macOS x64",
};

interface HomeStats {
  users: number;
  pages: number;
  schemas: number;
  deploys: number;
  monthDeploys: number;
}

function relativeTime(dateStr: string): string {
  const time = new Date(dateStr).getTime();
  if (Number.isNaN(time)) return "刚刚";

  const diff = Date.now() - time;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

async function loadList<T>(url: string): Promise<T[]> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(body.error || "请求失败");
  }
  return body.data ?? [];
}

function appTitleFromPath(path: string): string {
  return path.replace(/^\//, "").split("/").join(" / ");
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
      加载中...
    </div>
  );
}

function PublicHome() {
  const { openLogin } = useAuthModals();
  const [copied, setCopied] = useState(false);
  const [homeStats, setHomeStats] = useState<HomeStats | null>(null);
  const [availablePlatforms, setAvailablePlatforms] = useState<PlatformInfo[]>(
    [],
  );
  const [step, setStep] = useState("0");
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const workflow = [
    {
      title: "安装",
      command: "npm install -g @patodo/localapp",
      text: "需要 Node.js 24+；一个包包含 CLI、Server 和平台插件。",
    },
    {
      title: "连接",
      command: `localapp login ${origin} --profile online --api-key <API_KEY>`,
      text: "连接当前平台，使用你的账户继续开发。",
    },
    {
      title: "开发",
      command: "localapp app pull --profile online --name my-app --directory ./my-app",
      text: "下载已托管的源码到新目录，用熟悉的 Agent 编辑；本地预览可启动 localapp server。",
    },
    {
      title: "上线",
      command: "localapp app push --profile online --directory ./my-app",
      text: "上传源码后，回到应用开发者模式检查、预览并点击上线；上传不会自动发布。",
    },
  ];
  useEffect(() => {
    fetch("/api/home/stats")
      .then((r) => r.json())
      .then((b) => {
        if (b.success) setHomeStats(b.data);
      })
      .catch(() => {});
    fetch("/api/cli/version")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: CliVersionInfo | null) => {
        const platforms = v?.versions?.[v.latest]?.platforms;
        if (platforms)
          setAvailablePlatforms(
            Object.keys(platforms).map((key) => ({
              os: key.split("/")[0],
              arch: key.split("/")[1],
              label: PLATFORM_LABELS[key] || key,
            })),
          );
      })
      .catch(() => {});
  }, []);
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <nav
          aria-label="首页导航"
          className="flex h-20 items-center justify-between border-b"
        >
          <Link
            href="/"
            className="flex items-center gap-3 font-semibold tracking-tight"
          >
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Layers3 size={20} />
            </span>
            <span className="text-lg">LocalApp</span>
          </Link>
          <Button variant="outline" onClick={() => openLogin()}>
            登录 <ArrowRight size={16} />
          </Button>
        </nav>
        <section className="grid items-center gap-12 py-16 md:grid-cols-2 md:py-24">
          <div>
            <Badge
              variant="secondary"
              className="mb-6 gap-2 rounded-full px-3 py-1"
            >
              <Sparkles size={14} /> 和 Agent 一起构建
            </Badge>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              把你的想法，
              <br />
              <span className="text-primary">变成每天用的应用。</span>
            </h1>
            <p className="mt-6 max-w-md text-base leading-8 text-muted-foreground">
              说说你想解决什么问题。和 Agent
              一起开发，边看边改，再把应用分享给你的团队。
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" onClick={() => openLogin()}>
                <Plus size={18} /> 创建你的应用
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="#local-development">
                  本地开发 <Terminal size={16} />
                </a>
              </Button>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              使用自己配置的模型供应商，保留应用源码。
            </p>
          </div>
          <div className="rounded-3xl border bg-muted/30 p-5 sm:p-7">
            <div className="mb-6 flex items-center justify-between">
              <span className="text-sm font-medium">从第一句话开始</span>
              <span className="flex gap-1.5" aria-hidden="true">
                <i className="size-2 rounded-full bg-border" />
                <i className="size-2 rounded-full bg-border" />
                <i className="size-2 rounded-full bg-border" />
              </span>
            </div>
            <div className="space-y-3">
              {[
                {
                  icon: Sparkles,
                  title: "描述你的需求",
                  text: "“做一个团队工作项看板。”",
                },
                {
                  icon: Code2,
                  title: "看着应用成形",
                  text: "在应用里对话、修改，随时查看效果。",
                },
                {
                  icon: Rocket,
                  title: "准备好，就上线",
                  text: "完成检查，让团队直接打开使用。",
                },
              ].map(({ icon: Icon, title, text }, index) => (
                <Card key={title} className="rounded-2xl shadow-none">
                  <CardContent className="flex items-start gap-4 p-5">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon size={19} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{title}</p>
                      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                        {text}
                      </p>
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      0{index + 1}
                    </span>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>
        <section
          aria-label="平台概况"
          className="grid grid-cols-2 gap-6 border-y py-7 sm:grid-cols-4"
        >
          {[
            ["已发布应用", homeStats?.pages],
            ["平台成员", homeStats?.users],
            ["累计部署", homeStats?.deploys],
            ["本月部署", homeStats?.monthDeploys],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="text-2xl font-semibold tabular-nums">
                {value == null
                  ? "—"
                  : new Intl.NumberFormat("zh-CN").format(Number(value))}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </section>
        <section className="grid gap-8 py-14 sm:grid-cols-3">
          {[
            {
              icon: Code2,
              title: "源码在你手里",
              text: "在线开发，也能同步到本地，用熟悉的工具继续。",
            },
            {
              icon: Database,
              title: "专注应用本身",
              text: "账户、数据、文件和协作，由平台提供。",
            },
            {
              icon: ShieldCheck,
              title: "每个人各有空间",
              text: "按用户和应用选择模型、工具与 Skills。",
            },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title}>
              <Icon size={22} className="mb-4 text-primary" />
              <h2 className="text-sm font-semibold">{title}</h2>
              <p className="mt-2 text-sm leading-7 text-muted-foreground">
                {text}
              </p>
            </div>
          ))}
        </section>
        <section
          id="local-development"
          className="mb-12 rounded-2xl border bg-muted/20 p-6 sm:p-8"
        >
          <div className="mb-6">
            <p className="mb-2 text-xs font-medium text-primary">
              也可以在自己的电脑上开发
            </p>
            <h2 className="text-xl font-semibold">你的工具，你的开发方式。</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              连接平台后，在本地使用 CLI 或你熟悉的 Agent。
            </p>
          </div>
          <Tabs
            value={step}
            onValueChange={(value) => {
              setStep(value);
              setCopied(false);
            }}
          >
            <TabsList className="w-full sm:w-auto">
              {workflow.map((item, i) => (
                <TabsTrigger
                  className="flex-1"
                  key={item.title}
                  value={String(i)}
                >
                  {item.title}
                </TabsTrigger>
              ))}
            </TabsList>
            {workflow.map((item, i) => (
              <TabsContent value={String(i)} key={item.title}>
                <p className="mb-3 text-sm text-muted-foreground">
                  {item.text}
                </p>
                <div className="flex flex-col gap-3 rounded-xl border bg-background p-4 sm:flex-row sm:items-center">
                  <code className="min-w-0 flex-1 break-all text-sm">
                    {item.command}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="复制命令"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(item.command);
                        setCopied(true);
                      } catch {
                        setCopied(false);
                      }
                    }}
                  >
                    {copied ? <Check size={15} /> : <Copy size={15} />}{" "}
                    {copied ? "已复制" : "复制"}
                  </Button>
                </div>
              </TabsContent>
            ))}
          </Tabs>
          {availablePlatforms.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2">
              {availablePlatforms.map((p) => (
                <Button variant="outline" size="sm" asChild key={p.label}>
                  <a href={`/api/cli/download?os=${p.os}&arch=${p.arch}`}>
                    <Download size={15} /> {p.label}
                  </a>
                </Button>
              ))}
            </div>
          )}
          <div className="mt-6 border-t pt-5">
            <AgentStarterHint compact />
          </div>
        </section>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t py-6 text-xs text-muted-foreground">
          <span>LocalApp · 从想法到应用</span>
          <Button variant="link" size="sm" asChild>
            <a href="/starter.md">
              开发指南 <ArrowRight size={14} />
            </a>
          </Button>
        </footer>
      </div>
    </main>
  );
}

function DashboardHome({ user }: { user: UserData }) {
  const [creating, setCreating] = useState(false);
  const [apps, setApps] = useState<LoadState<AppItem>>({
    data: [],
    loading: true,
    error: false,
  });
  const [favorites, setFavorites] = useState<LoadState<FavoriteItem>>({
    data: [],
    loading: true,
    error: false,
  });
  const [recent, setRecent] = useState<LoadState<RecentItem>>({
    data: [],
    loading: true,
    error: false,
  });

  useEffect(() => {
    loadList<AppItem>("/api/me/pages?limit=8")
      .then((data) => setApps({ data, loading: false, error: false }))
      .catch(() => setApps({ data: [], loading: false, error: true }));

    loadList<FavoriteItem>("/api/me/favorites?limit=5")
      .then((data) => setFavorites({ data, loading: false, error: false }))
      .catch(() => setFavorites({ data: [], loading: false, error: true }));

    loadList<RecentItem>("/api/me/recent?limit=5")
      .then((data) => setRecent({ data, loading: false, error: false }))
      .catch(() => setRecent({ data: [], loading: false, error: true }));
  }, []);

  const displayName = user.displayName || user.name || "朋友";

  return (
    <div className="space-y-8">
      <CreateApplicationDialog open={creating} onOpenChange={setCreating} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-normal">
            欢迎回来，{displayName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            从这里继续管理、访问和回看你的应用。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/my/apps">管理应用</Link>
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} />
            创建应用
          </Button>
        </div>
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">我的应用</h2>
            {apps.data.length > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {apps.data.length}
              </span>
            )}
          </div>
          <Link
            href="/my/apps"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            查看全部 <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        {apps.loading ? (
          <LoadingState />
        ) : apps.error ? (
          <EmptyState>应用列表暂时加载失败。</EmptyState>
        ) : apps.data.length === 0 ? (
          <EmptyState>
            <div className="space-y-4">
              <p>
                暂无应用。使用{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  localapp init
                </code>{" "}
                创建第一个应用， 或者直接把下面这句话发给你的 AI Agent：
              </p>
              <AgentStarterHint compact />
            </div>
          </EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {apps.data.map((app) => (
              <Link
                key={app.name}
                href={`/${user.name}/${app.name}`}
                prefetch={false}
                className="group rounded-2xl border bg-card p-5 transition-all hover:border-primary/30 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="mb-5 flex size-11 items-center justify-center rounded-xl bg-primary/10">
                  <Globe className="h-4 w-4 text-primary" />
                </div>
                <p className="truncate text-sm font-medium">{app.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  v{app.currentVersion} · 更新于 {relativeTime(app.updatedAt)}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Star className="h-4 w-4 text-amber-500" />
              <h2 className="text-sm font-semibold">收藏应用</h2>
            </div>
            <Link
              href="/my/favorites"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              查看全部 <ArrowRight className="h-3 w-3" />
            </Link>
          </div>

          {favorites.loading ? (
            <LoadingState />
          ) : favorites.error ? (
            <EmptyState>收藏应用暂时加载失败。</EmptyState>
          ) : favorites.data.length === 0 ? (
            <EmptyState>暂无收藏应用。</EmptyState>
          ) : (
            <div className="divide-y rounded-lg border bg-card">
              {favorites.data.map((favorite) => (
                <Link
                  key={favorite.pagePath}
                  prefetch={false}
                  href={
                    favorite.pagePath.startsWith("/")
                      ? favorite.pagePath
                      : `/${favorite.pagePath}`
                  }
                  className="flex items-center justify-between gap-3 px-4 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-accent/50"
                >
                  <span className="truncate text-sm">
                    {favorite.pageName || appTitleFromPath(favorite.pagePath)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relativeTime(favorite.createdAt)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">最近访问</h2>
            </div>
            <Link
              href="/my/recent"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              查看全部 <ArrowRight className="h-3 w-3" />
            </Link>
          </div>

          {recent.loading ? (
            <LoadingState />
          ) : recent.error ? (
            <EmptyState>最近访问暂时加载失败。</EmptyState>
          ) : recent.data.length === 0 ? (
            <EmptyState>暂无最近访问记录。</EmptyState>
          ) : (
            <div className="divide-y rounded-lg border bg-card">
              {recent.data.map((item) => (
                <Link
                  key={item.pagePath}
                  prefetch={false}
                  href={
                    item.pagePath.startsWith("/")
                      ? item.pagePath
                      : `/${item.pagePath}`
                  }
                  className="flex items-center justify-between gap-3 px-4 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-accent/50"
                >
                  <span className="truncate text-sm">
                    {appTitleFromPath(item.pagePath)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relativeTime(item.lastVisitedAt)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [user, setUser] = useState<UserData | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    fetch("/api/me", { credentials: "include" })
      .then((response) => response.json())
      .then((body) => {
        setUser(body.success && body.data ? body.data : null);
      })
      .catch(() => setUser(null))
      .finally(() => setCheckingSession(false));
  }, []);

  if (checkingSession) return null;
  if (!user) return <PublicHome />;
  return <DashboardHome user={user} />;
}
