import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { DeepSeekHarness } from "../../src/lib/deepseek-harness.mjs";

it.runIf(process.env.LOCALAPP_UPGRADE_VERIFY === "1")("reads sessions written by the dsh libraries shipped in LocalApp 0.4.0", async () => {
  const directory = path.resolve(__dirname, "../../../../tmp/dsh-upgrade-0.4.0");
  const root = await fs.mkdtemp(path.join(directory, "session-format-"));
  let harness: DeepSeekHarness | undefined;
  try {
    await fs.mkdir(path.join(root, "workspace"), { recursive: true });
    const legacy = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      import { Context } from "@deepseek-ai/cordis";
      import Sessions from "@deepseek-ai/dsh-session";
      import { createUserMessage, createAssistantMessage, createToolResultMessage, createSystemMessage } from "@deepseek-ai/dsh-llm";
      import Projection from "@deepseek-ai/dsh-session-projection";
      import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
      const root = process.argv[1];
      const ctx = new Context();
      try {
        await ctx.plugin(Sessions);
        await ctx.plugin(Projection);
        await ctx.plugin(Persistence, { root: root + "/sessions", compression: "none" });
        const session = ctx.sessions.create("old-format-session", { meta: { cwd: root + "/workspace" } });
        const events = [session.append("turn/start", { turn: 1 })];
        events.push(session.append("step/start", { turn: 1, step: 1 }));
        events.push(session.append("system/message", { turn: 1, step: 1, message: createSystemMessage("Old application prompt") }, { surfaceOp: "append" }));
        events.push(session.append("user/message", createUserMessage({ content: [{ type: "text", text: "Old format private message" }], source: { kind: "user" } }), { surfaceOp: "append" }));
        const call = { type: "tool-call", id: "old-tool-call", name: "read", arguments: '{"filepath":"old.txt"}' };
        events.push(session.append("assistant/message", { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: "reasoning", text: "Old reasoning before read" }, call], source: { provider: "localapp", model: "old-model" } }), stream: [] }, { surfaceOp: "append" }));
        const tool = session.append("tool/call", { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments });
        events.push(tool);
        events.push(session.append("tool/result", { turn: 1, step: 1, message: createToolResultMessage({ callId: call.id, content: [{ type: "text", text: "Old file contents" }], isError: false }) }, { surfaceOp: "append", sourceEventSeqs: [tool.seq] }));
        events.push(session.append("step/end", { turn: 1, step: 1 }));
        events.push(session.append("step/start", { turn: 1, step: 2 }));
        events.push(session.append("assistant/message", { turn: 1, step: 2, message: createAssistantMessage({ content: [{ type: "text", text: "Old final reply" }], source: { provider: "localapp", model: "old-model" } }), stream: [] }, { surfaceOp: "append" }));
        events.push(session.append("step/end", { turn: 1, step: 2 }));
        events.push(session.append("turn/end", { turn: 1, reason: { kind: "completed" } }));
        const handle = await ctx.sessionPersistence.create(session.header);
        await handle.append(events);
        await handle.flush();
        await handle.close();
        const restored = await ctx.sessionPersistence.open(session.id, "read");
        try { console.log(JSON.stringify(await restored.read())); } finally { await restored.close(); }
      } finally { await ctx.fiber.dispose(); }
    `, root], { cwd: path.join(directory, "package/runtime/server"), env: { ...process.env, NODE_PATH: "" }, timeout: 10000 });
    const oldEvents = JSON.parse(legacy.stdout.trim()).events;
    expect(oldEvents).toHaveLength(12);
    harness = new DeepSeekHarness({ ownerId: "old-owner", root, llmApiKey: "unused", llmBaseUrl: "http://127.0.0.1:1", llmModel: "unused", capabilities: [] });
    expect(await harness.listSessions()).toEqual([expect.objectContaining({ id: "old-format-session", title: "Old format private message" })]);
    const history = JSON.stringify(await harness.history("old-format-session"));
    for (const value of ["Old format private message", "Old reasoning before read", "old-tool-call", "Old file contents", "Old final reply"]) expect(history).toContain(value);
    const native = await harness.nativeApi();
    const catalog = await native.gateway.invoke({ namespace: "session", method: "list", args: { _request: {} } });
    expect(JSON.stringify(catalog)).toContain("old-format-session");
    const page = await native.gateway.invoke({ namespace: "session", method: "page", args: { request: { address: { kind: "session", sessionId: "old-format-session" }, throughSeq: oldEvents.at(-1).seq } } });
    for (const value of ["Old format private message", "Old reasoning before read", "old-tool-call", "Old file contents", "Old final reply"]) expect(JSON.stringify(page)).toContain(value);
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response('data: {"choices":[{"delta":{"content":"New reply after upgrade"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }));
    await harness.run("old-owner", { sessionId: "old-format-session", prompt: "Continue after upgrade", systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
    expect(JSON.stringify(requests[0].messages)).toContain("Old file contents");
    expect(JSON.stringify(requests[0].messages)).toContain("Old final reply");
    expect(JSON.stringify(await harness.history("old-format-session"))).toContain("New reply after upgrade");
    await harness.close();
    harness = new DeepSeekHarness({ ownerId: "old-owner", root, llmApiKey: "unused", llmBaseUrl: "http://127.0.0.1:1", llmModel: "unused", capabilities: [] });
    const reopened = JSON.stringify(await harness.history("old-format-session"));
    expect(reopened).toContain("Old file contents");
    expect(reopened).toContain("New reply after upgrade");
    await harness.close(); harness = undefined;
    const rollback = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      import { Context } from "@deepseek-ai/cordis";
      import Sessions from "@deepseek-ai/dsh-session";
      import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
      const ctx = new Context();
      try {
        await ctx.plugin(Sessions);
        await ctx.plugin(Persistence, { root: process.argv[1] + "/sessions", compression: "none" });
        const handle = await ctx.sessionPersistence.open("old-format-session", "read");
        try { console.log(JSON.stringify(await handle.read())); } finally { await handle.close(); }
      } finally { await ctx.fiber.dispose(); }
    `, root], { cwd: path.join(directory, "package/runtime/server"), env: { ...process.env, NODE_PATH: "" }, timeout: 10000 });
    const rollbackHistory = JSON.parse(rollback.stdout.trim());
    expect(rollbackHistory.events.length).toBeGreaterThan(oldEvents.length);
    for (const value of ["Old format private message", "Old reasoning before read", "old-tool-call", "Old file contents", "Old final reply", "Continue after upgrade", "New reply after upgrade"]) expect(JSON.stringify(rollbackHistory)).toContain(value);
  } finally { vi.unstubAllGlobals(); await harness?.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 20000);
