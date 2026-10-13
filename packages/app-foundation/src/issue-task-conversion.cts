export interface ConvertibleIssueTask {
  index: number;
  checked: boolean;
  title: string;
  convertible: boolean;
  contentStart: number;
  contentEnd: number;
}

const TASK_LINE = /^(\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s*)(.*?)([ \t]*)$/;
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
const PURE_ISSUE_REFERENCE = /^#\d+$/;

function issueTaskTitle(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]+/g, "")
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function collectConvertibleIssueTasks(markdown: string): ConvertibleIssueTask[] {
  const tasks: ConvertibleIssueTask[] = [];
  let offset = 0;
  let fence: { marker: string; length: number } | null = null;

  for (const lineWithEnding of markdown.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []) {
    if (!lineWithEnding) continue;
    const line = lineWithEnding.replace(/(?:\r\n|\n|\r)$/, "");
    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch) {
      const sequence = fenceMatch[1];
      const marker = sequence[0];
      if (!fence) fence = { marker, length: sequence.length };
      else if (fence.marker === marker && sequence.length >= fence.length) fence = null;
      offset += lineWithEnding.length;
      continue;
    }
    if (!fence) {
      const match = TASK_LINE.exec(line);
      if (match) {
        const rawContent = match[3];
        const title = issueTaskTitle(rawContent);
        const checked = match[2].toLowerCase() === "x";
        tasks.push({
          index: tasks.length,
          checked,
          title,
          convertible: !checked && Boolean(title) && !PURE_ISSUE_REFERENCE.test(title),
          contentStart: offset + match[1].length,
          contentEnd: offset + match[1].length + rawContent.length,
        });
      }
    }
    offset += lineWithEnding.length;
  }
  return tasks;
}

export function replaceIssueTaskContent(markdown: string, taskIndex: number, content: string): string {
  const task = collectConvertibleIssueTasks(markdown)[taskIndex];
  if (!task) throw new Error("issue_task_not_found");
  if (!task.convertible) throw new Error("issue_task_not_convertible");
  return `${markdown.slice(0, task.contentStart)}${content}${markdown.slice(task.contentEnd)}`;
}
