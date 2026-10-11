"use client";
import { useState } from "react";
import { DisclosureRow } from "@deepseek-ai/dsh-client-ui-primitives";
import { Terminal, FileText, Pencil, Search, Globe, Wrench } from "lucide-react";
import { DshRead, DshTerminal } from "./dsh-view";
import css from "./upstream/ToolRow.module.css";

export function ToolCallRow({ call, result, running = false }: { call: any; result?: any; running?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const name = call.name || "工具调用";
  const args = call.arguments ?? {};
  const output = typeof result?.content === "string" ? result.content : (result?.content ?? []).map((block: any) => block.text ?? "").join("\n");
  const state = result ? (result.isError ? "error" : "ok") : running ? "running" : "stopped";
  const Icon = name === "bash" ? Terminal : /read/.test(name) ? FileText : /write|edit/.test(name) ? Pencil : /search|find/.test(name) ? Search : /web|fetch|browse/.test(name) ? Globe : Wrench;
  const summary = result?.isError ? output.split("\n")[0] || "执行失败" : String(args.command ?? args.file_path ?? args.path ?? args.query ?? (result ? "已完成" : running ? "正在执行…" : "未返回结果"));
  return <div className={`${css.root} dsh-process-row`} data-tool={name} data-state={state}>
    <DisclosureRow rowClassName={css.row} leadingClassName={css.leading} titleClassName={css.title}
      icon={<Icon size={14} />} title={name} open={expanded} expandable expandOnRowClick running={state === "running"}
      onToggle={() => setExpanded(value => !value)}
      collapsedContent={<><span className={css.sep} aria-hidden /><span className={`${css.summary} ${state === "error" ? css.errorSummary : ""}`}>{summary}</span></>}>
      <div className={css.bodyWrap}>
        {Object.keys(args).length > 0 && <div className="dsh-tool-section"><p className="dsh-tool-section-title">参数</p><DshRead text={JSON.stringify(args, null, 2)} /></div>}
        {result && <div className="dsh-tool-section"><p className="dsh-tool-section-title">{result.isError ? "错误" : "结果"}</p>{name === "bash" ? <DshTerminal command={String(args.command ?? "")} output={output} /> : <DshRead text={output} path={args.file_path ?? args.path} />}</div>}
      </div>
    </DisclosureRow>
  </div>;
}
