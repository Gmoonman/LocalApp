"use client";
import {
  MarkdownText,
  TerminalBlock,
  DiffBlock,
} from "@deepseek-ai/dsh-client-ui-primitives";
import "./dsh-theme.css";
const toolbar = {
  codeLabel: "代码",
  wrapLabel: "自动换行",
  unwrapLabel: "保留列宽",
};
const folding = {
  ...toolbar,
  copy: "复制",
  copied: "已复制",
  collapseAria: "收起",
  collapse: "收起",
  expandAria: (n: number) => `展开 ${n} 行`,
  expand: (n: number) => `展开 ${n} 行`,
};
export const DshMarkdown = ({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) => (
  <MarkdownText
    text={text}
    streaming={streaming}
    labels={{
      code: {
        copyLabel: "复制",
        copiedLabel: "已复制",
        toolbarLabels: toolbar,
      },
      footnotes: "脚注",
    }}
  />
);
export const DshDiff = ({
  changes,
}: {
  changes: Array<{ path: string; before: string | null; after: string | null }>;
}) => (
  <DiffBlock
    diffs={changes.map((c) => ({
      path: c.path,
      oldText: c.before,
      newText: c.after ?? "",
    }))}
    labels={folding}
    maxLines={60}
  />
);
export const DshTerminal = ({
  command,
  output,
  running = false,
}: {
  command: string;
  output: string;
  running?: boolean;
}) => (
  <TerminalBlock
    command={command}
    output={output}
    running={running}
    labels={{
      ...folding,
      commandLine: (line) => `命令第 ${line} 行`,
      signal: (s) => `信号 ${s}`,
      exitCode: (n) => `退出码 ${n}`,
      noExitCode: "已结束",
      running: "运行中",
      failed: "失败",
      done: "已完成",
      noOutput: "暂无输出",
    }}
  />
);
