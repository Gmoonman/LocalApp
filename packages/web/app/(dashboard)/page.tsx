"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, Clock, Code2, Copy, Database, Download, Globe, Layers3, Plus, Rocket, ShieldCheck, Sparkles, Star, Terminal } from "lucide-react";
import { useAuthModals } from "@/components/auth-modals/auth-provider";
import { AgentStarterHint } from "@/components/agent-starter-hint";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { CreateApplicationDialog } from "@/components/development/create-application-dialog";
import "./home.css";

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


function ListState({ loading, error, empty }: { loading: boolean; error: boolean; empty: string }) {
  return <p className="home-list-state" role={error ? "alert" : "status"}>{loading ? "加载中…" : error ? "暂时无法加载，请刷新后重试。" : empty}</p>;
}

function LocalDevelopmentGuide() {
  const [copied, setCopied] = useState(false);
  const [availablePlatforms, setAvailablePlatforms] = useState<PlatformInfo[]>([]);
  const [step, setStep] = useState("0");
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const workflow = [
    { title: "安装", command: "npm install -g @patodo/localapp", text: "需要 Node.js 24+；一个包包含 CLI、Server 和平台插件。" },
    { title: "连接", command: `localapp login ${origin} --profile online --api-key <API_KEY>`, text: "连接当前平台，使用你的账户继续开发。" },
    { title: "开发", command: "localapp app pull --profile online --name my-app --directory ./my-app", text: "同步源码到本地，用你熟悉的 Agent 修改。" },
    { title: "上线", command: "localapp app push --profile online --directory ./my-app", text: "上传源码后，在应用内检查、预览并上线；上传不会自动发布。" },
  ];
  useEffect(() => {
    fetch("/api/cli/version").then(r => r.ok ? r.json() : null).then((v: CliVersionInfo | null) => {
      const platforms = v?.versions?.[v.latest]?.platforms;
      if (platforms) setAvailablePlatforms(Object.keys(platforms).map(key => ({ os: key.split("/")[0], arch: key.split("/")[1], label: PLATFORM_LABELS[key] || key })));
    }).catch(() => {});
  }, []);
  return <div className="home-local-guide">
    <div className="home-local-commands">
      <h2><Terminal size={18} /> 本地开发，仍然只需一个包</h2>
      <Tabs value={step} onValueChange={value => { setStep(value); setCopied(false); }}>
        <TabsList aria-label="本地开发流程">{workflow.map((item, i) => <TabsTrigger key={item.title} value={String(i)}>{item.title}</TabsTrigger>)}</TabsList>
        {workflow.map((item, i) => <TabsContent key={item.title} value={String(i)}>
          <p className="home-command-description">{item.text}</p>
          <div className="home-command"><code>{item.command}</code><Button size="icon" variant="ghost" aria-label="复制命令" onClick={async () => { try { await navigator.clipboard.writeText(item.command); setCopied(true); } catch { setCopied(false); } }}>{copied ? <Check size={16}/> : <Copy size={16}/>}</Button></div>
        </TabsContent>)}
      </Tabs>
      {availablePlatforms.length > 0 && <div className="home-downloads">{availablePlatforms.map(p => <Button size="sm" variant="ghost" asChild key={p.label}><a href={`/api/cli/download?os=${p.os}&arch=${p.arch}`}><Download size={14}/>{p.label}</a></Button>)}</div>}
    </div>
    <div className="home-agent-guide"><AgentStarterHint compact /></div>
  </div>;
}

function LocalDevelopmentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-4xl"><DialogTitle>在自己的电脑上开发</DialogTitle><DialogDescription>下载托管源码，用熟悉的工具修改，再同步回平台。</DialogDescription><LocalDevelopmentGuide /></DialogContent></Dialog>;
}

