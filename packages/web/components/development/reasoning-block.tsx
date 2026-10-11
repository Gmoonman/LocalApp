"use client";
import { useState } from "react";
import { DisclosureRow, TextShimmer } from "@deepseek-ai/dsh-client-ui-primitives";
import { Brain } from "lucide-react";
import { DshMarkdown } from "./dsh-view";
import css from "./upstream/ReasoningRow.module.css";

/** DSH ReasoningRow presentation; LocalApp owns only the disclosure state. */
export function ReasoningBlock({ text, running = false }: { text: string; running?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const summary = (running
    ? text.split(/\r?\n(?:[\t ]*\r?\n)+/).filter(paragraph => paragraph.includes("\n")).at(-1)?.split("\n")[0] ?? ""
    : text.split("\n")[0]).replaceAll("**", "");
  return (
    <div className={`${css.root} dsh-process-row`} data-variant="think" data-state={running ? "running" : "ok"} data-expanded={expanded || undefined} data-preview={!!summary || undefined}>
      <DisclosureRow rowClassName={css.row} leadingClassName={css.leading} titleClassName={css.title}
        icon={<Brain size={14} />} title="思考" running={running} open={expanded} expandable expandOnRowClick
        onToggle={() => setExpanded(value => !value)}
        collapsedContent={<><span className={css.separator} aria-hidden /><span className={css.summary} data-streaming={running || undefined}><span className={css.summaryText}><TextShimmer>{summary}</TextShimmer></span></span></>}>
        {expanded && <div className={css.thinkBody}><DshMarkdown text={text} streaming={running} compact /></div>}
      </DisclosureRow>
    </div>
  );
}
