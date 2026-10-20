import type { Context } from "@deepseek-ai/cordis";
import { CONTEXT_WINDOW_EXCEEDED_CODE, type ContentBlock, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";

/** A text estimate, not a model tokenizer; Latin-only pricing undercounts CJK. */
export function estimateContextText(text: string): number {
  let latin = 0, unicode = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) latin++;
    else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) unicode++;
    else unicode += Buffer.byteLength(char, "utf8");
  }
  return Math.ceil(latin / 4) + unicode;
}

function blockText(block: ContentBlock): string {
  if (block.type === "text" || block.type === "reasoning") return block.text;
  return JSON.stringify(block);
}

/** Includes the current admitted input, system prompt and tool definitions. */
export function estimateContextRequest(options: GenerateOptions): number {
  let total = options.system ? estimateContextText(options.system) + 8 : 0;
  for (const message of options.messages) {
    total += 8 + message.content.reduce((sum, block) => sum + estimateContextText(blockText(block)) + 4, 0);
  }
  if (options.tools?.length) total += estimateContextText(JSON.stringify(options.tools)) + 8;
  return total;
}

/** A terminal overflow lets dsh compact and retry durable history before provider I/O. */
export function mountContextBudget(ctx: Context, fallbackOutputTokens = 32768) {
  const catalogOutputs = new Map<string, Promise<number>>();
  async function defaultOutput(provider: string, model: string, signal?: AbortSignal) {
    const directory = ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider);
    if (!directory) return 0;
    // Declared routes have no local catalog; never probe their endpoint here.
    // 32768 is the fallback of the pinned pi-ai adapter, not a context capacity.
    if (directory.declared) return fallbackOutputTokens;
    const key = JSON.stringify([provider, model]);
    let result = catalogOutputs.get(key);
    if (!result) {
      result = ctx.llm.discoverModels(directory.settingsNs, { provider }, signal)
        .then(models => models.find(entry => entry.id === model)?.maxTokens ?? fallbackOutputTokens);
      catalogOutputs.set(key, result);
      result.catch(() => catalogOutputs.delete(key));
    }
    return result;
  }

  ctx.on("llm/stream", async function* (options, next): AsyncIterable<StreamChunk> {
    const info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
    const window = info.context?.contextWindow;
    if (window !== undefined) {
      const input = estimateContextRequest(options);
      const output = options.maxTokens ?? info.defaultMaxTokens ?? await defaultOutput(options.provider, options.model, options.signal);
      if (input + output > window) {
        yield { type: "finish", reason: { kind: "error", failure: {
          code: CONTEXT_WINDOW_EXCEEDED_CODE,
          message: `模型 ${options.model} 的上下文上限为 ${window} tokens；本次输入、系统提示和工具约 ${input} tokens，另预留输出 ${output} tokens。请压缩历史，或拆分本次输入后重试。`,
        } } };
        return;
      }
    }
    yield* next();
  });
}