function PublicHome() {
  const { openLogin } = useAuthModals();
  const [homeStats, setHomeStats] = useState<HomeStats | null>(null);
  useEffect(() => { fetch("/api/home/stats").then(r => r.json()).then(b => { if (b.success) setHomeStats(b.data); }).catch(() => {}); }, []);
  return <main className="home-public">
    <nav aria-label="首页导航" className="home-public-nav"><Link className="home-brand" href="/"><Layers3 size={25}/><span>LocalApp</span></Link><div className="flex items-center gap-3"><Button variant="ghost" asChild><Link href="/market">应用市场</Link></Button><Button variant="outline" onClick={() => openLogin()}>登录<ArrowRight size={16}/></Button></div></nav>
    <section className="home-public-hero">
      <div className="home-public-copy"><p className="home-intro">属于你的应用，与你一起成长</p><h1>把你的想法，<br/>变成每天用的应用。</h1><p className="home-lead">和 Agent 一起开发，边看边改。<br/>准备好之后，让团队直接打开使用。</p><div className="home-hero-actions"><Button size="lg" onClick={() => openLogin()}><Plus size={18}/>创建你的应用</Button><Button size="lg" variant="ghost" asChild><Link href="/market">探索应用市场<ArrowUpRight size={16}/></Link></Button></div><p className="home-small-note">使用自己的模型供应商，保留完整应用源码。</p></div>
      <div className="home-product-scene" aria-label="从需求到应用的开发流程"><div className="home-scene-header"><Layers3 size={18}/><span>你的下一个应用</span><Badge variant="secondary">开发预览</Badge></div><div className="home-scene-board"><h2>团队工作项</h2><div className="home-board-columns">{["待处理", "进行中", "已完成"].map((label, i) => <div key={label}><span>{label}<span className="home-board-count">{[3, 2, 5][i]}</span></span><div className="home-board-item"><span className="home-board-line"/><span className="home-board-line short"/><span className="home-board-dot"/></div>{i !== 1 && <div className="home-board-item quiet"><span className="home-board-line"/><span className="home-board-line short"/></div>}</div>)}</div></div><div className="home-scene-conversation"><Sparkles size={18}/><p>“做一个团队工作项看板。”<span>描述需求，和 Agent 一起把应用做出来。</span></p><span className="home-scene-send"><ArrowRight size={18}/></span></div><div className="home-scene-footer"><span><Code2 size={14}/>在线修改</span><span><Globe size={14}/>实时预览</span><span><Rocket size={14}/>一键上线</span></div></div>
    </section>
    <section className="home-benefits" aria-label="平台能力">{[{ icon: Code2, title: "源码在你手里", text: "在线开发，也能同步到本地。" }, { icon: Database, title: "专注应用本身", text: "账户、数据、文件和协作，由平台提供。" }, { icon: ShieldCheck, title: "每个人各有空间", text: "分别配置模型、工具和 Skills。" }].map(({icon: Icon,title,text})=><div key={title}><Icon size={21}/><div><h2>{title}</h2><p>{text}</p></div></div>)}</section>
    <section className="home-public-local" aria-label="本地开发"><LocalDevelopmentGuide /></section>
    <footer className="home-footer"><span>LocalApp · 从想法到应用</span><div className="home-public-stats">{[["已发布应用",homeStats?.pages],["平台成员",homeStats?.users]].map(([label,value])=><span key={label}><strong>{value == null ? "—" : new Intl.NumberFormat("zh-CN").format(Number(value))}</strong>{label}</span>)}</div><Link href="/starter.md">开发指南<ArrowUpRight size={14}/></Link></footer>
  </main>;
}

