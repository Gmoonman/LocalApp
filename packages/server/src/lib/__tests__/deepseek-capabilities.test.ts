import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, afterEach } from "vitest";
const root = path.resolve(__dirname, "../../../../../tmp/dsh-capabilities-test", String(process.pid));
it("mounts the application capability set and persists a real Harness conversation", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const harness = new DeepSeekHarness({ llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "model", root, ownerId: "capability-owner", capabilities: ["files", "terminal", "skills", "subagents", "jobs", "web", "workflow", "schedule"] });
  try {
    await harness.initialize();
    const ctx = (harness as any).ctx;
    const names = ctx.tools.schemas().map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read", "write", "glob", "grep", "bash", "subagent", "workflow", "schedule_create"]));
    expect(ctx.get("skills")).toBeDefined();
    expect(ctx.get("jobs")).toBeDefined();
    expect(ctx.get("schedule")).toBeDefined();
    await expect(ctx.fs.resolve(path.dirname(root))).rejects.toThrow("outside");
    const { gateway } = await harness.nativeApi();
    const created = await gateway.invoke({ namespace: "session", method: "create", args: { request: {} } }) as { sessionId: string };
    await fs.writeFile(path.join(root, "workspace", "native-reference.txt"), "application file");
    const outside = path.join(root, "outside-reference");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "private-reference.txt"), "outside");
    await fs.symlink(outside, path.join(root, "workspace", "external-link"), "dir");
    const references = (query: string) => gateway.invoke({ namespace: "fileReferences", method: "list", args: { agentId: created.sessionId, query } });
    expect(await references("native-reference")).toEqual([expect.objectContaining({ path: "native-reference.txt", kind: "file" })]);
    expect(await references("../")).toEqual([]);
    expect(await references("external-link/")).toEqual([]);
    expect(await references("private-reference")).toEqual([]);
    expect(await gateway.invoke({ namespace: "goals", method: "get", args: { agentId: created.sessionId } })).toBeUndefined();
    expect(await gateway.invoke({ namespace: "schedule", method: "catalog", args: {} })).toEqual([]);
    const jobs = await gateway.stream({ namespace: "job", method: "list", args: { request: { sessionId: created.sessionId } } });
    const iterator = jobs[Symbol.asyncIterator]();
    try { expect((await iterator.next()).value).toEqual({ type: "rows", jobs: [] }); }
    finally { await iterator.return?.(); }
    await expect(gateway.invoke({ namespace: "job", method: "kill", args: { request: { sessionId: created.sessionId, jobId: "missing-job" } } })).rejects.toThrow();
    let cancelled = false;
    let finish!: (result: { status: string; detail: string }) => void;
    const done = new Promise(resolve => { finish = resolve; });
    const jobId = ctx.jobs.start({ kind: "bash", label: "Native job output", owner: created.sessionId, run: (job: any) => {
      job.append("native background output");
      return { done, cancel: () => { cancelled = true; finish({ status: "cancelled", detail: "cancelled by the user" }); } };
    } });
    const other = await gateway.invoke({ namespace: "session", method: "create", args: { request: {} } }) as { sessionId: string };
    await expect(gateway.invoke({ namespace: "job", method: "kill", args: { request: { sessionId: other.sessionId, jobId } } })).rejects.toThrow();
    expect(cancelled).toBe(false);
    expect(await gateway.invoke({ namespace: "job", method: "kill", args: { request: { sessionId: created.sessionId, jobId } } })).toEqual({ outcome: "requested" });
    expect(cancelled).toBe(true);
    const frames: any[] = [];
    for await (const frame of await gateway.stream({ namespace: "job", method: "follow", args: { request: { sessionId: created.sessionId, jobId } } })) frames.push(frame);
    expect(JSON.stringify(frames)).toContain("native background output");
    expect(frames.at(-1)).toMatchObject({ type: "status" });


  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);

