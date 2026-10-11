interface MarkdownNode {
  type?: string;
  value?: unknown;
  children?: MarkdownNode[];
}

const SKIPPED_NODE_TYPES = new Set(["code", "inlineCode", "link", "linkReference", "image", "imageReference", "definition"]);
const MENTION_PATTERN = /(?:^|[^A-Za-z0-9_.+@/-])@([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?![A-Za-z0-9_.-])/g;

export async function parseIssueMentions(markdown: string): Promise<string[]> {
  if (!markdown.includes("@")) return [];
  const [{ unified }, { default: remarkParse }] = await Promise.all([import("unified"), import("remark-parse")]);
  const root = unified().use(remarkParse).parse(markdown) as MarkdownNode;
  const mentions: string[] = [];
  const seen = new Set<string>();
  const visit = (node: MarkdownNode, skipped: boolean) => {
    const nextSkipped = skipped || SKIPPED_NODE_TYPES.has(node.type ?? "");
    if (!nextSkipped && node.type === "text" && typeof node.value === "string") {
      for (const match of node.value.matchAll(MENTION_PATTERN)) {
        const userId = match[1];
        if (!seen.has(userId)) { seen.add(userId); mentions.push(userId); }
      }
    }
    for (const child of node.children ?? []) visit(child, nextSkipped);
  };
  visit(root, false);
  return mentions;
}