function DashboardHome({ user }: { user: UserData }) {
  const [creating, setCreating] = useState(false);
  const [localGuide, setLocalGuide] = useState(false);
  const initial = {data: [],loading: true,error: false};
  const [apps, setApps] = useState<LoadState<AppItem>>(initial);
  const [favorites, setFavorites] = useState<LoadState<FavoriteItem>>(initial);
  const [recent, setRecent] = useState<LoadState<RecentItem>>(initial);
  useEffect(() => {
    loadList<AppItem>("/api/me/pages?limit=8").then(data=>setApps({data,loading:false,error:false})).catch(()=>setApps({data:[],loading:false,error:true}));
    loadList<FavoriteItem>("/api/me/favorites?limit=5").then(data=>setFavorites({data,loading:false,error:false})).catch(()=>setFavorites({data:[],loading:false,error:true}));
    loadList<RecentItem>("/api/me/recent?limit=5").then(data=>setRecent({data,loading:false,error:false})).catch(()=>setRecent({data:[],loading:false,error:true}));
  }, []);
  const displayName=user.displayName || user.name || "朋友";
  return <div className="home-dashboard">
    <CreateApplicationDialog open={creating} onOpenChange={setCreating}/><LocalDevelopmentDialog open={localGuide} onOpenChange={setLocalGuide}/>
    <header className="home-dashboard-header"><div><p>欢迎回来，{displayName}</p><h1>你的应用工作台</h1></div><div className="home-header-actions"><Button variant="ghost" onClick={()=>setLocalGuide(true)}><Terminal size={16}/>本地开发</Button><Button variant="outline" asChild><Link href="/my/apps">管理应用<ArrowUpRight size={15}/></Link></Button></div></header>
    <section className="home-launch" aria-label="开始开发"><div className="home-launch-copy"><span className="home-launch-label"><Sparkles size={17}/>和 Agent 一起构建</span><h2>下一个想法，从这里开始。</h2><p>描述你想做的应用，边对话边预览，准备好就上线。</p><div className="home-hero-actions"><Button size="lg" onClick={()=>setCreating(true)}><Plus size={18}/>创建应用</Button><Button size="lg" variant="ghost" asChild><Link href="/market">逛逛应用市场<ArrowUpRight size={16}/></Link></Button></div></div><div className="home-launch-flow" aria-label="开发流程">{[{icon:Sparkles,title:"描述需求",text:"说清楚你想解决的问题"},{icon:Code2,title:"边看边改",text:"在应用中继续开发"},{icon:Rocket,title:"发布应用",text:"检查完成，分享给团队"}].map(({icon:Icon,title,text},i)=><div key={title}><span className="home-flow-number">{i+1}</span><div><strong>{title}</strong><p>{text}</p></div><Icon size={18}/></div>)}</div></section>
    <section className="home-app-section" aria-label="我的应用"><div className="home-section-header"><h2>我的应用<Badge variant="secondary">{apps.loading ? "…" : apps.data.length}</Badge></h2><Button variant="ghost" size="sm" asChild><Link href="/my/apps">查看全部<ArrowRight size={14}/></Link></Button></div>
      {apps.loading || apps.error || apps.data.length===0 ? <div className="home-app-empty"><ListState loading={apps.loading} error={apps.error} empty="还没有应用。创建第一个，让 Agent 帮你实现想法。"/>{!apps.loading&&!apps.error&&<Button variant="outline" onClick={()=>setCreating(true)}><Plus size={16}/>创建第一个应用</Button>}</div> : <div className="home-app-grid">{apps.data.slice(0,8).map((app,i)=><Card key={app.name} className="home-app-card"><CardContent className="p-0"><Link aria-label={`打开 ${app.name}`} href={`/${user.name}/${app.name}`} prefetch={false} className="home-app-link"><span className="home-app-icon" data-color={i%4}><Globe size={21}/></span><div><h3 title={app.name}>{app.name}</h3><p>v{app.currentVersion}<span>更新于 {relativeTime(app.updatedAt)}</span></p></div><ArrowUpRight size={17} className="home-app-arrow"/></Link></CardContent></Card>)}</div>}
    </section>
    <div className="home-collections">{[{title:"最近访问",icon:Clock,href:"/my/recent",state:recent,items:recent.data.slice(0,5).map(item=>({path:item.pagePath,name:item.pagePath.replace(/^\//,"").split("/").at(-1)||item.pagePath,owner:item.pagePath.replace(/^\//,"").split("/")[0],date:item.lastVisitedAt})),empty:"还没有访问记录。打开一个应用，它会出现在这里。"},{title:"收藏应用",icon:Star,href:"/my/favorites",state:favorites,items:favorites.data.slice(0,5).map(item=>({path:item.pagePath,name:item.pageName||item.pagePath.replace(/^\//,"").split("/").at(-1)||item.pagePath,owner:item.ownerName||item.pagePath.replace(/^\//,"").split("/")[0],date:item.createdAt})),empty:"把常用应用加入收藏，下次更快找到。"}].map(({title,icon:Icon,href,state,items,empty})=><section key={title} className="home-collection"><div className="home-section-header"><h2><Icon size={17}/>{title}</h2><Button variant="ghost" size="sm" asChild><Link href={href}>查看全部<ArrowRight size={14}/></Link></Button></div>{state.loading||state.error||items.length===0?<ListState loading={state.loading} error={state.error} empty={empty}/>:<div className="home-collection-list">{items.map(item=><Link key={item.path} prefetch={false} href={item.path.startsWith("/")?item.path:`/${item.path}`} className="home-collection-link"><span className="home-list-icon"><Globe size={16}/></span><div><span title={item.name}>{item.name}</span><small>{item.owner.startsWith("preview")?"开发预览":item.owner}</small></div><time>{relativeTime(item.date)}</time><ArrowUpRight size={14}/></Link>)}</div>}</section>)}</div>
    <footer className="home-footer"><span>你的模型，你的源码，你的应用。</span><Button variant="link" size="sm" onClick={()=>setLocalGuide(true)}>使用外部 Agent 开发<ArrowUpRight size={14}/></Button></footer>
  </div>;
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