it("uses native goal lifecycle with session isolation and rejects stale changes", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const harness = new DeepSeekHarness({ llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "model", root, ownerId: "goal-owner", capabilities: [] });
  try {
    const { gateway } = await harness.nativeApi();
    const createSession = async () => await gateway.invoke({ namespace: "session", method: "create", args: { request: {} } }) as { sessionId: string };
    const first = await createSession();
    const second = await createSession();
    const invoke = (method: string, args: Record<string, unknown> = {}) => gateway.invoke({ namespace: "goals", method, args: { agentId: first.sessionId, ...args } });
    const created = await invoke("create", { request: { objective: "Native application goal", maxGoalRounds: 3 } }) as { ref: { id: string; revision: number } };
    expect(await invoke("get")).toMatchObject({ objective: "Native application goal", phase: "active", activation: "armed", maxGoalRounds: 3 });
    expect(await gateway.invoke({ namespace: "goals", method: "get", args: { agentId: second.sessionId } })).toBeUndefined();
    const paused = await invoke("pause", { ref: created.ref }) as { id: string; revision: number };
    expect(paused).toMatchObject({ phase: "paused", activation: "disarmed" });
    await expect(invoke("resume", { ref: created.ref })).rejects.toThrow();
    const resumed = await invoke("resume", { ref: { id: paused.id, revision: paused.revision } }) as { id: string; revision: number };
    expect(resumed).toMatchObject({ phase: "active", activation: "armed" });
    const completed = await invoke("complete", { ref: { id: resumed.id, revision: resumed.revision } }) as { id: string; revision: number };
    expect(completed).toMatchObject({ phase: "complete", activation: "disarmed" });
    await invoke("clear", { ref: { id: completed.id, revision: completed.revision } });
    expect(await invoke("get")).toBeUndefined();
    await expect(gateway.invoke({ namespace: "goals", method: "get", args: { agentId: "foreign-session" } })).rejects.toThrow();
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);

it("restores native session titles and paused goals after the full Harness closes", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const options = { llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "model", root, ownerId: "restart-owner", capabilities: [] };
  let harness = new DeepSeekHarness(options);
  try {
    let { gateway } = await harness.nativeApi();
    const created = await gateway.invoke({ namespace: "session", method: "create", args: { request: { sessionId: "native-restart-session" } } }) as { sessionId: string };
    await gateway.invoke({ namespace: "session", method: "rename", args: { request: { sessionId: created.sessionId, title: "Persisted native session" } } });
    const goal = await gateway.invoke({ namespace: "goals", method: "create", args: { agentId: created.sessionId, request: { objective: "Persistent native goal", maxGoalRounds: 5 } } }) as { ref: { id: string; revision: number } };
    const paused = await gateway.invoke({ namespace: "goals", method: "pause", args: { agentId: created.sessionId, ref: goal.ref } }) as { id: string; revision: number };
    await harness.close();
    harness = new DeepSeekHarness(options);
    ({ gateway } = await harness.nativeApi());
    expect(await harness.listSessions()).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.sessionId, title: "Persisted native session" })]));
    await gateway.invoke({ namespace: "session", method: "create", args: { request: { sessionId: created.sessionId } } });
    expect(await gateway.invoke({ namespace: "goals", method: "get", args: { agentId: created.sessionId } })).toMatchObject({ id: paused.id, revision: paused.revision, objective: "Persistent native goal", phase: "paused", activation: "disarmed" });
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);

