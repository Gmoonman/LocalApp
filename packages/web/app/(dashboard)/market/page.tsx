"use client";
import {useEffect,useState} from "react";
import Link from "next/link";
import {Search,Store,ChevronLeft,ChevronRight,Package} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Card,CardContent} from "@/components/ui/card";
import {Badge} from "@/components/ui/badge";
interface Application {userId:string;name:string;description:string;currentVersion:number;updatedAt:string}
export default function ApplicationMarket(){
 const [query,setQuery]=useState(""),[page,setPage]=useState(1),[apps,setApps]=useState<Application[]>([]),[total,setTotal]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError(false);
  const timer=setTimeout(()=>{
   fetch(`/api/market/apps?${new URLSearchParams({q:query,page:String(page),limit:"24"})}`,{credentials:"include",signal:controller.signal})
    .then(async response=>{if(!response.ok)throw Error();const result=await response.json();if(!result.success)throw Error();return result.data;})
    .then(data=>{setApps(data.apps);setTotal(data.total);})
    .catch(()=>{if(!controller.signal.aborted)setError(true);})
    .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  },200);
  return ()=>{clearTimeout(timer);controller.abort();};
 },[query,page,retry]);
 const pages=Math.max(1,Math.ceil(total/24));
 return <main className="mx-auto max-w-6xl space-y-8">
  <header className="space-y-3"><div className="inline-flex items-center gap-2 text-sm text-muted-foreground"><Store className="size-4"/>发现与使用</div><h1 className="text-3xl font-semibold tracking-tight">应用市场</h1><p className="text-muted-foreground">浏览所有你可以访问的已上线应用，找到适合你的工具。</p></header>
  <div className="relative max-w-xl"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"/><Input aria-label="搜索应用" placeholder="搜索应用名称、说明或发布者…" className="h-11 pl-10" value={query} onChange={event=>{setQuery(event.target.value);setPage(1);}}/></div>
  {loading?<p role="status" className="py-12 text-center text-muted-foreground">正在加载应用…</p>:error?<Card><CardContent className="space-y-4 py-12 text-center"><p role="alert">应用加载失败，请重试。</p><Button variant="outline" onClick={()=>setRetry(value=>value+1)}>重试</Button></CardContent></Card>:<>
   <div className="flex items-center justify-between text-sm text-muted-foreground"><span>{query?"搜索结果":"全部应用"} · {total} 个</span><span>按最近更新排序</span></div>
   {apps.length===0?<Card><CardContent className="flex flex-col items-center gap-3 py-16"><Package className="size-8 text-muted-foreground"/><h2 className="font-medium">{query?"没有找到匹配的应用":"暂无可访问的应用"}</h2><p className="text-sm text-muted-foreground">{query?"试试其他关键词。":"应用上线后会出现在这里。"}</p>{query&&<Button variant="outline" onClick={()=>{setQuery("");setPage(1);}}>清空搜索</Button>}</CardContent></Card>:<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{apps.map(app=><Link key={`${app.userId}/${app.name}`} href={`/${encodeURIComponent(app.userId)}/${encodeURIComponent(app.name)}/`} aria-label={`打开 ${app.name}`} className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"><Card className="h-full transition-colors group-hover:border-primary/40 group-hover:bg-accent/30"><CardContent className="flex h-full flex-col gap-3 p-4"><div className="flex items-center gap-2"><div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Package className="size-4"/></div><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold" title={app.name}>{app.name}</h2><p className="mt-0.5 truncate text-xs text-muted-foreground" title={app.userId}>{app.userId}</p></div><Badge variant="secondary" className="shrink-0">v{app.currentVersion}</Badge></div><p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{app.description||"发布者暂未添加说明。"}</p></CardContent></Card></Link>)}</div>}
   {pages>1&&<nav aria-label="应用市场分页" className="flex items-center justify-center gap-4"><Button variant="outline" size="sm" disabled={page<=1} onClick={()=>setPage(value=>value-1)}><ChevronLeft className="size-4"/>上一页</Button><span className="text-sm text-muted-foreground">{page} / {pages}</span><Button variant="outline" size="sm" disabled={page>=pages} onClick={()=>setPage(value=>value+1)}>下一页<ChevronRight className="size-4"/></Button></nav>}
  </>}
 </main>;
}
