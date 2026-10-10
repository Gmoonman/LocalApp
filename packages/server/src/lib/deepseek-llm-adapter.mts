import { LlmAdapter, ToolCallId, attributionHeaders, type GenerateOptions, type StreamChunk, type RequestMessage, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ServerConfig } from "./config.js";

export function toWireMessages(messages: RequestMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: JSON.stringify(message.content) };
    }
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const reasoning = message.content.filter((b) => b.type === "reasoning").map((b) => b.text).join("");
    const calls = message.content.filter((b) => b.type === "tool-call").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: b.arguments } }));
    return { role: message.role, content: text, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) };
  });
}

/** Uses the existing Server model configuration; the harness owns the loop. */
export class LocalAppLlmAdapter extends LlmAdapter {
  constructor(private readonly config: Pick<ServerConfig, "llmApiKey" | "llmBaseUrl"> & Partial<Pick<ServerConfig, "llmModel">>, private readonly emit: (sessionId: string | undefined, event: unknown) => void) { super(); }

  override async listModels(provider: string) {
    return provider === "localapp" && this.config.llmModel ? [{ provider, id: this.config.llmModel, name: this.config.llmModel }] : [];
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const res = await fetch(`${this.config.llmBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: options.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.llmApiKey}`, ...attributionHeaders() },
      body: JSON.stringify({ model: options.model, messages: [...(options.system ? [{ role: "system", content: options.system }] : []), ...toWireMessages(options.messages)], stream: true,
        ...(options.tools?.length ? { tools: options.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      }),
    });
    if (!res.ok) throw new Error(`LLM request failed (${res.status})`);
    if (!res.body) throw new Error("LLM response body is empty");
    if (options.purpose !== "session-title") this.emit(options.sessionId, { type: "assistant_start" });
    const blocks = new Map<number, { index: number; block: ContentBlock }>();
    let nextIndex = 0;
    let finish = "stop";
    let terminated = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const process = function* (data: string): Generator<StreamChunk> {
      if (data === "[DONE]") { terminated = true; return; }
      const value = JSON.parse(data);
      if (value.error) throw new Error(value.error.message || "LLM stream failed");
      const choice = value.choices?.[0];
      if (choice?.finish_reason) { finish = choice.finish_reason; terminated = true; }
      const delta = choice?.delta;
      if (!delta) return;
      for (const [key, kind, slot] of [["content", "text", -1], ["reasoning_content", "reasoning", -2]] as const) {
        if (typeof delta[key] !== "string" || !delta[key]) continue;
        let entry = blocks.get(slot);
        if (!entry) {
          entry = { index: nextIndex++, block: { type: kind, text: "" } };
          blocks.set(slot, entry);
          yield { type: "block-start", index: entry.index, blockType: kind };
        }
        if (entry.block.type !== "text" && entry.block.type !== "reasoning") continue;
        entry.block.text += delta[key];
        yield { type: kind === "text" ? "text-delta" : "reasoning-delta", index: entry.index, text: delta[key] };
      }
      for (const call of delta.tool_calls ?? []) {
        if (!Number.isInteger(call.index) || call.index < 0) throw new Error("Invalid tool call index");
        let entry = blocks.get(call.index);
        if (!entry) {
          if (!call.id) throw new Error("Missing tool call id");
          entry = { index: nextIndex++, block: { type: "tool-call", id: ToolCallId(call.id), name: "", arguments: "" } };
          blocks.set(call.index, entry);
          yield { type: "block-start", index: entry.index, blockType: "tool-call" };
        }
        if (entry.block.type !== "tool-call") throw new Error("Invalid tool call block");
        entry.block.name += call.function?.name ?? "";
        entry.block.arguments += call.function?.arguments ?? "";
        yield { type: "tool-call-delta", index: entry.index, id: entry.block.id, name: entry.block.name, argumentsDelta: call.function?.arguments ?? "" };
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        if (done && buffer) { lines.push(buffer); buffer = ""; }
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          for (const chunk of process(data)) {
            if (chunk.type === "text-delta" && options.purpose !== "session-title") this.emit(options.sessionId, { type: "text_delta", text: chunk.text });
            yield chunk;
          }
        }
        if (done) break;
      }
      if (!terminated) throw new Error("LLM stream ended before completion");
      for (const entry of blocks.values()) yield { type: "block-end", index: entry.index, block: entry.block };
      yield { type: "finish", reason: { kind: finish === "tool_calls" ? "tool-calls" : finish === "length" ? "max-tokens" : "stop" } };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