afterEach(() => vi.unstubAllGlobals());
it("writes application files through the real loop and restores conversation history after restart", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const calls: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    const tool = request.messages.at(-1)?.role !== "tool";
    const delta = tool ? { tool_calls: [{ index: 0, id: `file-${calls.length}`, function: { name: "write", arguments: JSON.stringify({ file_path: "test.txt", content: "application data" }) } }] } : { content: "saved" };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const options = { llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "test", root, capabilities: ["files"] as const };
  let harness = new DeepSeekHarness({ ...options, capabilities: [...options.capabilities] });
  try {
    await harness.run("user", { sessionId: "persisted", prompt: "write file", systemPrompt: "application prompt", tools: [] }, () => {}, new AbortController().signal);
    expect(await fs.readFile(path.join(root, "workspace/test.txt"), "utf8")).toBe("application data");
    await harness.close();
    harness = new DeepSeekHarness({ ...options, capabilities: [...options.capabilities] });
    const history = await harness.history("persisted");
    expect(history.filter((m) => m.role === "user")).toHaveLength(1);
    await harness.run("user", { sessionId: "persisted", prompt: "again", systemPrompt: "application prompt", tools: [] }, () => {}, new AbortController().signal);
    expect(calls.at(-1).messages.filter((m: any) => m.role === "user" && ["write file", "again"].includes(m.content))).toHaveLength(2);
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
it("runs a confined terminal command and prevents reads of another application's files", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const secret = path.join(root, "outside-secret.txt");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(secret, "outside-application-secret");
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const call = request.messages.at(-1)?.role !== "tool";
    const quoted = "'" + secret.replaceAll("'", "'\\''") + "'";
    const delta = call ? { tool_calls: [{ index: 0, id: "shell-call", function: { name: "bash", arguments: JSON.stringify({ description: "Verify application isolation", command: `printf terminal-ok > terminal.txt; cat terminal.txt; cat ${quoted}; if cat /proc/${process.pid}/environ >/dev/null 2>&1; then printf server-env-readable; else printf server-env-denied; fi` }) } }] } : { content: "finished" };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const harness = new DeepSeekHarness({ llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "test", root, capabilities: ["terminal"] });
  try {
    await harness.run("user", { sessionId: "terminal", prompt: "execute", systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
    expect(requests.at(-1).messages.at(-1).content).not.toContain("outside-application-secret");
    expect(requests.at(-1).messages.at(-1).content).toContain("terminal-ok");
    expect(requests.at(-1).messages.at(-1).content).toContain("server-env-denied");
    expect(await fs.readFile(path.join(root, "workspace/terminal.txt"), "utf8").catch(() => undefined), requests.at(-1).messages.at(-1).content).toBe("terminal-ok");
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
it("delegates to a real child Agent that uses the registered application tool", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const child = request.messages.some((m: any) => m.role === "user" && m.content?.includes("child task"));
    const name = child ? "pageAction" : "subagent";
    const call = !request.messages.some((message: any) => message.role === "assistant" && message.tool_calls?.some((tool: any) => tool.function?.name === name));
    const args = child ? {} : { description: "Do child task", prompt: "child task", run_in_background: false };
    const delta = call ? { tool_calls: [{ index: 0, id: `delegate-${requests.length}`, function: { name, arguments: JSON.stringify(args) } }] } : { content: "finished" };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const harness = new DeepSeekHarness({ llmApiKey: "user-key", llmBaseUrl: "http://model.test/v1", llmModel: "user-model", root, capabilities: ["subagents"] });
  let actions = 0;
  try {
    await harness.run("user", { sessionId: "delegate", prompt: "delegate", systemPrompt: "App prompt", tools: [{ name: "pageAction", description: "Application action", parameters: { type: "object", properties: {} } }] }, (event: any) => {
      if (event.type === "tool_call") { actions++; harness.result("user", event.token, { appSaved: true }); }
    }, new AbortController().signal);
    await expect.poll(() => actions).toBe(1);
    expect(requests.every((request) => request.model === "user-model")).toBe(true);
    expect(requests.some((request) => request.messages.some((m: any) => m.role === "tool" && m.content.includes("appSaved")))).toBe(true);
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);

it("searches application files with a confined ripgrep process", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  await fs.mkdir(path.join(root, "workspace"), { recursive: true });
  await fs.writeFile(path.join(root, "workspace/search.txt"), "search-content\n");
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const call = request.messages.at(-1)?.role !== "tool";
    const delta = call ? { tool_calls: [{ index: 0, id: "search", function: { name: "grep", arguments: JSON.stringify({ pattern: "search-content" }) } }] } : { content: "done" };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const harness = new DeepSeekHarness({ llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "test", root, capabilities: ["files"] });
  try {
    await harness.run("user", { sessionId: "search-session", prompt: "search", systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
    expect(requests.at(-1).messages.at(-1).content).toContain("search.txt");
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
it.each([
  { name: "workflow", capabilities: ["workflow"], args: { script: "return { answer: 42 };", meta: { name: "test-workflow", description: "Verify isolated workflow" } }, expected: "42" },
  { name: "workflow", capabilities: ["workflow"], development: true, args: { script: "return { answer: 43 };", meta: { name: "development-workflow", description: "Verify project workflow" } }, expected: "43" },
  { name: "skill", capabilities: ["skills"], args: { name: "test-skill" }, expected: "skill-instructions-marker" },
  { name: "ask_user_question", capabilities: [], args: { questions: [{ id: "choice", question: "Choose", options: [{ label: "yes" }] }] }, expected: "yes" },
])("executes the real $name tool ($expected)", async ({ name, capabilities, args, expected, ...options }) => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  await fs.mkdir(path.join(root, "workspace/skills/test-skill"), { recursive: true });
  await fs.writeFile(path.join(root, "workspace/skills/test-skill/SKILL.md"), "---\nname: test-skill\ndescription: Test skill\n---\nskill-instructions-marker\n");
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const call = request.messages.at(-1)?.role !== "tool";
    const delta = call ? { tool_calls: [{ index: 0, id: "capability-call", function: { name, arguments: JSON.stringify(args) } }] } : { content: "done" };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const development = "development" in options && options.development;
  const harness = new DeepSeekHarness({ llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "test", root, capabilities: capabilities as any, ...(development ? { workspaceRoot: path.join(root, "workspace"), dataRoot: root, networkBlocked: true } : {}) });
  try {
    await harness.run("user", { sessionId: "capability-session", prompt: "execute capability", systemPrompt: "", tools: [] }, (event: any) => {
      if (event.type === "interaction") harness.result("user", event.token, { answers: [{ id: "choice", selected: ["yes"], custom: "" }] });
    }, new AbortController().signal);
    expect(requests.at(-1).messages.at(-1).content).toContain(expected);
    if (name === "workflow") expect(requests[0].tools.some((tool: any) => tool.function.name === "subagent")).toBe(false);
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
it("delivers a scheduled message through the live Agent after its foreground turn", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const call = requests.length === 1;
    const delta = call ? { tool_calls: [{ index: 0, id: "schedule-call", function: { name: "schedule_create", arguments: JSON.stringify({ title: "Test reminder", prompt: "scheduled-message-marker", after_seconds: 1 }) } }] } : { content: "done" };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const harness = new DeepSeekHarness({ llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "test", root, capabilities: ["schedule"], ownerId: "user" });
  try {
    await harness.run("user", { sessionId: "schedule-session", prompt: "schedule", systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
    await vi.waitFor(() => expect(requests.some((request) => request.messages.some((m: any) => m.role === "user" && m.content?.includes("scheduled-message-marker")))).toBe(true), { timeout: 5000 });
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);

it("runs plan commands locally and prevents application actions while planning", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const call = request.messages.at(-1)?.role !== "tool";
    const delta = call ? { tool_calls: [{ index: 0, id: "plan-action", function: { name: "pageAction", arguments: "{}" } }] } : { content: "done" };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const harness = new DeepSeekHarness({ llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "test", root, capabilities: [] });
  const input = { sessionId: "plan-session", prompt: "/plan", systemPrompt: "", tools: [{ name: "pageAction", description: "Write app data", parameters: { type: "object", properties: {} } }] };
  const events: any[] = [];
  try {
    await harness.run("user", input, (event) => events.push(event), new AbortController().signal);
    expect(requests).toHaveLength(0);
    expect(events.some((event) => event.type === "command_result" && event.result.kind === "success")).toBe(true);
    await harness.run("user", { ...input, prompt: "Plan" }, (event) => events.push(event), new AbortController().signal);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
    expect(requests.at(-1).messages.at(-1).content).toContain("计划模式");
    await harness.run("user", { ...input, prompt: "/plan off" }, () => {}, new AbortController().signal);
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
it("loads only selected public skills and excludes disabled tools from model requests", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }));
  const harness = new DeepSeekHarness({ llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "test", root, capabilities: ["skills", "files"], skills: ["pdf"], disabledTools: ["write"] });
  try {
    await harness.initialize();
    await harness.run("user", { sessionId: "selected-skills", prompt: "list skills", systemPrompt: "", tools: [] }, () => {}, new AbortController().signal);
    expect(requests[0].tools.map((tool: any) => tool.function.name)).toContain("read");
    expect(requests[0].tools.map((tool: any) => tool.function.name)).not.toContain("write");
    expect(JSON.stringify(requests[0].messages)).toContain("pdf");
    expect(await fs.readdir(path.join(root, "workspace/.localapp-public-skills"))).toEqual(["pdf"]);
    const ctx = (harness as any).ctx;
    const agent = (harness as any).conversations.get("selected-skills").handle.agent;
    const result = await agent.ctx.tools.execute({ callId: "disabled-write", signal: new AbortController().signal, name: "write", arguments: { file_path: "blocked.txt", content: "blocked" }, agent });
    expect(result.isError).toBe(true);
    expect(await fs.stat(path.join(root, "workspace/blocked.txt")).catch(() => undefined)).toBeUndefined();
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);

it("checks the real Agent execution environment without calling a model", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const harness = new DeepSeekHarness({ llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "test", root, capabilities: ["files", "terminal", "skills"], skills: ["pdf"] });
  const model = vi.fn(); vi.stubGlobal("fetch", model);
  try {
    await harness.initialize();
    const report = await harness.checkEnvironment();
    expect(report.checks.find(c => c.id === "terminal")?.status).toBe("ready");
    expect(report.checks.some(c => c.id === "runner")).toBe(true);
    expect(report.checks.some(c => c.id === "pdfplumber")).toBe(true);
    expect(model).not.toHaveBeenCalled();
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);

it("shares the configured runtime read-only while keeping other Server data private", async () => {
  const { DeepSeekHarness } = await import("../deepseek-harness.mjs");
  const fsSync = await import("node:fs");
  const dataDir = path.join(root, "python-server-data");
  const directory = path.join(dataDir, "python-environments", "test");
  const executable = path.join(directory, "bin", "python");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  // A real executable under the selected environment tests PATH and OS file rules.
  await fs.symlink(process.execPath, executable);
  await fs.writeFile(path.join(directory, "library.txt"), "shared-library");
  const outside = path.join(dataDir, "other-application.txt");
  await fs.writeFile(outside, "private-other-application");
  const harness = new DeepSeekHarness({ llmApiKey: "test", llmBaseUrl: "http://model.test/v1", llmModel: "test", root: path.join(dataDir, "agent", "demo"), capabilities: ["files", "terminal"], pythonEnvironment: { executable, directory, baseDirectory: path.dirname(path.dirname(fsSync.realpathSync(process.execPath))), version: "test", revision: "test", managed: true } });
  try {
    await harness.initialize();
    const ctx = (harness as any).ctx;
    const code = `const fs=require('fs');const result={library:fs.readFileSync(${JSON.stringify(path.join(directory, "library.txt"))},'utf8'),virtual:process.env.VIRTUAL_ENV};for(const [key,file] of [['write',${JSON.stringify(path.join(directory,"write.txt"))}],['read',${JSON.stringify(outside)}]]){try{key==='write'?fs.writeFileSync(file,'bad'):fs.readFileSync(file);result[key]='allowed'}catch{result[key]='denied'}}console.log(JSON.stringify(result));`;
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const output = await (await ctx.shell.execute(ctx.shell.resolve({ command: `python -e ${quote(code)}`, workdir: path.join(dataDir, "agent/demo/workspace"), timeoutMs: 15_000 }))).result();
    expect(JSON.parse(output.stdout.text)).toEqual({ library: "shared-library", virtual: directory, write: "denied", read: "denied" });
  } finally { await harness.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
