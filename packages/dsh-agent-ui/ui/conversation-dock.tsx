"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ScanLine,
  ArrowUp,
  Minus,
  CircleAlert,
  UserRound,
  ArrowLeftRight,
  Settings,
  Square,
  Maximize2,
  Minimize2,
  Plus,
  ChevronDown,
  Code2,
  Hammer,
  Eye,
  Rocket,
  LoaderCircle,
  GitCompareArrows,
  FolderUp,
  Paperclip,
  X,
  MessageSquare,
  Check,
} from "lucide-react";
import type { NativeComposerPort, NativeAttachment } from "./native-conversation-frame";
import type { DevelopmentShellProps } from "./conversation-types";
import type { HarnessAgent } from "@localapp/sdk-agent/harness-client";
import type { JSXElementConstructor, TextareaHTMLAttributes } from "react";
import "./conversation-dock.css";
interface NativeSelection { sessionId: string; title: string; running: boolean }
interface NativeCatalogEntry { id: string; title: string; updatedAt: number; pinned?: boolean }
export interface DockComponents {
  renderPortal?: (content: ReactNode, target: Element) => ReactNode;
  DevelopmentDelivery?: JSXElementConstructor<{value:DevelopmentShellProps}>;
  markPage?: () => Promise<unknown>;
  clearPage?: () => Promise<unknown>;
  activatePage?: (projectId:string) => Promise<void>;
  // Host shadcn components accept library-specific presentation props.
  Button: JSXElementConstructor<any>;
  Textarea: JSXElementConstructor<TextareaHTMLAttributes<HTMLTextAreaElement> & React.RefAttributes<HTMLTextAreaElement>>;
  Select: JSXElementConstructor<any>;
  SelectContent: JSXElementConstructor<any>;
  SelectItem: JSXElementConstructor<any>;
  SelectTrigger: JSXElementConstructor<any>;
  SelectValue: JSXElementConstructor<any>;
  DropdownMenu: JSXElementConstructor<any>;
  DropdownMenuTrigger: JSXElementConstructor<any>;
  DropdownMenuContent: JSXElementConstructor<any>;
  DropdownMenuRadioGroup: JSXElementConstructor<any>;
  DropdownMenuRadioItem: JSXElementConstructor<any>;
  DropdownMenuItem: JSXElementConstructor<any>;
  DshMarkdown: JSXElementConstructor<{text: string}>;
  DshDiff: JSXElementConstructor<{changes: any[]}>;
  DshTerminal: JSXElementConstructor<{command: string; output: string; running?: boolean}>;
  DevelopmentAgentSettings: JSXElementConstructor<{projectId: string}>;
  NativeConversationFrame: JSXElementConstructor<{
    providerId: string; sessionId?: string; newSession?: number;
    onRunningSeat?: (seat: HTMLElement | null) => void;
    onAttachments?: (files: NativeAttachment[]) => void;
    onComposerReady?: (port: NativeComposerPort | null) => void;
    onCatalog?: (rows: NativeCatalogEntry[]) => void;
    onSelection?: (selection: NativeSelection | null) => void;
  } & ({identity: "user"; applicationId: string; agent: HarnessAgent} | {identity: "developer"; projectId: string})>;
}
export interface DockIdentityProps {
  nativeUserAgent?: HarnessAgent;
  userConversationEnabled?: boolean;
  identity?: "developer" | "user";
  onPreview?: (url: string | null) => void;
  onIdentityChange?: (identity: "developer" | "user") => void;
  userConversation?: DevelopmentShellProps;
  reveal?: number;
  userInteractions?: ReactNode;
  minimize?: number;
  onVisibilityChange?: (visible: boolean) => void;
}
export function createConversationDock(components: DockComponents) {
const { DevelopmentDelivery, renderPortal, markPage, clearPage, activatePage, Button, Textarea, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuItem,
  DshMarkdown, DshDiff, DshTerminal, DevelopmentAgentSettings, NativeConversationFrame } = components;
return function AppDevelopmentDock(
  input: DevelopmentShellProps & DockIdentityProps & {
    application?: { owner: string; name: string };
    importSource?: (files: Record<string, string>) => Promise<void>;
  },
) {
  const userMode = input.identity === "user";
  const p = userMode && input.userConversation ? { ...input, ...input.userConversation } : input;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {if (input.application && new URLSearchParams(window.location.search).get("creation")) setExpanded(true);}, []);
  const [minimized, setMinimized] = useState(false);
  useEffect(() => { input.onVisibilityChange?.(!minimized); }, [minimized, input.onVisibilityChange]);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyTrigger = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<"chat" | "changes" | "build" | "delivery">("chat");
  const nativeComposer = useRef<NativeComposerPort | null>(null);
  const [pageSelection,setPageSelection]=useState<{label:string; image?:string; fileName?:string}|null>(null);
  const [marking,setMarking]=useState(false);
  const [nativeAttachments,setNativeAttachments] = useState<NativeAttachment[]>([]);
  const [runningSeat,setRunningSeat]=useState<HTMLElement|null>(null);
  const [nativeSubmitting, setNativeSubmitting] = useState(false);
  const [nativeCommandError, setNativeCommandError] = useState("");
  const error = p.error || nativeCommandError;
  const [nativeSelection,setNativeSelection]=useState<NativeSelection|null>(null);
  const [nativeSession,setNativeSession]=useState<string|undefined>();
  const [nativeNew,setNativeNew]=useState(0);
  const [nativeHistory,setNativeHistory]=useState<DevelopmentShellProps["sessions"]|null>(null);
  const running=p.running||!!nativeSelection?.running;
  const nativeEnabled=!!input.application&&!!p.project&&!!p.provider&&(!userMode||!!input.nativeUserAgent);
  useEffect(()=>{setNativeSelection(null);setNativeSession(undefined);setNativeNew(0);setNativeHistory(null);setNativeCommandError("");setNativeAttachments([]);setPageSelection(null);},[input.identity,p.project?.id,p.provider]);
  const sendDraft = async () => {
    setPanel("chat");
    if (!nativeEnabled) {p.actions.run(); return;}
    const receipts=p.attachments??[];
    if(receipts.some(file=>!file.path||!file.path.startsWith(`.localapp-attachments/${file.id}/`)||file.path.split("/").some(part=>part===".."||part==="."))){
      setNativeCommandError("附件缺少工作区路径，请移除后重新上传");return;
    }
    if (nativeSubmitting || marking) return;
    const port = nativeComposer.current;
    if (!port) {setNativeCommandError("原生会话尚未就绪"); return;}
    const submitted = p.prompt + (pageSelection ? `\n[页面${pageSelection.image?"截图":"标记"}：${pageSelection.label}${pageSelection.image?"":"。可通过 get_current_page 获取元素位置与页面上下文"}]` : "");
    setNativeCommandError("");setNativeSubmitting(true);
    try {
      if(!userMode&&p.project)await activatePage?.(p.project.id);
      await port.request("submit", submitted+receipts.map(file=>`\n用户上传文件：${JSON.stringify(file.name)}，工作区文件路径：${JSON.stringify(file.path)}`).join(""));
      if (nativeComposer.current === port) {p.actions.setPrompt("");setPageSelection(null);receipts.forEach(file=>p.actions.removeAttachment?.(file.id));}
    } catch (error) {
      if (nativeComposer.current === port) setNativeCommandError(error instanceof Error ? error.message : String(error));
    } finally {setNativeSubmitting(false);}
  };
  const history=nativeEnabled&&nativeHistory?nativeHistory:p.sessions;
  const selectedSession=nativeEnabled&&nativeSelection?nativeSelection.sessionId:p.selectedSession;
  useEffect(()=>setPageSelection(null),[selectedSession]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const transcript = useRef<HTMLDivElement>(null);
  const sourceInput = useRef<HTMLInputElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const draft = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (running && panel === "chat")
      transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [p.live, p.messages, running, panel]);
  useEffect(() => {
    if (!draft.current) return;
    draft.current.style.height = "auto";
    draft.current.style.height =
      Math.min(draft.current.scrollHeight, 160) + "px";
  }, [p.prompt]);
  const conversationTitle = nativeSelection?.title || p.sessions.find(item => item.id === p.selectedSession)?.title || (p.selectedSession ? "未命名对话" : "新对话");
  useEffect(() => {
    if (input.reveal) { setMinimized(false); setExpanded(true); setPanel("chat"); }
  }, [input.reveal]);
  useEffect(() => { if (input.minimize) setMinimized(true); }, [input.minimize]);
  useEffect(() => { setPanel("chat"); }, [input.identity]);
  const switchIdentity = input.onIdentityChange ? (
    <Button variant="outline" size="sm" type="button" className="dock-identity"
      disabled={running || p.pending || !!input.userConversation?.running || !!input.running || ["queued", "running"].includes(input.build?.status)}
      aria-label="切换对话身份" title={userMode ? "切换为开发者模式" : "切换为用户模式"}
      onClick={() => input.onIdentityChange?.(userMode ? "developer" : "user")}>
      {userMode ? <UserRound size={15} /> : <Code2 size={15} />}
      {userMode ? "用户模式" : "开发者模式"}<ArrowLeftRight size={13} />
    </Button>
  ) : null;
  const building = ["queued", "running"].includes(p.build?.status);
  const ready = p.build?.status === "succeeded";
  const working = running || building || importing;
  let finalReply = "";
  for (let i = p.messages.length - 1; i >= 0; i--) {
    const message = p.messages[i];
    if (message.role === "user") break;
    if (message.role !== "assistant") continue;
    if (
      Array.isArray(message.content) &&
      message.content.some(
        (block: any) => block.type === "toolCall" || block.type === "tool-call",
      )
    )
      continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text ?? "")
            .join("\n");
    if (text.trim()) {
      finalReply = text;
      break;
    }
  }
  const completion = error || (working ? "" : p.live || finalReply);
  async function importDirectory(list: FileList | null) {
    if (!list?.length || !p.importSource) return;
    setImportError("");
    setImporting(true);
    try {
      const files: Record<string, string> = Object.create(null);
      let total = 0;
      for (const file of Array.from(list)) {
        const relative = file.webkitRelativePath.split("/").slice(1).join("/");
        if (
          !relative ||
          relative.endsWith(".localapp") ||
          relative.endsWith(".tsbuildinfo") ||
          relative
            .split("/")
            .some(
              (part) =>
                [
                  "node_modules",
                  ".git",
                  "dist",
                  ".next",
                  ".cache",
                  ".npm",
                  ".localapp",
                  "coverage",
                ].includes(part) ||
                part === ".env" ||
                part.startsWith(".env.") ||
                part === ".npmrc" ||
                part.endsWith(".key") ||
                part.endsWith(".pem"),
            )
        )
          continue;
        total += file.size;
        if (file.size > 2 * 1024 * 1024 || total > 32 * 1024 * 1024)
          throw new Error("源码超过大小限制（单文件 2MB、总计 32MB）");
        const bytes = await file.arrayBuffer();
        try {
          files[relative] = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes,
          );
        } catch {
          throw new Error(`暂不支持导入二进制文件：${relative}`);
        }
        if (files[relative].includes("\0"))
          throw new Error(`暂不支持导入二进制文件：${relative}`);
      }
      await p.importSource(files);
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImporting(false);
      if (sourceInput.current) sourceInput.current.value = "";
    }
  }
  const mini = (
      <section
        className="development-mini dsh-development"
        aria-label={userMode ? "已最小化的应用对话" : "已最小化的开发对话"}
        onMouseEnter={() => setPreviewVisible(true)}
        onMouseLeave={() => setPreviewVisible(false)}
        onFocusCapture={() => setPreviewVisible(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            setPreviewVisible(false);
        }}
      >
        {!working && completion && previewVisible && (
          <div
            className="development-mini-preview"
            role="tooltip"
            id="development-mini-reply"
          >
            <Button variant="unstyled" size="none"
              className="development-mini-dismiss"
              aria-label="关闭消息预览"
              onClick={() => setPreviewVisible(false)}
            >
              <X size={14} />
            </Button>
            <strong>
              {error ? <CircleAlert size={17} /> : <Check size={17} />}
              <span className="dock-title-text">{conversationTitle}</span>
            </strong>
            <div className="development-mini-message">
              <DshMarkdown text={completion} />
            </div>
          </div>
        )}
        <Button variant="unstyled" size="none"
          className="development-mini-restore"
          aria-label={working ? "任务进行中，恢复对话" : userMode ? "恢复应用对话" : "恢复开发对话"}
          aria-describedby={
            !working && completion && previewVisible
              ? "development-mini-reply"
              : undefined
          }
          onClick={() => {
            setMinimized(false);
            setPreviewVisible(false);
          }}
        >
          {working ? (
            <LoaderCircle className="dock-spinner" size={23} />
          ) : (
            <MessageSquare size={23} />
          )}
          {!working && completion && (
            <span className="development-mini-dot" aria-hidden="true" />
          )}
        </Button>
        {working && (
          <span className="sr-only" role="status">
            {p.interaction ? "Agent 等待回复" : userMode ? "应用 AI 正在工作" : "开发任务进行中"}
          </span>
        )}
      </section>
    );
  const composer = (
<div className="development-dock-composer">
        {pageSelection && <div className="dock-page-selection" aria-label="待发送页面标记">
          {pageSelection.image ? <img src={pageSelection.image} alt="选区截图" /> : <ScanLine size={20}/>}
          <span><strong>{pageSelection.image?"页面截图":"页面标记"}</strong><span>{pageSelection.label}</span></span>
          <Button variant="ghost" size="icon" aria-label="移除页面标记" disabled={nativeSubmitting} onClick={()=>{
            if(pageSelection.fileName){nativeAttachments.filter(file=>file.name===pageSelection.fileName).forEach(file=>{void nativeComposer.current?.request("remove",file.id).catch(error=>setNativeCommandError(String(error)));});}
            setPageSelection(null);void clearPage?.().catch(error=>setNativeCommandError(String(error)));
          }}><X size={14}/></Button>
        </div>}
        {!userMode && markPage && <Button variant="unstyled" size="none" aria-label="标记页面问题" title="点击标记元素，拖动截图" disabled={marking||nativeSubmitting||!!pageSelection} onClick={()=>{
          setExpanded(false);setNativeCommandError("");setMarking(true);
          const selectionPort=nativeComposer.current;
          void markPage().then(async value=>{
            if(nativeComposer.current!==selectionPort)throw new Error("会话已切换，请重新标记页面");
            const selected=value as {tag?:string;text?:string;image?:string;bounds?:{width:number;height:number}};
            const label=selected.image ? `${Math.round(selected.bounds?.width??0)} × ${Math.round(selected.bounds?.height??0)}` : `${selected.tag??"元素"} · ${(selected.text??"").replace(/\s+/g," ").slice(0,80)}`;
            if(selected.image){
              if(selected.image.length>8*1024*1024||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(selected.image))throw new Error("截图格式无效，请重新截图");
              const fileName=`页面截图-${crypto.randomUUID()}.png`;
              const file=new File([await (await fetch(selected.image)).blob()],fileName,{type:"image/png"});
              const port=nativeComposer.current;if(!port)throw new Error("会话尚未就绪，请稍后重新截图");
              await port.request("attach",undefined,[file]);
              setPageSelection({label,image:selected.image,fileName});
            }else setPageSelection({label});
          }).catch(error=>setNativeCommandError(error instanceof Error?error.message:String(error))).finally(()=>setMarking(false));
        }}>{marking?<LoaderCircle size={19} className="dock-spinner"/>:<ScanLine size={19}/>}</Button>}

        <Button variant="unstyled" size="none"
          aria-label="上传文件"
          disabled={(!nativeEnabled && running) || nativeSubmitting || p.pending || !p.project || (!nativeEnabled && !p.actions.upload)}
          onClick={() => attachmentInput.current?.click()}
        >
          <Plus size={20} />
        </Button>
        <Textarea
          ref={draft}
          rows={1}
          aria-label={userMode ? "应用对话消息" : "应用修改需求"}
          placeholder={
            running && nativeEnabled ? "补充需求，当前任务完成后继续…" : userMode ? "向应用 AI 提问…" : p.project ? "描述你想修改的功能…" : "与 Agent 一起编辑应用…"
          }
          value={p.prompt}
          disabled={(!nativeEnabled && running) || nativeSubmitting || !p.project}
          onChange={(e) => p.actions.setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (p.prompt.trim() && p.provider && !p.pending && !nativeSubmitting && !marking) {
                void sendDraft();
              }
            }
          }}
        />
        {switchIdentity}
        <Select value={p.provider || undefined} disabled={running || nativeSubmitting || p.pending || !p.providers.length} onValueChange={p.actions.setProvider}>
          <SelectTrigger className="dock-model-trigger" aria-label={userMode ? "对话模型" : "开发模型"}>
            <SelectValue placeholder="先配置模型" />
          </SelectTrigger>
          <SelectContent side="top" align="end" sideOffset={8}>
            {p.providers.map((model) => (
              <SelectItem key={model.id} value={model.id}>{model.name} · {model.model}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!p.providers.length && <a href="/my/models">配置模型</a>}
        {running && (!nativeEnabled || !p.prompt.trim()) ? (
          <Button variant="unstyled" size="none"
            className="dock-send"
            aria-label={userMode ? "停止对话" : "停止开发"}
            onClick={() => {
              if (!nativeEnabled) {p.actions.stop(); return;}
              setNativeCommandError("");
              const port = nativeComposer.current;
              if (!port) {setNativeCommandError("原生会话尚未就绪"); return;}
              void port.request("cancel").catch(error => {
                if (nativeComposer.current === port) setNativeCommandError(error instanceof Error ? error.message : String(error));
              });
            }}
          >
            <Square size={14} fill="currentColor" />
          </Button>
        ) : (
          <Button variant="unstyled" size="none"
            className="dock-send"
            title={running ? "排队发送，当前任务完成后处理" : "发送"}
            aria-label={userMode ? "发送对话消息" : "发送修改需求"}
            disabled={
              !p.project || !p.provider || !p.prompt.trim() || p.pending || nativeSubmitting || marking
            }
            onClick={() => {
              void sendDraft();
            }}
          >
            <ArrowUp size={18} />
          </Button>
        )}
      </div>
  );
  if (userMode && input.userConversationEnabled === false) return (
    <section className="app-development-dock dsh-development is-user-preview" aria-label="应用用户模式">
      <div className="development-dock-composer">
        {switchIdentity}<span className="dock-user-preview-note">正在预览用户界面 · 此应用未启用 AI 对话</span>
      </div>
    </section>
  );
  return (<>
    {minimized && mini}
    <section style={minimized?{display:"none"}:undefined}
      className={`app-development-dock dsh-development ${expanded ? "is-expanded" : ""} ${running ? "is-running" : ""}`}
      aria-label={userMode ? "应用 AI 对话" : "应用开发对话"}
    >
      <header className="development-dock-header">
        <Button variant="unstyled" size="none"
          aria-label={userMode ? "最小化应用对话" : "最小化开发对话"}
          title="最小化"
          onClick={() => {
            setHistoryOpen(false);
            setMinimized(true);
          }}
        >
          <Minus size={16} />
        </Button>
        {running && <LoaderCircle className="dock-spinner" size={15} />}
        <DropdownMenu open={historyOpen} onOpenChange={setHistoryOpen}>
          <DropdownMenuTrigger asChild>
          <Button variant="unstyled" size="none"
            ref={historyTrigger}
            className="dock-title"
            aria-label="切换历史对话"
            aria-haspopup="menu"
            aria-expanded={historyOpen}
            disabled={running || p.pending || (!p.project && !input.onIdentityChange)}
          >
            <span className="dock-title-text">{conversationTitle}</span>
            <ChevronDown size={14} />
          </Button>
          </DropdownMenuTrigger>
            <DropdownMenuContent
              className="dock-history-menu"
              aria-labelledby=""
              side={expanded ? "bottom" : "top"}
              align="start"
              aria-label={userMode ? "应用历史对话" : "开发历史对话"}
            >
              <DropdownMenuRadioGroup value={selectedSession || "new"}>
              <DropdownMenuRadioItem asChild value="new"><Button variant="unstyled" size="none"
                onClick={() => {
                  p.actions.newSession();
                  if(nativeEnabled){setNativeSession(undefined);setNativeNew(value=>value+1);}
                  setPanel("chat");
                  setHistoryOpen(false);
                  historyTrigger.current?.focus();
                }}
              >
                <Plus size={16} />
                <span>新对话</span>
                {!selectedSession && <Check size={15} />}
              </Button></DropdownMenuRadioItem>
              {[...history]
                .sort(
                  (a, b) =>
                    Number(!!b.pinned)-Number(!!a.pinned)||
                    new Date(b.createdAt).getTime() -
                    new Date(a.createdAt).getTime(),
                )
                .map((session) => (
                  <DropdownMenuRadioItem key={session.id} asChild value={session.id}><Button variant="unstyled" size="none"
                    onClick={() => {
                      p.actions.selectSession(session.id);
                      if(nativeEnabled)setNativeSession(session.id);
                      setPanel("chat");
                      setHistoryOpen(false);
                      historyTrigger.current?.focus();
                    }}
                  >
                    <MessageSquare size={16} />
                    <span>
                      {session.title || "未命名对话"}
                    </span>
                    {selectedSession === session.id && <Check size={15} />}
                  </Button></DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {!history.length && <p>暂无历史对话</p>}
            </DropdownMenuContent>
        </DropdownMenu>
        {userMode && <a href={`/my/agent?${new URLSearchParams({ appId: `${p.application?.owner}/${p.application?.name}` })}`}
          title="应用 Agent 设置" aria-label="应用 Agent 设置"><Settings size={17} /></a>}
        {!userMode && p.project && <DevelopmentAgentSettings projectId={p.project.id} />}
        <Button variant="unstyled" size="none"
          aria-label={userMode ? expanded ? "收起应用对话" : "展开应用对话" : expanded ? "收起开发对话" : "展开开发对话"}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </Button>
      </header>
      {<div style={!expanded?{display:"none"}:undefined}>
          {!userMode && p.project ? (
            <nav className="development-dock-tools" aria-label="开发操作">
              <Button variant="unstyled" size="none"
                aria-pressed={panel === "chat"}
                onClick={() => setPanel("chat")}
              >
                对话
              </Button>
              <Button variant="unstyled" size="none"
                onClick={() => {
                  setPanel("changes");
                  p.actions.diff();
                }}
              >
                <GitCompareArrows size={15} />
                改动
              </Button>
              {DevelopmentDelivery && <Button variant="unstyled" size="none" aria-pressed={panel==='delivery'} onClick={()=>{setPanel('delivery');p.actions.diff();}}>验收与版本</Button>}
              <Button variant="unstyled" size="none"
                disabled={p.pending || running || building}
                onClick={() => {
                  setPanel("build");
                  p.actions.build();
                }}
              >
                <Hammer size={15} />
                检查与构建
              </Button>
              <Button variant="unstyled" size="none"
                disabled={!ready || p.pending || running}
                onClick={p.actions.preview}
              >
                <Eye size={15} />
                预览
              </Button>
              <Button variant="unstyled" size="none"
                disabled={!ready || p.build?.purpose === "preview" || p.pending || running}
                onClick={p.actions.publish}
              >
                <Rocket size={15} />
                上线
              </Button>
            </nav>
          ) : null}
          <div
            className="development-dock-transcript"
            ref={transcript}
            role="log"
            aria-label={userMode ? "应用对话记录" : "开发对话记录"}
          >
            {!p.project && !p.pending && (
              <div className="development-source-empty">
                <FolderUp size={25} />
                <strong>接入这个应用的源码</strong>
                <p>
                  安装包只有构建产物。选择原项目目录后，即可在这里对话修改、检查、预览并上线。
                </p>
                <Button variant="unstyled" size="none"
                  disabled={importing}
                  onClick={() => sourceInput.current?.click()}
                >
                  {importing ? "正在导入…" : "选择源码目录"}
                </Button>
                <p>
                  包含 manifest.json、package.json；应用名称需与当前应用相同。
                </p>
              </div>
            )}
            {nativeEnabled && <div style={{height:"100%", minHeight:0, ...(panel!=="chat"?{display:"none"}:{})}}> <NativeConversationFrame
                {...(userMode?{identity:"user" as const,applicationId:input.nativeUserAgent!.appId,agent:input.nativeUserAgent!}:{identity:"developer" as const,projectId:p.project!.id})}
                onRunningSeat={setRunningSeat}
                onAttachments={setNativeAttachments}
                onComposerReady={port=>{nativeComposer.current=port;p.actions.nativeComposerReady?.(port);}}
                providerId={p.provider} sessionId={nativeSession??p.selectedSession} newSession={nativeNew}
                onCatalog={rows=>setNativeHistory(rows.map(row=>({id:row.id,title:row.title,pinned:row.pinned,createdAt:new Date(row.updatedAt).toISOString()})))}
                onSelection={selection=>{
                  if(!userMode&&selection&&(selection.running!==Boolean(nativeSelection?.running)||(selection.running&&selection.sessionId!==nativeSelection?.sessionId)))p.actions.nativeActivity?.(selection.sessionId,selection.running);
                  setNativeSelection(selection);
                  if(selection?.sessionId!==nativeSelection?.sessionId)setNativeAttachments([]);
                  if(selection){
                    setNativeSession(selection.sessionId);
                    if(!selection.running&&(selection.sessionId!==p.selectedSession||nativeSelection?.running))p.actions.selectSession(selection.sessionId);
                  }
                }}
              /></div>}
            {panel === "chat" && !nativeEnabled && (
              <>
                {running && (
                  <p className="dock-run-status">
                    <LoaderCircle className="dock-spinner" size={14} />
                    正在处理…
                  </p>
                )}
                {p.project && !p.messages.length && !running && (
                  <p className="dock-hint">
                    {userMode ? "告诉 AI 你想在应用中完成什么，它会使用应用提供的工具。" : "描述你想修改的功能。修改先保存在源码中，检查和预览后再上线。"}
                  </p>
                )}
              </>
            )}
            {panel === "delivery" && DevelopmentDelivery && <DevelopmentDelivery value={{...p,running}}/> }
            {panel === "changes" && (
              <>
                {p.changes.length ? (
                  <DshDiff changes={p.changes} />
                ) : (
                  <p className="dock-hint">没有改动</p>
                )}
              </>
            )}
            {panel === "build" && (
              <>
                <p className="dock-run-status">
                  {building
                    ? "正在检查与构建…"
                    : ready
                      ? (p.build?.purpose === "preview" ? "预览编译通过，正式上线需完整检查" : "检查与构建通过，页面行为仍需在预览中验证")
                      : p.build?.status === "failed"
                        ? "构建失败，请查看日志"
                        : "尚未构建"}
                  {building && (
                    <Button variant="unstyled" size="none" onClick={p.actions.cancelBuild}>取消构建</Button>
                  )}
                </p>
                {ready && !userMode && <p className="dock-hint">打开预览，复现刚刚的问题；如仍有异常，标记位置后继续对话。编译结果不会代替页面验收。</p>}
                <DshTerminal
                  command="应用检查与构建"
                  output={p.log}
                  running={building}
                />
              </>
            )}
            {(error || importError) && (
              <p className="dock-error" role="alert">
                {error || importError}
                {p.build?.status === "failed" && <Button variant="ghost" size="sm" onClick={() => setPanel("build")}>查看构建日志</Button>}
              </p>
            )}
            {userMode && input.userInteractions}
            {!userMode && p.interaction && (
              <div className="dock-interaction">
                {p.interaction.kind === "approval" ? (
                  <>
                    <p>
                      {p.interaction.toolName}：{p.interaction.reason}
                    </p>
                    <Button variant="unstyled" size="none" onClick={() => p.actions.respond("allowed-once")}>
                      允许本次
                    </Button>
                    <Button variant="unstyled" size="none" onClick={() => p.actions.respond("rejected")}>
                      拒绝
                    </Button>
                  </>
                ) : (
                  <>
                    <p>
                      {p.interaction.questions
                        ?.map((q: any) => q.question)
                        .join("\n")}
                    </p>
                    <Textarea
                      aria-label="回答 Agent"
                      value={p.answer}
                      onChange={(e) => p.actions.setAnswer(e.target.value)}
                    />
                    <Button variant="unstyled" size="none"
                      onClick={() =>
                        p.actions.respond(
                          Object.fromEntries(
                            p.interaction.questions.map((q: any) => [
                              q.id,
                              p.answer,
                            ]),
                          ),
                        )
                      }
                    >
                      提交回答
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>}
      {(p.attachments?.length || nativeAttachments.filter(file=>file.name!==pageSelection?.fileName).length) ? (
        <div className="dock-attachments" aria-label="待发送附件">
          {[...(p.attachments??[]),...nativeAttachments].filter(file=>file.name!==pageSelection?.fileName).map((file) => (
            <span key={file.id}>
              <Paperclip size={14} />
              <span>{file.name}</span>
              <Button variant="unstyled" size="none"
                aria-label={`移除附件 ${file.name}`}
                disabled={running || p.pending}
                onClick={() => {
                  if(!nativeAttachments.some(row=>row.id===file.id)){p.actions.removeAttachment?.(file.id);return;}
                  const port=nativeComposer.current;
                  if(!port){setNativeCommandError("原生会话尚未就绪");return;}
                  void port.request("remove",file.id).catch(error=>{if(nativeComposer.current===port)setNativeCommandError(String(error));});
                }}
              >
                <X size={13} />
              </Button>
            </span>
          ))}
        </div>
      ) : null}
      {!userMode && !p.pending && (!p.project || !p.providers.length) && (
        <div className="dock-error dock-collapsed-error" role="status">
          {!p.project && <p>应用源码尚未接入，暂时无法对话编辑。<Button variant="ghost" size="sm" onClick={() => {setExpanded(true);setPanel("chat");}}>接入源码</Button></p>}
          {!p.providers.length && <p>尚未配置模型供应商。<a className="underline" href="/my/models">配置模型后开始对话</a></p>}
        </div>
      )}
      {!expanded && error && (
        <p className="dock-error dock-collapsed-error" role="alert">
          {error}
          {p.build?.status === "failed" && <Button variant="ghost" size="sm" onClick={() => {setExpanded(true); setPanel("build");}}>查看构建日志</Button>}
        </p>
      )}
      <input
        ref={attachmentInput}
        type="file"
        hidden
        multiple
        aria-label="选择对话附件"
        onChange={(event) => {
          if(!nativeEnabled){
            p.actions.upload?.(event.currentTarget.files);event.currentTarget.value="";return;
          }
          const files=event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
          event.currentTarget.value = "";
          if(!files.length)return;
          const port=nativeComposer.current;
          if(!port){setNativeCommandError("原生会话尚未就绪");return;}
          setNativeCommandError("");setNativeSubmitting(true);
          void port.request("attach",undefined,files).catch(error=>{
            if(nativeComposer.current===port)setNativeCommandError(error instanceof Error ? error.message : String(error));
          }).finally(()=>setNativeSubmitting(false));
        }}
      />
      {running && expanded && panel === "chat" && runningSeat && renderPortal ? renderPortal(composer,runningSeat) : composer}
      <input
        ref={sourceInput}
        type="file"
        hidden
        multiple
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(e) => void importDirectory(e.target.files)}
        aria-label="导入应用源码目录"
      />
    </section></>
  );
}

}

/** Compatibility for existing application development adapters. */
export const createAppDevelopmentDock = createConversationDock;
